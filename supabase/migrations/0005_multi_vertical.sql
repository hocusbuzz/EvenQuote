-- ══════════════════════════════════════════════════════════════════════
-- Phase 6.1 — multi-vertical support.
--
-- Three schema changes, all additive:
--
-- 1. service_categories.extraction_schema (jsonb) — per-category shape
--    the Vapi webhook extractor should produce. Moving's is already
--    hardcoded in extract-quote.ts; this column lets new categories
--    specify their own keys without a code change.
--
-- 2. service_categories.places_query_template (text) — prompt template
--    used by the ingest CLI to build Google Places queries per category.
--    E.g. moving → "movers near {zip}", cleaning → "house cleaning near {zip}".
--
-- 3. waitlist_signups — email capture for verticals we haven't built yet.
--    Lets us validate demand per-category before investing in the
--    intake form + call script work. Deletes cascade by category so
--    dropping a category cleans up its waitlist.
--
-- Safe to apply — everything is additive with sensible defaults.
-- ══════════════════════════════════════════════════════════════════════

-- 1 + 2: new columns on service_categories.
alter table public.service_categories
  add column if not exists extraction_schema jsonb;

alter table public.service_categories
  add column if not exists places_query_template text;

-- 3: waitlist_signups.
create table if not exists public.waitlist_signups (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.service_categories(id) on delete cascade,
  email        citext not null,
  zip_code     text,
  created_at   timestamptz not null default now(),

  -- One signup per (category, email). A second POST from the same email
  -- for the same vertical should 200 with "already on the list" rather
  -- than create a duplicate row.
  constraint waitlist_signups_unique unique (category_id, email)
);

create index if not exists waitlist_signups_category_idx
  on public.waitlist_signups (category_id, created_at desc);

-- RLS: waitlist is write-only from the public (via server action using
-- service role). No reads from the client — admins access via dashboard
-- with service role. Policy omission means no client can SELECT; the
-- server action bypasses RLS anyway.
alter table public.waitlist_signups enable row level security;
-- No policies = no rows visible to any client. Admin reads via service role.
