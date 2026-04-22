-- ══════════════════════════════════════════════════════════════════════
-- Phase 7 — reliability.
--
-- Four additions, all additive:
--
-- 1. apply_call_end() — atomic counter increment + terminal-state flip
--    on quote_requests. Replaces the read-modify-write in the Vapi
--    webhook so concurrent end-of-call events can't clobber each other.
--
-- 2. calls.last_retry_at — lets the retry worker throttle: don't pick up
--    the same row within N minutes of a previous retry attempt.
--
-- 3. recompute_business_success_rate() — after every end-of-call, blend
--    the business's rolling completion rate over the last N calls into
--    businesses.call_success_rate. Selector uses this to prefer reliable
--    businesses.
--
-- 4. businesses_within_radius() — plain-SQL haversine lookup. Used as a
--    fallback when the exact-zip pool is thin. No PostGIS required.
--
-- Safe to apply: additive (one new column, three new functions). No
-- changes to existing columns or constraints.
-- ══════════════════════════════════════════════════════════════════════

-- ─── 1. Atomic quote_request counter update ──────────────────────────
--
-- Single UPDATE on quote_requests:
--   - bumps total_calls_completed
--   - optionally bumps total_quotes_collected
--   - flips status to 'processing' when completed catches the plan
--
-- The arithmetic happens inline in the UPDATE, so two concurrent calls
-- to this function serialize at the row lock and can't lose increments.

create or replace function public.apply_call_end(
  p_request_id    uuid,
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
begin
  return query
  update public.quote_requests qr
  set
    total_calls_completed  = qr.total_calls_completed + 1,
    total_quotes_collected = qr.total_quotes_collected + (case when p_quote_inserted then 1 else 0 end),
    status = case
      -- Only transition out of 'calling'. We don't want to clobber
      -- 'processing' / 'completed' / 'failed' that got set by some
      -- other code path.
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

-- Callable only from trusted server code (admin client uses service
-- role). Revoking from anon/authenticated prevents a hypothetical RLS
-- bypass if someone flipped supabase-js role settings later.
revoke all on function public.apply_call_end(uuid, boolean) from public;
revoke all on function public.apply_call_end(uuid, boolean) from anon, authenticated;


-- ─── 2. Retry throttle column ────────────────────────────────────────

alter table public.calls
  add column if not exists last_retry_at timestamptz;

-- Partial index for the retry worker's scan — only dispatch-failed rows
-- are retry candidates (started_at IS NULL distinguishes dispatch-fail
-- from mid-call-fail). Keeps the index tiny.
create index if not exists calls_retry_candidate_idx
  on public.calls (last_retry_at nulls first, created_at)
  where status = 'failed' and started_at is null and retry_count < 3;


-- ─── 3. Rolling call_success_rate recomputation ──────────────────────
--
-- "Success" = call ended with status='completed'. refused / no_answer /
-- failed all count against the business. Window is last N calls; N=20
-- is a reasonable default that adapts within a day or two of activity.
--
-- Rounds to 3 decimals to match the businesses.call_success_rate scale
-- (numeric(4,3)). Updates in-place on the businesses row.

create or replace function public.recompute_business_success_rate(
  p_business_id uuid,
  p_window      integer default 20
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total    integer;
  v_success  integer;
  v_rate     numeric(4,3);
begin
  -- Consider only calls that reached a terminal state. Queued/in_progress
  -- rows shouldn't swing the score either way.
  select count(*), count(*) filter (where status = 'completed')
    into v_total, v_success
  from (
    select status
    from public.calls
    where business_id = p_business_id
      and status in ('completed', 'failed', 'no_answer', 'refused')
    order by coalesce(ended_at, started_at, created_at) desc
    limit p_window
  ) t;

  if v_total = 0 then
    return null;
  end if;

  v_rate := round(v_success::numeric / v_total::numeric, 3);

  update public.businesses
     set call_success_rate = v_rate
   where id = p_business_id;

  return v_rate;
end;
$$;

revoke all on function public.recompute_business_success_rate(uuid, integer) from public;
revoke all on function public.recompute_business_success_rate(uuid, integer) from anon, authenticated;


-- ─── 4. Haversine radius search ──────────────────────────────────────
--
-- Returns active businesses in the given category within p_radius_miles
-- of (p_lat, p_lng), ordered by a blended score:
--   primary:   distance ascending
--   tiebreak:  call_success_rate descending (nulls treated as 0.5 —
--              unproven businesses aren't penalized hard)
--   tiebreak:  google_rating descending
--
-- Using numeric math instead of PostGIS keeps the migration boring and
-- the index story simple. For our batch size (k=5) and pool size (low
-- thousands per category), a seq scan with the category filter is fine.

create or replace function public.businesses_within_radius(
  p_category_id  uuid,
  p_lat          numeric,
  p_lng          numeric,
  p_radius_miles numeric,
  p_limit        integer
) returns table (
  id              uuid,
  name            text,
  phone           text,
  google_rating   numeric,
  zip_code        text,
  latitude        numeric,
  longitude       numeric,
  distance_miles  numeric,
  call_success_rate numeric
)
language sql
stable
set search_path = public
as $$
  select
    b.id,
    b.name,
    b.phone,
    b.google_rating,
    b.zip_code,
    b.latitude,
    b.longitude,
    -- 3958.8 miles = Earth radius. Haversine great-circle distance.
    (3958.8 * 2 * asin(sqrt(
      power(sin(radians(b.latitude - p_lat) / 2), 2) +
      cos(radians(p_lat)) * cos(radians(b.latitude)) *
      power(sin(radians(b.longitude - p_lng) / 2), 2)
    )))::numeric as distance_miles,
    b.call_success_rate
  from public.businesses b
  where b.category_id = p_category_id
    and b.is_active
    and b.latitude is not null
    and b.longitude is not null
    and (3958.8 * 2 * asin(sqrt(
      power(sin(radians(b.latitude - p_lat) / 2), 2) +
      cos(radians(p_lat)) * cos(radians(b.latitude)) *
      power(sin(radians(b.longitude - p_lng) / 2), 2)
    ))) <= p_radius_miles
  order by
    distance_miles asc,
    coalesce(b.call_success_rate, 0.5) desc,
    coalesce(b.google_rating, 0) desc,
    b.last_called_at asc nulls first
  limit p_limit;
$$;

revoke all on function public.businesses_within_radius(uuid, numeric, numeric, numeric, integer) from public;
revoke all on function public.businesses_within_radius(uuid, numeric, numeric, numeric, integer) from anon, authenticated;
