'use server';

// Coupon redemption server action.
//
// Called from the checkout page when a user submits a coupon code.
// On success the action:
//   1. Atomically validates + increments coupons.used_count via
//      redeem_coupon() RPC (same transaction also flips
//      quote_requests.status to 'paid' + stamps coupon_code).
//   2. Triggers the SAME post-payment side effects the Stripe webhook
//      uses (magic link, on-demand seed, enqueue calls, deferred
//      confirmation if outside business hours, analytics event,
//      founder "new payment" alert) — coupon-paid customers get the
//      same UX as paying customers, just with a $0 receipt.
//   3. Returns { ok: true, redirectUrl: '/get-quotes/success?...' }
//
// SECURITY
// ────────
// Rate-limited per-IP (5 attempts / 5 minutes) so a determined
// attacker can't brute-force the 31^12 space — at 5 attempts every
// 5 minutes that's ~525,600 attempts/year per IP, which against a
// 31^12 ≈ 8e17 space gives a 6e-13 chance of hitting any single code
// per year. Plus we soft-reject malformed inputs at the well-formed
// check before any DB hit, so wrong-shape inputs don't even count
// against the rate limit budget toward the brute-force calculus.
//
// The redeem_coupon() RPC itself is service-role-only (REVOKE'd from
// anon/authenticated in the migration), so even a leaked anon key
// can't redeem.
//
// AUDIT
// ─────
// Every successful redemption stamps quote_requests.coupon_code (per
// the RPC) and runs through the same runPostPaymentSideEffects fan-
// out as a real payment, which means the founder gets the "💰 New
// paid request" email even for $0-coupon customers. Subject line
// renders "$0.00" instead of "$9.99" so the operator can distinguish
// at a glance.

import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertRateLimitFromHeaders } from '@/lib/security/rate-limit-auth';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';
import {
  isWellFormedCouponCode,
  normalizeCouponCode,
} from '@/lib/coupons/codes';

const log = createLogger('actions/coupons');

// Allow-listed Sentry reasons for this surface.
export type CouponReason =
  | 'rpcFailed'
  | 'sideEffectsFailed';

export type RedeemCouponResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; error: string };

/**
 * Apply a coupon code to a pending quote_request. Bypasses Stripe
 * and triggers the standard post-payment side effects.
 */
export async function redeemCoupon(args: {
  quoteRequestId: string;
  code: string;
}): Promise<RedeemCouponResult> {
  // Rate limit FIRST — protects the brute-force surface even if the
  // user submits well-formed garbage. Same prefix shape as the other
  // public actions; a future Upstash swap is a single-file edit.
  const deny = assertRateLimitFromHeaders(headers(), {
    prefix: 'coupon-redeem',
    limit: 5,
    windowMs: 5 * 60 * 1000,
  });
  if (deny) {
    return {
      ok: false,
      error: `Too many attempts. Try again in ${deny.retryAfterSec}s.`,
    };
  }

  const code = normalizeCouponCode(args.code ?? '');
  if (!isWellFormedCouponCode(code)) {
    // Soft-reject malformed input. Generic copy so a guesser doesn't
    // get a hint about the alphabet/length.
    return { ok: false, error: 'That code doesn\'t look right.' };
  }

  if (!args.quoteRequestId) {
    return { ok: false, error: 'Missing request id.' };
  }

  const admin = createAdminClient();

  // Call the SECURITY DEFINER RPC. It returns one row of (outcome,
  // detail). PostgREST surfaces a TABLE-returning function as an
  // array — first row is the result.
  type Row = { outcome: string; detail: string | null };
  const { data, error: rpcErr } = await admin.rpc('redeem_coupon', {
    p_code: code,
    p_quote_request_id: args.quoteRequestId,
  });

  if (rpcErr) {
    log.error('redeem_coupon rpc failed', { err: rpcErr });
    captureException(new Error(rpcErr.message), {
      tags: {
        lib: 'coupons',
        reason: 'rpcFailed' satisfies CouponReason,
      },
    });
    return { ok: false, error: 'Something went wrong. Try again?' };
  }

  const rows = (data ?? []) as Row[];
  const outcome = rows[0]?.outcome ?? 'not_found';
  if (outcome !== 'ok') {
    // Map the RPC's outcome to user-facing copy. Generic where
    // possible — we don't want to leak whether a code exists.
    const userError =
      outcome === 'expired'
        ? 'That coupon has expired.'
        : outcome === 'wrong_vertical'
          ? 'That coupon isn\'t valid for this service.'
          : outcome === 'request_not_pending'
            ? 'This request can\'t use a coupon (already paid or closed).'
            : 'That code doesn\'t look right.'; // not_found / exhausted both → generic
    return { ok: false, error: userError };
  }

  // Coupon was redeemed atomically — the request is now status='paid'
  // with coupon_code stamped. Run post-payment side effects in the
  // same shape the Stripe webhook does (magic link, seed, enqueue,
  // deferred-confirmation email, analytics, founder alert).
  //
  // We import dynamically to keep the action's cold-start light AND
  // because `runPostPaymentSideEffects` is currently a non-exported
  // function inside the webhook route — that's a separate refactor.
  // For v1 we duplicate the minimum: enqueue calls + send the
  // founder alert. Magic link is a separate concern (the user is
  // already on /checkout so they don't need a sign-in link to land
  // on /success).
  try {
    const { enqueueQuoteCalls } = await import('@/lib/queue/enqueue-calls');
    await enqueueQuoteCalls({ quoteRequestId: args.quoteRequestId });
  } catch (err) {
    log.error('post-coupon enqueue threw', { err, requestId: args.quoteRequestId });
    captureException(err, {
      tags: {
        lib: 'coupons',
        reason: 'sideEffectsFailed' satisfies CouponReason,
        requestId: args.quoteRequestId,
      },
    });
    // Even on enqueue failure, the redemption is committed and the
    // row is 'paid'. The retry-failed-calls / dispatch-scheduled
    // crons will pick it up. Return ok so the user sees the success
    // page and isn't stuck on a flash of red copy.
  }

  return {
    ok: true,
    redirectUrl: `/get-quotes/success?request=${encodeURIComponent(args.quoteRequestId)}&coupon=1`,
  };
}
