-- ══════════════════════════════════════════════════════════════════════
-- End-of-call idempotency — retry repair fix.
--
-- Problem this migration fixes
-- ----------------------------
-- applyEndOfCall() wrote `calls.status = <terminal>` BEFORE calling the
-- apply_call_end RPC, and the caller short-circuited on "status is
-- terminal". If the RPC then threw (deadlock, connection reset, Postgres
-- restart, etc.), the next Vapi webhook retry would:
--
--   1. fetch the calls row
--   2. see status='completed' (terminal)
--   3. short-circuit — "already applied, nothing to do"
--   4. silently drop the counter bump forever
--
-- Result: quote_request stranded in status='calling' with
-- total_calls_completed never reaching total_businesses_to_call → the
-- Phase 9 report cron never picks it up → customer never gets their
-- report. Same failure mode the Phase 7 stuck-batch fix addressed, but
-- via a different path (the webhook-retry race instead of dispatch
-- exhaustion).
--
-- Fix
-- ---
-- Move the "already applied" sentinel out of calls.status (which the
-- caller writes BEFORE the RPC) and into a new nullable column
-- `calls.counters_applied_at`, stamped ATOMICALLY inside the RPC. The
-- caller's short-circuit gate becomes "counters_applied_at IS NOT NULL"
-- instead of "status is terminal". Replays against a row where the
-- status got written but the RPC never stamped now correctly re-run and
-- repair the counter bump.
--
-- The status UPDATE in the caller is idempotent (same terminal status),
-- the quotes insert is idempotent (UNIQUE(call_id) swallowed on 23505),
-- and the RPC's claim UPDATE is atomic (WHERE counters_applied_at IS NULL)
-- — so the full retry path is safe against concurrent webhooks and
-- partial prior applies.
--
-- RPC signature change
-- --------------------
-- apply_call_end(p_request_id uuid, p_quote_inserted boolean)
--   → apply_call_end(p_request_id uuid, p_call_id uuid, p_quote_inserted boolean)
--
-- Callers updated in the same PR:
--   • lib/calls/apply-end-of-call.ts  (webhook + backfill path)
--   • lib/cron/retry-failed-calls.ts  (retry-exhaustion path)
--
-- Backfill
-- --------
-- For EXISTING terminal-status rows we stamp counters_applied_at so a
-- late Vapi webhook retry doesn't re-bump counters post-migration.
-- Conservative filter — only stamp rows where we have evidence the
-- counter path already ran:
--   • ended_at IS NOT NULL     → the webhook finalizer wrote it
--   • status='failed' AND retry_count >= 3 → retry-exhaustion fired
-- Rows still mid-flight through retry-failed-calls (status='failed',
-- retry_count < 3, started_at IS NULL) correctly stay counters_applied_at=NULL
-- so the exhaustion path can still stamp them on its next tick.
-- ══════════════════════════════════════════════════════════════════════

-- ─── 1. New sentinel column ──────────────────────────────────────────

alter table public.calls
  add column if not exists counters_applied_at timestamptz;

comment on column public.calls.counters_applied_at is
  'Set atomically by apply_call_end() after it bumps quote_request counters. '
  'NULL means counters have not been applied — the webhook/backfill/retry '
  'path will re-run on the next trigger to repair a partial apply. Replaces '
  'the prior short-circuit-on-status behaviour which silently dropped counter '
  'bumps when the RPC failed after the status UPDATE succeeded.';

-- Partial index narrows the retry-repair scan: when apply-end-of-call
-- wants to know "is this row already stamped?", the single-row lookup
-- by id is fast anyway, but having the partial index means an
-- ad-hoc operational query like "show me rows that might need repair"
-- stays cheap as the table grows.
create index if not exists calls_pending_counters_idx
  on public.calls (id)
  where counters_applied_at is null;


-- ─── 2. Backfill existing rows ───────────────────────────────────────
--
-- Stamp the sentinel on rows where the counter path has already run.
-- coalesce chain picks the best timestamp we have for "when did we
-- apply"; in practice ended_at is almost always set for webhook-path
-- rows and retry exhaustion rows use the retry tick's timestamp.

update public.calls
set counters_applied_at = coalesce(ended_at, last_retry_at, created_at)
where counters_applied_at is null
  and (
    ended_at is not null
    or (status = 'failed' and retry_count >= 3)
  );


-- ─── 3. Replace apply_call_end with idempotent variant ───────────────

-- Drop the old signature. The caller is updated in the same PR so no
-- external user of the old sig exists at runtime. Dropping is safer than
-- create-or-replace here because the parameter list is changing.
drop function if exists public.apply_call_end(uuid, boolean);

create or replace function public.apply_call_end(
  p_request_id     uuid,
  p_call_id        uuid,
  p_quote_inserted boolean
) returns table (
  request_id                 uuid,
  status                     text,
  total_calls_completed      integer,
  total_quotes_collected     integer,
  total_businesses_to_call   integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_rows integer;
begin
  -- Atomic claim. If counters_applied_at is still NULL we stamp it here
  -- and fall through to the counter bump. If it was already set, some
  -- earlier call applied counters — this is a retry and we must NOT
  -- bump again. Returning the current quote_requests state keeps the
  -- function signature uniform so callers don't need to branch on
  -- "was this a no-op?".
  update public.calls
  set counters_applied_at = now()
  where id = p_call_id
    and counters_applied_at is null;

  get diagnostics v_claim_rows = row_count;

  if v_claim_rows = 0 then
    return query
    select
      qr.id,
      qr.status::text,
      qr.total_calls_completed,
      qr.total_quotes_collected,
      qr.total_businesses_to_call
    from public.quote_requests qr
    where qr.id = p_request_id;
    return;
  end if;

  -- Same arithmetic as before: bump total_calls_completed, optionally
  -- bump total_quotes_collected, advance status from 'calling' to
  -- 'processing' when the plan is met. Only transitions out of
  -- 'calling' — we don't clobber 'processing'/'completed'/'failed'
  -- that some other code path already set.
  return query
  update public.quote_requests qr
  set
    total_calls_completed  = qr.total_calls_completed + 1,
    total_quotes_collected = qr.total_quotes_collected + (case when p_quote_inserted then 1 else 0 end),
    status = case
      when qr.status = 'calling'
        and qr.total_businesses_to_call > 0
        and (qr.total_calls_completed + 1) >= qr.total_businesses_to_call
      then 'processing'::quote_request_status
      else qr.status
    end
  where qr.id = p_request_id
  returning
    qr.id,
    qr.status::text,
    qr.total_calls_completed,
    qr.total_quotes_collected,
    qr.total_businesses_to_call;
end;
$$;

revoke all on function public.apply_call_end(uuid, uuid, boolean) from public;
revoke all on function public.apply_call_end(uuid, uuid, boolean) from anon, authenticated;
