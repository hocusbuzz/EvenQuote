-- ══════════════════════════════════════════════════════════════════════
-- EvenQuote — Initial Schema (Phase 1)
-- Run in Supabase SQL Editor against a fresh project.
-- Idempotent where reasonable; drop-and-recreate would be destructive, so
-- this script assumes a clean DB.
-- ══════════════════════════════════════════════════════════════════════

-- Extensions ----------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
-- citext is used for case-insensitive email matching on businesses
create extension if not exists "citext";


-- ─── Enums ──────────────────────────────────────────────────────────
-- Enums are preferable to text+check for status fields because they
-- give us type safety at the DB level and better error messages.
do $$ begin
  create type user_role as enum ('customer', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quote_request_status as enum (
    'pending_payment',   -- form submitted, awaiting Stripe
    'paid',              -- paid, ready to be picked up by call engine
    'calling',           -- calls in progress
    'processing',        -- calls done, generating report
    'completed',         -- report ready and delivered
    'failed'             -- something went wrong, admin attention
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_status as enum (
    'queued',
    'in_progress',
    'completed',
    'failed',
    'no_answer',
    'refused'            -- business declined to give a quote
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending', 'completed', 'failed', 'refunded');
exception when duplicate_object then null; end $$;


-- ─── Utility: updated_at trigger ────────────────────────────────────
-- Standard pattern: a single trigger function reused across tables.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ─── profiles ───────────────────────────────────────────────────────
-- Extends auth.users. One row per authenticated user, created by a
-- trigger on auth.users insert (defined below).
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  full_name    text,
  phone        text,
  role         user_role not null default 'customer',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index profiles_role_idx on public.profiles(role) where role = 'admin';

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- Auto-create a profile row when a new auth user signs up.
-- SECURITY DEFINER so it can write to public.profiles regardless of
-- the caller's RLS context. This function is the ONLY way profiles
-- get created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ─── service_categories ────────────────────────────────────────────
-- Public reference data. Adding disclosure_text here (beyond the spec)
-- so every category can ship with its own AI-disclosure wording baked
-- into the call script, which regulations in several states require.
create table public.service_categories (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  slug                  text not null unique,
  description           text,
  icon                  text,
  is_active             boolean not null default true,
  intake_form_schema    jsonb not null default '{}'::jsonb,
  call_script_template  text,
  disclosure_text       text not null default
    'Hi — quick heads-up, this is an AI assistant calling on behalf of a customer looking for a quote. Is that okay?',
  created_at            timestamptz not null default now()
);

create index service_categories_active_idx on public.service_categories(is_active) where is_active;


-- ─── businesses ────────────────────────────────────────────────────
-- The pool we call from. Phone is required because that's the whole
-- point. Email uses citext so '(at)Example.com' and '(at)example.com' are
-- treated as duplicates for dedup logic later.
create table public.businesses (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  phone                 text not null,
  email                 citext,
  website               text,
  category_id           uuid not null references public.service_categories(id) on delete restrict,
  city                  text not null,
  state                 text not null,
  zip_code              text not null,
  latitude              numeric(9,6),
  longitude             numeric(9,6),
  google_rating         numeric(2,1),
  google_review_count   integer,
  google_place_id       text unique,      -- unique when present, nulls allowed
  is_active             boolean not null default true,
  last_called_at        timestamptz,
  call_success_rate     numeric(4,3),     -- 0.000 to 1.000
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint businesses_rating_range check (google_rating is null or google_rating between 0 and 5),
  constraint businesses_success_range check (call_success_rate is null or call_success_rate between 0 and 1)
);

-- Composite index tuned for the main lookup in Phase 7:
-- "give me active businesses in this category+zip that we haven't called recently"
create index businesses_category_location_idx
  on public.businesses(category_id, zip_code)
  where is_active;

create index businesses_last_called_idx on public.businesses(last_called_at);

create trigger businesses_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();


-- ─── quote_requests ────────────────────────────────────────────────
create table public.quote_requests (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  category_id                 uuid not null references public.service_categories(id) on delete restrict,
  status                      quote_request_status not null default 'pending_payment',
  intake_data                 jsonb not null default '{}'::jsonb,
  city                        text not null,
  state                       text not null,
  zip_code                    text not null,
  stripe_payment_id           text,
  total_businesses_to_call    integer not null default 0,
  total_calls_made            integer not null default 0,
  total_calls_completed       integer not null default 0,
  total_quotes_collected      integer not null default 0,
  report_generated_at         timestamptz,
  report_data                 jsonb,
  report_sent_at              timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- Sanity: counters shouldn't go negative or exceed the planned total
  constraint counters_non_negative check (
    total_businesses_to_call >= 0 and
    total_calls_made >= 0 and
    total_calls_completed >= 0 and
    total_quotes_collected >= 0
  )
);

create index quote_requests_user_idx on public.quote_requests(user_id, created_at desc);
create index quote_requests_status_idx on public.quote_requests(status);

create trigger quote_requests_updated_at
  before update on public.quote_requests
  for each row execute function public.set_updated_at();


-- ─── calls ─────────────────────────────────────────────────────────
create table public.calls (
  id                  uuid primary key default gen_random_uuid(),
  quote_request_id    uuid not null references public.quote_requests(id) on delete cascade,
  business_id         uuid not null references public.businesses(id) on delete restrict,
  vapi_call_id        text unique,
  status              call_status not null default 'queued',
  started_at          timestamptz,
  ended_at            timestamptz,
  duration_seconds    integer,
  transcript          text,
  recording_url       text,
  summary             text,
  extracted_data      jsonb,
  cost                numeric(8,4),      -- Vapi reports in USD, 4dp is plenty
  retry_count         integer not null default 0,
  created_at          timestamptz not null default now(),

  constraint calls_retry_cap check (retry_count >= 0 and retry_count <= 5)
);

create index calls_request_idx on public.calls(quote_request_id);
create index calls_business_idx on public.calls(business_id);
create index calls_status_idx on public.calls(status);


-- ─── quotes ────────────────────────────────────────────────────────
-- Derived from calls.extracted_data but stored separately so the report
-- generator can query clean structured data without re-parsing JSONB.
create table public.quotes (
  id                          uuid primary key default gen_random_uuid(),
  call_id                     uuid not null unique references public.calls(id) on delete cascade,
  quote_request_id            uuid not null references public.quote_requests(id) on delete cascade,
  business_id                 uuid not null references public.businesses(id) on delete restrict,
  price_min                   numeric(10,2),
  price_max                   numeric(10,2),
  price_description           text,
  availability                text,
  includes                    text[],
  excludes                    text[],
  notes                       text,
  contact_name                text,
  contact_phone               text,
  contact_email               citext,
  requires_onsite_estimate    boolean not null default false,
  confidence_score            numeric(3,2),   -- 0.00 to 1.00
  created_at                  timestamptz not null default now(),

  constraint quotes_price_sanity check (
    (price_min is null and price_max is null) or
    (price_min is not null and price_max is not null and price_min <= price_max) or
    (price_min is not null and price_max is null) or
    (price_min is null and price_max is not null)
  ),
  constraint quotes_confidence_range check (
    confidence_score is null or confidence_score between 0 and 1
  )
);

create index quotes_request_idx on public.quotes(quote_request_id);


-- ─── payments ──────────────────────────────────────────────────────
create table public.payments (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  quote_request_id            uuid not null references public.quote_requests(id) on delete cascade,
  stripe_session_id           text not null unique,
  stripe_payment_intent_id    text unique,
  amount                      integer not null,          -- cents
  currency                    text not null default 'usd',
  status                      payment_status not null default 'pending',
  created_at                  timestamptz not null default now(),

  constraint payments_amount_positive check (amount > 0)
);

create index payments_user_idx on public.payments(user_id);
create index payments_request_idx on public.payments(quote_request_id);


-- ══════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════
-- Principles:
--   • Users see only their own profile, requests, calls, quotes, payments
--   • service_categories and businesses are public-read (no PII)
--   • Writes to user-scoped tables are done server-side with the
--     service role key, which bypasses RLS. Clients never INSERT
--     quote_requests directly (a server action does it after validation).
--   • Admins are granted cross-user read access via a helper.
-- ══════════════════════════════════════════════════════════════════════

-- Helper: is the current auth user an admin?
-- SECURITY DEFINER so it can read profiles without triggering its own
-- RLS policies (which would cause infinite recursion).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Enable RLS everywhere
alter table public.profiles           enable row level security;
alter table public.service_categories enable row level security;
alter table public.businesses         enable row level security;
alter table public.quote_requests     enable row level security;
alter table public.calls              enable row level security;
alter table public.quotes             enable row level security;
alter table public.payments           enable row level security;


-- profiles ------------------------------------------------------------
create policy "profiles: self read" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles: admin read all" on public.profiles
  for select using (public.is_admin());

create policy "profiles: self update" on public.profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- users may not escalate their own role; role changes require service role
    and role = (select role from public.profiles where id = auth.uid())
  );


-- service_categories --------------------------------------------------
-- Public-read for active categories. No client writes (admin-only via service role).
create policy "service_categories: public read active" on public.service_categories
  for select using (is_active or public.is_admin());


-- businesses ----------------------------------------------------------
-- We expose business data to authenticated users so the UI can show
-- "we'll call these N companies" preview. If you want to keep the
-- business list private, tighten this later.
create policy "businesses: authenticated read active" on public.businesses
  for select using (
    (is_active and auth.uid() is not null) or public.is_admin()
  );


-- quote_requests ------------------------------------------------------
create policy "quote_requests: owner read" on public.quote_requests
  for select using (auth.uid() = user_id or public.is_admin());
-- No client INSERT/UPDATE/DELETE policies. All writes go through server
-- actions using the service role, which bypasses RLS entirely.


-- calls ---------------------------------------------------------------
create policy "calls: owner read via request" on public.calls
  for select using (
    public.is_admin() or exists (
      select 1 from public.quote_requests qr
      where qr.id = calls.quote_request_id and qr.user_id = auth.uid()
    )
  );


-- quotes --------------------------------------------------------------
create policy "quotes: owner read via request" on public.quotes
  for select using (
    public.is_admin() or exists (
      select 1 from public.quote_requests qr
      where qr.id = quotes.quote_request_id and qr.user_id = auth.uid()
    )
  );


-- payments ------------------------------------------------------------
create policy "payments: owner read" on public.payments
  for select using (auth.uid() = user_id or public.is_admin());


-- ══════════════════════════════════════════════════════════════════════
-- Done. Next: run seed files in supabase/seed/ in numeric order.
-- ══════════════════════════════════════════════════════════════════════
