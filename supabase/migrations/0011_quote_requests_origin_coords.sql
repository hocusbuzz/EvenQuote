-- ══════════════════════════════════════════════════════════════════════
-- quote_requests.origin_lat / origin_lng / businesses_seeded_at
--
-- On-demand business seeding (R47): instead of pre-ingesting every zip
-- we expect to serve, we let each paid quote_request *seed itself* —
-- right after the Stripe webhook flips status='paid', a server hook
-- runs Google Places searchText biased to the request's origin coords
-- (~20 mi radius), upserts the results into `businesses`, and only
-- THEN does the call engine pick K from the freshly-populated pool.
--
-- That pipeline needs three new bits of state on quote_requests:
--
--   • origin_lat / origin_lng  — written by the form server action
--     when the user picks a Google Places prediction. Place Details
--     already returns location.lat/lng for free; we just persist it.
--     Used as the locationBias center for searchText AND as the
--     anchor for the radius selector in lib/calls/select-businesses.ts
--     (replaces the "pick any business in this zip and use its coords"
--     centroid trick — more accurate, and works for cold-start zips).
--
--   • businesses_seeded_at    — idempotency sentinel. The seeder
--     stamps it on first run so a webhook replay (or a manual retry)
--     won't fire a second searchText call for the same request.
--     Nullable because the legacy/manual-seed path doesn't touch it.
--
-- All three columns are nullable. No backfill required — existing rows
-- (manual ingest era) keep working unchanged: the call engine falls
-- back to the old anchor-business radius logic when origin_lat IS NULL.
-- ══════════════════════════════════════════════════════════════════════

alter table public.quote_requests
  add column if not exists origin_lat numeric(9,6);

alter table public.quote_requests
  add column if not exists origin_lng numeric(9,6);

alter table public.quote_requests
  add column if not exists businesses_seeded_at timestamptz;

comment on column public.quote_requests.origin_lat is
  'WGS84 latitude of the request origin address, captured from Google '
  'Place Details when the user picks a prediction. NULL on legacy rows '
  'or manual-entry addresses Google could not resolve.';

comment on column public.quote_requests.origin_lng is
  'WGS84 longitude of the request origin address. See origin_lat.';

comment on column public.quote_requests.businesses_seeded_at is
  'Set when the on-demand Google Places seeder has run for this request. '
  'Sentinel for replay/retry idempotency — second call is a no-op.';
