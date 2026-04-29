'use server';

// Post-payment side effects that run from the Stripe webhook.
//
// Primary use: send a magic link to the email the guest entered in intake,
// so they can sign in and claim ownership of the quote request.
//
// Why a magic link and not Google OAuth?
//   Because we don't know what account they have. Sending them to a
//   one-click email link is frictionless AND locks the claim to the
//   same email Stripe charged — no account-confusion edge cases.
//
// Why is this a "server action" file rather than a plain lib fn?
//   Purely for consistency with our action/ directory convention; the
//   webhook calls this from Node context, not from a <form> action.
//   Marking it 'use server' is harmless and future-proofs if we ever
//   want to invoke it from a client retry button.

import { createAdminClient } from '@/lib/supabase/admin';
import { headers } from 'next/headers';
import { captureException } from '@/lib/observability/sentry';

// ── Canonical Sentry tag shape for this lib ──
// R30 audit: this file has exactly ONE external call (signInWithOtp),
// so there is exactly ONE capture reason. Kept as a string-literal
// union for parity with resend.ts / intake.ts / checkout.ts — any new
// capture site must be added here AND to the regression-guard in
// post-payment.test.ts that forbids catch-all reasons.
//
// Deliberately NOT captured elsewhere in this file:
//   - Input validation (email/requestId empty) — user error; capturing
//     would flood Sentry on malformed webhook payloads.
//   - createAdminClient() env-missing throw — config state at boot;
//     propagates to the webhook route's outer try/catch.
//   - headers() fallback — already wrapped in try/catch with sane
//     default; not an incident.
export type PostPaymentReason = 'signInWithOtp';

type MagicLinkInput = {
  email: string;
  requestId: string;
};

function getSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  }
  // The webhook runs server-side with request headers available. If we're
  // called from a different context without headers, fall back to localhost.
  try {
    const h = headers();
    const proto = h.get('x-forwarded-proto') ?? 'http';
    const host = h.get('host') ?? 'localhost:3000';
    return `${proto}://${host}`;
  } catch {
    return 'http://localhost:3000';
  }
}

/**
 * Trigger a Supabase magic-link email to `email`. The link returns through
 * /auth/callback and forwards to /get-quotes/claim?request=<id>, which
 * backfills user_id on the payment and quote_request rows for this user.
 *
 * Admin client note: signInWithOtp is on supabase.auth which exists on both
 * cookie and service-role clients. Using the service-role client is fine
 * here — auth OTP doesn't depend on RLS, it just dispatches an email via
 * Supabase's SMTP config. We pick service-role so this works in the webhook
 * context (no cookies available).
 */
export async function sendPaymentMagicLink(input: MagicLinkInput): Promise<void> {
  const { email, requestId } = input;
  if (!email || !requestId) {
    throw new Error('sendPaymentMagicLink: email and requestId required');
  }

  const admin = createAdminClient();
  const siteUrl = getSiteUrl();

  // The "next" landing after callback = the claim route, which does
  //   UPDATE payments  SET user_id=<me>, claimed_at=now() WHERE quote_request_id=<id>
  //   UPDATE quote_requests SET user_id=<me> WHERE id=<id>
  // and redirects to the success page.
  const next = `/get-quotes/claim?request=${encodeURIComponent(requestId)}`;
  const emailRedirectTo = `${siteUrl}/auth/callback?next=${encodeURIComponent(next)}`;

  const { error } = await admin.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo,
      // Create an auth user if one doesn't exist. We use email-only auth,
      // so this is the expected path for first-time buyers.
      shouldCreateUser: true,
    },
  });

  if (error) {
    // Rate limits and SMTP failures surface here. Upstream caller (the
    // webhook) logs and continues — the payment row is already saved,
    // so a support resend is always possible.
    //
    // Capture at the lib boundary with lib+reason tags so the error
    // tracker sees EVERY caller's failures, not just the stripe webhook
    // route that already wraps this call. A future support/retry-button
    // caller or manual-resend admin action gets the same coverage for
    // free. Sentry dedupes on error fingerprint — route-level captures
    // in callers still add route context as separate tag sets; they
    // don't double-count.
    //
    // We do NOT include the raw email here. Logger.ts redacts email-
    // shaped strings from payloads, and Sentry gets the error object
    // only — tags are opinionated structured metadata.
    const wrapped = new Error(`signInWithOtp failed: ${error.message}`);
    captureException(wrapped, {
      tags: { lib: 'post-payment', reason: 'signInWithOtp', requestId },
    });
    throw wrapped;
  }
}
