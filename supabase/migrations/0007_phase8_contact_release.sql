-- Phase 8 — Opt-in contact release
--
-- Adds the plumbing for a customer to pick one or more quotes from a
-- completed report and release their PII (name/email/phone) to those
-- businesses. Nothing here exposes contact info automatically; the
-- server action in lib/actions/release-contact.ts is the only writer.
--
-- Additive only: new column on quotes, new audit table, no changes to
-- existing data or policies.

begin;

-- ─── quotes: contact_released_at ───────────────────────────────────
-- Timestamp of when the customer shared their contact info with this
-- specific business. Null = not yet released. Non-null = customer has
-- chosen this quote (or at least this business) and an email with the
-- customer's details was dispatched to the business.
alter table public.quotes
  add column if not exists contact_released_at timestamptz;

-- Partial index so the dashboard "already shared" badge query is fast
-- even when most quotes are unreleased.
create index if not exists quotes_released_idx
  on public.quotes(quote_request_id, contact_released_at)
  where contact_released_at is not null;


-- ─── quote_contact_releases: audit log ─────────────────────────────
-- One row per release action. Keeps a tamper-evident trail separate
-- from the quotes table so even if we ever let customers "unrelease"
-- (unlikely), we still have the history. Also survives quote deletes
-- because it references by quote_id without an FK cascade into the
-- customer-writable side.
create table if not exists public.quote_contact_releases (
  id                  uuid primary key default gen_random_uuid(),
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  quote_request_id    uuid not null references public.quote_requests(id) on delete cascade,
  business_id         uuid not null references public.businesses(id) on delete restrict,
  released_by_user_id uuid not null references public.profiles(id) on delete restrict,
  released_at         timestamptz not null default now(),
  email_send_id       text,  -- Resend message id (or sim_* in dev)
  email_simulated     boolean not null default false,
  email_error         text,  -- populated on send failure for ops to triage

  -- One release per quote. If a customer tries to share the same
  -- quote twice we fail loud rather than spamming the business.
  constraint quote_contact_releases_unique unique (quote_id)
);

create index if not exists quote_contact_releases_request_idx
  on public.quote_contact_releases(quote_request_id);
create index if not exists quote_contact_releases_user_idx
  on public.quote_contact_releases(released_by_user_id, released_at desc);


-- ─── RLS ───────────────────────────────────────────────────────────
-- Same posture as the rest of the customer-writable tables: owners can
-- read; writes happen server-side via the service role. No direct
-- INSERT from the client — the server action does the ownership check
-- and the send, then inserts the audit row with the service client.
alter table public.quote_contact_releases enable row level security;

-- Drop-then-recreate so this migration is idempotent under a
-- disaster-recovery re-apply. Postgres < 15 has no `create policy if
-- not exists`, so `drop policy if exists` is the canonical guard.
-- The whole file runs inside a transaction (`begin;…commit;`) so
-- there is no live window where the policy is absent.
drop policy if exists "quote_contact_releases: owner read"
  on public.quote_contact_releases;
create policy "quote_contact_releases: owner read"
  on public.quote_contact_releases
  for select
  using (released_by_user_id = auth.uid());

drop policy if exists "quote_contact_releases: admin read all"
  on public.quote_contact_releases;
create policy "quote_contact_releases: admin read all"
  on public.quote_contact_releases
  for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

commit;
