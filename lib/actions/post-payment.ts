'use server';

// Post-payment side effects that run from the Stripe webhook.
//
// Primary use: send a magic-link sign-in email to the address the guest
// entered in intake, so they can claim ownership of the quote request
// and (later) view their report / release contact to specific pros.
//
// ── Why we generate + send the email ourselves ─────────────────────
//
// History (all of which broke a real customer test):
//   1. signInWithOtp + flowType:'pkce' (default)  → link uses ?code=,
//      callback's exchangeCodeForSession needs a code_verifier cookie
//      that doesn't exist when the OTP is generated server-side from a
//      webhook. Result: "PKCE code verifier not found in storage."
//      First customer hit on 2026-05-01.
//   2. signInWithOtp + flowType:'implicit'        → link puts tokens in
//      the URL FRAGMENT (#access_token=...) which the server callback
//      cannot read. Result: "Missing authorization code." Same
//      customer, same day, fixing-the-fix.
//   3. (Today) admin.auth.admin.generateLink + send via Resend → the
//      generated `action_link` chain ends with a redirect to our
//      callback with `?token_hash=…&type=magiclink`, which our
//      callback already handles via verifyOtp. No PKCE, no fragment,
//      no Supabase SMTP dependency. This file's responsibility now
//      stops at "build the action link, send the email."
//
// ── Why we send via Resend, not Supabase's built-in OTP email ──────
//   • Single sending surface = single inbox-reputation game. Supabase's
//     outbound has its own deliverability profile separate from our
//     Resend domain — splitting traffic across two senders dilutes
//     both reputations.
//   • Branded subject + body. The Supabase default subject ("Sign in
//     to your account") was misread as "your quotes are ready" by a
//     real customer who'd just paid $9.99 — generic transactional copy
//     is dangerous in a context where the customer is anxiously
//     waiting for the actual product.
//   • One email template surface to test (lib/email/templates.ts).

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';
import { captureException } from '@/lib/observability/sentry';
import { sendEmail } from '@/lib/email/resend';
import { renderMagicLink } from '@/lib/email/templates';

// ── Canonical Sentry tag shape for this lib ──
// Two distinct external surfaces now (was one):
//   - generateLinkFailed  → admin.auth.admin.generateLink returned an
//                            error object. Could be rate-limit, invalid
//                            email, or admin-permission issue.
//   - sendEmailFailed     → Resend returned ok:false (or threw). The
//                            link was generated successfully; this is
//                            specifically the email delivery surface.
//
// Both must stay listed; a regression-guard in post-payment.test.ts
// forbids catch-all reasons.
export type PostPaymentReason = 'generateLinkFailed' | 'sendEmailFailed';

type SendMagicLinkInput = {
  email: string;
  requestId: string;
  /**
   * Friendly first-name greeting in the email body. Pulled from
   * intake_data.contact_name in the webhook caller.
   */
  recipientName?: string | null;
  /**
   * Vertical name for the email subject ("Sign in to track your
   * EvenQuote handyman request"). Optional; falls back to a generic
   * "quote" phrasing.
   */
  categoryName?: string | null;
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
 * Generate a magic-link action URL via Supabase admin and send it
 * via Resend. The link returns through `/auth/callback` (which calls
 * verifyOtp on the `?token_hash=…&type=magiclink` query params) and
 * forwards to `/get-quotes/claim?request=<id>`, which backfills
 * user_id on the payment + quote_request rows.
 *
 * Throws on hard failure. The webhook catches and continues — the
 * payment is already recorded, so a support resend is always possible.
 */
export async function sendPaymentMagicLink(input: SendMagicLinkInput): Promise<void> {
  const { email, requestId } = input;
  if (!email || !requestId) {
    throw new Error('sendPaymentMagicLink: email and requestId required');
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'sendPaymentMagicLink: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  // Service-role client. Default flowType ('pkce') is fine here —
  // generateLink does NOT use PKCE; it returns a token-hash-based
  // action link regardless of the client's flowType setting.
  const adminClient = createSupabaseClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const siteUrl = getSiteUrl();

  // The redirect chain when the user clicks the link:
  //   1. Email link → Supabase /auth/v1/verify?token=<hash>&type=magiclink&redirect_to=…
  //   2. Supabase verifies the token, marks it consumed
  //   3. Redirects to: <siteUrl>/auth/callback?next=…&token_hash=<hash>&type=magiclink
  //   4. Our /auth/callback calls verifyOtp({type, token_hash}) — sets
  //      session cookies — then redirects to the `next` param value.
  //   5. /get-quotes/claim?request=<id> attaches user_id to the row,
  //      then redirects to /get-quotes/success?request=<id>.
  const next = `/get-quotes/claim?request=${encodeURIComponent(requestId)}`;
  const redirectTo = `${siteUrl}/auth/callback?next=${encodeURIComponent(next)}`;

  // 1. Generate the action link (no email sent here — Supabase only
  //    generates + persists the OTP token).
  const { data: linkData, error: linkErr } =
    await adminClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: {
        redirectTo,
      },
    });

  if (linkErr || !linkData?.properties?.action_link) {
    const msg = linkErr?.message ?? 'generateLink returned no action_link';
    const wrapped = new Error(`generateLink failed: ${msg}`);
    captureException(wrapped, {
      tags: { lib: 'post-payment', reason: 'generateLinkFailed', requestId },
    });
    throw wrapped;
  }

  // ── Rewrite action_link to go through our /auth/verify proxy ──
  //
  // Supabase's generateLink returns:
  //   https://<project>.supabase.co/auth/v1/verify?token=…&type=…&redirect_to=…
  //
  // The host (<project>.supabase.co) doesn't match our sending domain
  // (evenquote.com). Resend's deliverability insights flag this as a
  // top-tier spam signal: "Mismatched URLs can trigger spam filters."
  // Hotmail/Outlook quarantine these aggressively.
  //
  // The Supabase Custom Domain feature (auth.evenquote.com) is the
  // native fix but requires Pro plan ($25/mo). Cheaper equivalent:
  // route the email link through evenquote.com/auth/verify, which
  // 302-redirects to the real Supabase verify endpoint with identical
  // query params (see app/auth/verify/route.ts for the proxy). User-
  // visible link domain matches sending domain → no spam signal,
  // no plan upgrade.
  //
  // We fall back to the raw action_link if NEXT_PUBLIC_APP_URL is
  // unset (local dev that doesn't need the rewrite).
  const proxiedActionLink = (() => {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) return linkData.properties.action_link;
    try {
      const orig = new URL(linkData.properties.action_link);
      return `${appUrl.replace(/\/$/, '')}/auth/verify${orig.search}`;
    } catch {
      // Defensive: if Supabase's response shape changes and the
      // action_link isn't a valid URL, fall back to the raw value
      // rather than break magic-link sends entirely.
      return linkData.properties.action_link;
    }
  })();

  // 2. Send the email ourselves via Resend with our branded template.
  //    tag: 'magic-link' shows up in Resend's dashboard for filtering
  //    bounce / complaint stats by send type.
  const rendered = renderMagicLink({
    recipientName: input.recipientName ?? null,
    actionLink: proxiedActionLink,
    categoryName: input.categoryName ?? null,
  });

  const send = await sendEmail({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'magic-link',
  });

  if (!send.ok) {
    const wrapped = new Error(`magic-link email send failed: ${send.error}`);
    captureException(wrapped, {
      tags: { lib: 'post-payment', reason: 'sendEmailFailed', requestId },
    });
    throw wrapped;
  }
}
