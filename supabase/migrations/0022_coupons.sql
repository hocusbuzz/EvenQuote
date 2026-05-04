-- ══════════════════════════════════════════════════════════════════════
-- Migration 0022: coupons — admin-minted free-redemption codes.
--
-- Use case: the founder wants to share 5 codes with friends so they
-- can run a quote request without paying $9.99. Codes are random +
-- unguessable so users can't generate them client-side. Redemption
-- bypasses Stripe entirely; a redeemed coupon stamps
-- quote_requests.coupon_code for audit and triggers the same
-- post-payment side effects (magic link, enqueue calls, founder alert).
--
-- DESIGN
-- ──────
-- One row per code. No per-user binding (the friend uses whichever
-- email they want at intake time). max_uses defaults to 1 (single-
-- use); set higher for "share with team" / "promo for newsletter
-- subscribers" scenarios. expires_at optional — null = no expiry.
-- category_slug optional — null = redeemable for any vertical;
-- restrict to e.g. 'moving' if a partner deal is vertical-specific.
--
-- SECURITY
-- ────────
-- RLS on, no policies = service-role only. Anonymous + authenticated
-- users CANNOT read or write the coupons table directly. Redemption
-- happens via the redeem_coupon SECURITY DEFINER function which runs
-- as the function owner (postgres) and is grant-restricted so only
-- the service-role context can invoke it. This is the same pattern
-- as apply_call_end + recompute_business_success_rate from migration
-- 0001 — we treat coupon codes as ops-restricted secrets even though
-- the entropy makes random guessing impractical (12 chars from the
-- 31-letter no-confusion alphabet ≈ 2^59 entropy).
--
-- ATOMICITY
-- ─────────
-- redeem_coupon takes a row-level lock (SELECT FOR UPDATE) so two
-- concurrent redemptions of the same single-use code can't both
-- succeed. Without the lock, two users hitting "redeem" within the
-- same second on a max_uses=1 coupon could both increment from 0→1
-- and both pass the validity check.
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.coupons (
  code            text primary key,
  max_uses        integer not null default 1 check (max_uses >= 1),
  used_count      integer not null default 0 check (used_count >= 0),
  expires_at      timestamptz,
  -- Optional vertical restriction. Null = redeemable for any vertical.
  -- When set, redeem_coupon() refuses if the request's category slug
  -- doesn't match.
  category_slug   text,
  notes           text,
  created_at      timestamptz not null default now()
);

-- Partial index on not-yet-exhausted codes so the redemption RPC's
-- SELECT-FOR-UPDATE doesn't scan exhausted ones. We deliberately
-- don't include the expires_at predicate — Postgres requires index
-- predicates to be IMMUTABLE and now() is STABLE. The expires_at
-- check happens at runtime inside redeem_coupon() instead. At our
-- expected coupon volume (handfuls, not millions) the index isn't
-- load-bearing anyway; this is shape-correctness.
create index if not exists coupons_redeemable_idx
  on public.coupons (code)
  where used_count < max_uses;

-- RLS lockdown. No policies = no access from anon/authenticated.
alter table public.coupons enable row level security;
revoke all on public.coupons from anon, authenticated;

comment on table public.coupons is
  'Admin-minted free-redemption codes. RLS off-by-default; redemption '
  'goes through redeem_coupon() SECURITY DEFINER function. See '
  'lib/actions/coupons.ts and scripts/mint-coupons.ts for the surfaces.';

-- ──────────────────────────────────────────────────────────────────────
-- quote_requests.coupon_code — audit trail of which coupon (if any)
-- was used for this request. Null = paid via Stripe (or unpaid).
-- ──────────────────────────────────────────────────────────────────────

alter table public.quote_requests
  add column if not exists coupon_code text references public.coupons(code) on delete set null;

create index if not exists quote_requests_coupon_code_idx
  on public.quote_requests (coupon_code)
  where coupon_code is not null;

comment on column public.quote_requests.coupon_code is
  'Coupon used to bypass Stripe at checkout. Null = paid via Stripe '
  '(or never paid). Stamped by redeem_coupon() RPC inside the same '
  'transaction that increments coupons.used_count.';

-- ──────────────────────────────────────────────────────────────────────
-- redeem_coupon — atomic check + increment + audit stamp.
--
-- Returns one of:
--   ('ok',         null)        — coupon was valid; used_count incremented;
--                                 quote_requests.coupon_code stamped.
--   ('not_found',  null)        — code doesn't exist.
--   ('expired',    expires_at)  — code exists but expires_at < now().
--   ('exhausted',  null)        — used_count >= max_uses.
--   ('wrong_vertical', slug)    — code restricted to a different
--                                 vertical than the request's category.
--   ('request_not_pending', s)  — request exists but is not in
--                                 status='pending_payment' (already
--                                 paid, refunded, etc).
--
-- The validation and the increment + audit-stamp are in ONE
-- transaction: SELECT FOR UPDATE locks the coupons row, the UPDATE
-- to coupons + UPDATE to quote_requests are atomic, and any
-- concurrent attempt blocks until commit.
-- ──────────────────────────────────────────────────────────────────────

create or replace function public.redeem_coupon(
  p_code text,
  p_quote_request_id uuid
) returns table (outcome text, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_coupon public.coupons%rowtype;
  v_qr_status text;
  v_qr_category_slug text;
begin
  -- 1. Lock the coupon row first. This prevents two concurrent
  -- redemptions of the same single-use code from both succeeding.
  -- If the row doesn't exist, FOR UPDATE returns no rows and
  -- v_coupon stays at its declared default (all-null).
  select * into v_coupon from public.coupons where code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
    return query select 'expired'::text, v_coupon.expires_at::text;
    return;
  end if;

  if v_coupon.used_count >= v_coupon.max_uses then
    return query select 'exhausted'::text, null::text;
    return;
  end if;

  -- 2. Look up the quote_request to validate vertical + status.
  -- Joining service_categories for the slug.
  select qr.status, sc.slug
    into v_qr_status, v_qr_category_slug
    from public.quote_requests qr
    left join public.service_categories sc on sc.id = qr.category_id
   where qr.id = p_quote_request_id;
  if v_qr_status is null then
    return query select 'request_not_found'::text, null::text;
    return;
  end if;
  if v_qr_status <> 'pending_payment' then
    return query select 'request_not_pending'::text, v_qr_status;
    return;
  end if;

  -- 3. Vertical restriction check (if any).
  if v_coupon.category_slug is not null
     and v_coupon.category_slug <> coalesce(v_qr_category_slug, '') then
    return query select 'wrong_vertical'::text, v_coupon.category_slug;
    return;
  end if;

  -- 4. Atomically increment used_count + stamp the request.
  update public.coupons
     set used_count = used_count + 1
   where code = p_code;

  update public.quote_requests
     set coupon_code = p_code,
         status = 'paid'
   where id = p_quote_request_id;

  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.redeem_coupon(text, uuid) from public, anon, authenticated;
-- service_role retains execute via the default GRANT to PUBLIC roles
-- on functions; the explicit revoke above strips it back. Re-grant
-- only to service_role explicitly.
grant execute on function public.redeem_coupon(text, uuid) to service_role;

comment on function public.redeem_coupon(text, uuid) is
  'Atomic coupon redemption. Locks the coupons row (SELECT FOR UPDATE), '
  'validates expiry + uses + vertical, then increments coupons.used_count '
  'and flips quote_requests.status to paid + stamps coupon_code in ONE '
  'transaction. service_role only — invoked from lib/actions/coupons.ts.';
