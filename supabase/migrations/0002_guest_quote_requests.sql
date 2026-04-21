-- ══════════════════════════════════════════════════════════════════════
-- Phase 4 schema change: allow guest quote requests.
--
-- Phase 1 locked user_id as NOT NULL because we assumed users would
-- sign in before filling the form. Phase 4 reverses that decision:
-- users fill out the intake first, sign in at checkout. The guest row
-- gets its user_id backfilled when the user signs in and pays.
--
-- Safe to apply to an existing DB — no data backfill needed.
-- ══════════════════════════════════════════════════════════════════════

alter table public.quote_requests
  alter column user_id drop not null;

-- Refine the RLS "owner read" policy so it still covers guest rows
-- that later get assigned a user_id. The existing policy already
-- reads `auth.uid() = user_id`, which correctly evaluates to false
-- for guest rows (user_id IS NULL), so nothing to change there —
-- but we add an explicit index on the nullable column for fast
-- "claim my guest requests" lookups during Phase 5 checkout.
create index if not exists quote_requests_user_null_idx
  on public.quote_requests (created_at desc)
  where user_id is null;
