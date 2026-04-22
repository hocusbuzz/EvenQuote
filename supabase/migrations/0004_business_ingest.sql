-- ══════════════════════════════════════════════════════════════════════
-- Phase 6 — business ingest + call engine refinements.
--
-- Small additive changes. Everything here is backward compatible.
--
-- 1. businesses.source tracks where the row came from (google_places,
--    manual seed, CSV import, partner). Useful for attribution and
--    for filtering during dedupe.
--
-- 2. businesses.ingested_at is when we last pulled/refreshed this row
--    from its source. Separate from created_at because we may re-ingest
--    the same place_id to pick up rating changes.
--
-- 3. A composite index tuned for the "pick the best K movers in this
--    zip we haven't called recently" query. Covers the common filter
--    (category + zip + active) and lets the planner avoid re-reading
--    the row for rating/last_called_at ordering.
--
-- Safe to apply to existing data — both new columns are nullable with
-- sensible defaults. No data backfill required.
-- ══════════════════════════════════════════════════════════════════════

alter table public.businesses
  add column if not exists source text;

alter table public.businesses
  add column if not exists ingested_at timestamptz;

-- If we want a historical default for existing rows that predate
-- this column, leaving it null is fine — it's informational.

-- Composite index for the call-engine selector. The WHERE clause
-- keeps the index lean (only active businesses participate in
-- selection).
create index if not exists businesses_selector_idx
  on public.businesses (category_id, zip_code, google_rating desc nulls last, last_called_at asc nulls first)
  where is_active;

-- Phase 6 also tracks the *batch* of calls a quote_request spawned.
-- Rather than introducing a new table, we piggyback on quote_requests:
--   total_businesses_to_call — set by the call engine when it selects
--   total_calls_made         — incremented when Vapi accepts the call
--   total_calls_completed    — incremented by the webhook on end-of-call
--   total_quotes_collected   — incremented when a quote row is inserted
-- All four exist already (Phase 1) — no schema change needed.
--
-- One addition: a lightweight tracking column for Vapi's per-request
-- batch idempotency. When the webhook replays, we use this to detect
-- "we already processed this batch" without scanning calls rows.
alter table public.quote_requests
  add column if not exists vapi_batch_started_at timestamptz;
