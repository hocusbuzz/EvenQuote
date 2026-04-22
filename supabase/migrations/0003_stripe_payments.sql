-- ══════════════════════════════════════════════════════════════════════
-- Phase 5 — Stripe payments schema changes.
--
-- Three additions:
--
-- 1. payments.user_id becomes nullable. Same reason quote_requests.user_id
--    went nullable in migration 0002: Phase 5's guest flow lets users pay
--    BEFORE signing in. The payment row is written by the webhook with
--    user_id=NULL and backfilled when the user clicks the magic link
--    sent to the email they entered in the intake form.
--
-- 2. payments.stripe_event_id for webhook idempotency. Stripe retries
--    delivery on non-2xx responses and can double-deliver even on 2xx
--    during their own failure modes. We MUST ignore duplicates or we'll
--    double-process the same event (e.g. enqueue calls twice). Unique
--    constraint means a second insert with the same event_id fails, which
--    is exactly what we want as a natural idempotency gate.
--
-- 3. payments.claimed_at tracks when a guest payment got associated with
--    a user (after magic-link click). Optional but useful for support.
--
-- Safe to apply to an existing DB. Drops a NOT NULL constraint, adds
-- two nullable columns, and adds a unique index.
-- ══════════════════════════════════════════════════════════════════════

-- 1. Make user_id nullable on payments.
alter table public.payments
  alter column user_id drop not null;

-- 2. Add stripe_event_id for webhook idempotency.
alter table public.payments
  add column if not exists stripe_event_id text;

create unique index if not exists payments_stripe_event_id_key
  on public.payments (stripe_event_id)
  where stripe_event_id is not null;

-- 3. Add claimed_at for guest payment → user claim tracking.
alter table public.payments
  add column if not exists claimed_at timestamptz;

-- Partial index for the "find unclaimed payments for email X" lookup
-- used when a signed-in user hits the claim route. The lookup itself
-- joins via quote_requests.intake_data->>'contact_email', but filtering
-- by "user_id is null" first narrows the scan substantially.
create index if not exists payments_unclaimed_idx
  on public.payments (created_at desc)
  where user_id is null;

-- Note on RLS: the existing "payments: owner read" policy reads
-- `auth.uid() = user_id`, which correctly evaluates to false for
-- guest rows (user_id IS NULL). Guest users cannot read their own
-- payment row via the cookie client — that's fine, because the
-- success page and claim route both use the admin client for
-- these lookups (no user-specific data leak since we scope by
-- stripe_session_id, which only the legitimate client knows).
