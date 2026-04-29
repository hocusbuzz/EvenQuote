// Centralized Stripe webhook authentication.
//
// The Stripe webhook (/api/stripe/webhook) is the single inbound write
// surface from Stripe. If an attacker can forge a request that passes
// verification, they can:
//   • Insert a 'completed' payment row for a quote_request they never
//     paid for → trigger the full call-enqueue side effect.
//   • Flip a quote_request from pending_payment to paid for free.
// Both land on the service-role Supabase client.
//
// This module does three things:
//   1. Reads STRIPE_WEBHOOK_SECRET from env.
//   2. Pulls the `stripe-signature` header (the only spelling Stripe
//      emits — no header-variant dance like cron or vapi).
//   3. Delegates the actual HMAC verification to the Stripe SDK's
//      `stripe.webhooks.constructEvent`, which already uses a
//      constant-time comparison internally (verified by reading the
//      SDK source; they explicitly call `crypto.timingSafeEqual`).
//
// Why we keep a helper around a one-liner SDK call:
//   • Parallelism: cron-auth, dev-token-auth, vapi-auth, rate-limit-auth
//     all live here. Grouping Stripe with them means future ops work
//     ("how does this service authenticate webhooks?") has one place
//     to look.
//   • Error mapping: the SDK throws on misconfig, missing signature,
//     and verify-failure in three different shapes. This helper
//     collapses them to the `{ ok, error?, status? }` discriminated
//     union the route handler wants.
//   • Lockdown surface: adding it to `lib/security/exports.test.ts`
//     catches silent renames.
//
// NOTE the contract asymmetry with cron-auth + rate-limit-auth:
//   • Those return `NextResponse | null`.
//   • This returns `{ ok, event?, error?, status? }` because the
//     webhook route needs the parsed Stripe.Event on the ok path, not
//     just a "keep going" signal. Returning both would force the
//     caller to unwrap two shapes; one is cleaner.
//
// Backwards compatibility: none needed — `app/api/stripe/webhook/route.ts`
// inlined the logic, there are no external callers to migrate.

import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('stripe-auth');

export type VerifyStripeWebhookResult =
  | { ok: true; event: Stripe.Event }
  | { ok: false; status: 400 | 500; error: string };

/**
 * Extract the `stripe-signature` header from a webhook request.
 *
 * Exported separately so tests and a future logger can inspect what
 * the caller sent without going through the full verification dance.
 * Returns an empty string when the header is absent — `constructEvent`
 * will then throw a SignatureVerificationError, which maps to 400.
 */
export function extractStripeSignature(req: Request): string {
  return req.headers.get('stripe-signature') ?? '';
}

/**
 * Verify a Stripe webhook request against `STRIPE_WEBHOOK_SECRET`.
 *
 * On success, returns `{ ok: true, event }` with the parsed Stripe.Event.
 * On failure, returns `{ ok: false, status, error }` where status is:
 *   • 500 — secret not configured (fail CLOSED; never silently accept)
 *   • 400 — missing signature header OR HMAC mismatch (stop Stripe's
 *           retry loop; tampered / wrong-secret events will not fix
 *           themselves on retry)
 *
 * Usage:
 *
 *   export async function POST(req: NextRequest) {
 *     const raw = await req.text();
 *     const auth = await verifyStripeWebhook(req, raw);
 *     if (!auth.ok) {
 *       return NextResponse.json({ error: auth.error }, { status: auth.status });
 *     }
 *     const { event } = auth;
 *     // …authorized path…
 *   }
 *
 * IMPORTANT: the caller MUST pass the raw request body (the string
 * from `await req.text()`), NOT a re-serialized JSON object. The HMAC
 * is computed over exact bytes; whitespace / key-ordering differences
 * break verification.
 */
export async function verifyStripeWebhook(
  req: Request,
  rawBody: string,
): Promise<VerifyStripeWebhookResult> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Fail CLOSED. An unconfigured secret would otherwise turn the
    // webhook into an unauthenticated write surface against the
    // service-role Supabase client.
    log.error('STRIPE_WEBHOOK_SECRET is not set');
    return { ok: false, status: 500, error: 'Webhook misconfigured' };
  }

  const signature = extractStripeSignature(req);
  if (!signature) {
    return {
      ok: false,
      status: 400,
      error: 'Missing stripe-signature header',
    };
  }

  const stripe = getStripe();
  try {
    // Stripe SDK's constructEvent performs the HMAC-SHA256 comparison
    // internally via crypto.timingSafeEqual — we get constant-time
    // comparison for free.
    const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    return { ok: true, event };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'signature verification failed';
    log.error('signature verification failed', { err: msg });
    // 400 so Stripe stops retrying tampered/bad events rather than
    // hammering us. Legitimate retry on genuine network flake would
    // present a valid signature on the next delivery.
    return {
      ok: false,
      status: 400,
      error: `Invalid signature: ${msg}`,
    };
  }
}
