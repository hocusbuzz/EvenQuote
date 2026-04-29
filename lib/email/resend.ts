// Minimal Resend client for transactional mail.
//
// Feature-flagged like the Vapi client: if RESEND_API_KEY isn't set we
// log the outbound email and return a fake id instead of sending, so
// local dev and CI never touch a mail provider.
//
// Environment:
//   - RESEND_API_KEY         required for real sends
//   - RESEND_FROM            default "EvenQuote <reports@evenquote.com>"
//   - EVENQUOTE_SUPPORT_EMAIL for reply-to (defaults to support@evenquote.com)

import 'server-only';
import { Resend } from 'resend';
import { redactPII } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

// ── Canonical Sentry tag shape for this lib ──
// Mirrors the R26 extract-quote.ts / R28 checkout.ts convention of one
// reason per distinct failure mode so Sentry's facet search groups the
// three send paths separately:
//   - sendApiErrored         → provider returned { error } object (validation,
//                              rate limit, bounce, domain-not-verified, etc)
//   - sendResponseMissingId  → provider success with no id (shape drift)
//   - sendTransportFailed    → raw throw: DNS, TLS, socket reset, timeout
//
// A single 'sendFailed' reason (R20) silently merged all three and meant
// alert rules couldn't distinguish "Resend is down" from "we fat-fingered
// a from address". Any new reason must be added here AND to the
// regression-guard in resend.test.ts that forbids catch-alls.
export type ResendReason =
  | 'sendApiErrored'
  | 'sendResponseMissingId'
  | 'sendTransportFailed';

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  /** Plain-text fallback. Clients that can't render HTML still get readable content. */
  text?: string;
  /** Override the default `from` for special senders (e.g. per-business). */
  from?: string;
  /** Override the default reply-to. */
  replyTo?: string;
  /** Opaque tag for Resend's dashboard filtering (e.g. 'quote-report'). */
  tag?: string;
};

export type SendEmailResult =
  | { ok: true; id: string; simulated: false }
  | { ok: true; id: string; simulated: true; reason: string }
  | { ok: false; simulated: false; error: string };

let _client: Resend | null = null;

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_client) _client = new Resend(key);
  return _client;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const client = getClient();
  const from = input.from ?? process.env.RESEND_FROM ?? 'EvenQuote <reports@evenquote.com>';
  const replyTo =
    input.replyTo ?? process.env.EVENQUOTE_SUPPORT_EMAIL ?? 'support@evenquote.com';

  // Simulation mode — log + return a fake id. Keeps the pipeline runnable
  // without burning Resend credit on a dev laptop.
  //
  // R47.4: HARD REFUSE in production. Without this guard, send-reports
  // and contact-release silently stamp report_sent_at /
  // contact_released_at while no email actually ships — the worst
  // possible failure mode for a paid product. validateServerEnv()
  // catches missing RESEND_API_KEY at boot, but this is the second
  // line of defense at the dispatch surface in case validation is
  // bypassed.
  if (!client) {
    if (process.env.NODE_ENV === 'production') {
      const tag = input.tag ?? 'unknown';
      console.error(
        `[email] refusing to simulate in production (tag=${tag}) — RESEND_API_KEY is missing`
      );
      return {
        ok: false,
        simulated: false,
        error: 'RESEND_API_KEY not set in production — email simulation forbidden',
      };
    }
    const fakeId = `sim_email_${Math.random().toString(36).slice(2, 12)}`;
    const toPreview = Array.isArray(input.to) ? input.to.join(', ') : input.to;
    // Redact the recipient in logs — even in simulation mode we don't
    // want real addresses in log retention for staging envs that
    // occasionally run without RESEND_API_KEY set.
    console.log(
      `[email] simulated send → ${redactPII(toPreview)} — subject="${input.subject}" id=${fakeId}${
        input.tag ? ` tag=${input.tag}` : ''
      }`
    );
    return {
      ok: true,
      id: fakeId,
      simulated: true,
      reason: 'RESEND_API_KEY not set',
    };
  }

  // Every failure path reports through a shared tag-builder so the shape
  // is identical across SDK-level errors, malformed-response errors, and
  // transport exceptions — only the `reason` differs. Lib-boundary
  // capture means callers — the quote-report sender, the magic-link
  // path, future support-resend — all get observability coverage without
  // wrapping each call site. Route handlers that invoke sendEmail() may
  // add their own tags (e.g. `route: '/api/webhook/stripe'`) on top;
  // Sentry dedupes on error fingerprint so both facets coexist without
  // double-counting.
  //
  // PII contract: we pass `{ lib, reason, emailTag }` only. `emailTag` is
  // the opaque `kind` marker the caller already sends to Resend (e.g.
  // 'quote-report', 'magic-link') — not the recipient address. The
  // recipient is NEVER tagged; Sentry tag values are indexed for search
  // and would survive scrubbers that target message bodies.
  const tagsFor = (reason: ResendReason): Record<string, string> => ({
    lib: 'resend',
    reason,
    ...(input.tag ? { emailTag: input.tag } : {}),
  });

  try {
    const res = await client.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo,
      tags: input.tag ? [{ name: 'kind', value: input.tag }] : undefined,
    });

    if (res.error) {
      // Resend's SDK returns a structured error object rather than throwing.
      // Wrap it in a real Error so Sentry's stack-trace grouping works.
      // Controlled prefix (`Resend sendApiErrored:`) stabilizes fingerprints
      // so provider rewording doesn't spawn new Sentry issues per deploy.
      const wrapped = new Error(
        `Resend sendApiErrored: ${res.error.name}: ${res.error.message}`
      );
      captureException(wrapped, { tags: tagsFor('sendApiErrored') });
      return {
        ok: false,
        simulated: false,
        error: `${res.error.name}: ${res.error.message}`,
      };
    }
    if (!res.data?.id) {
      // Defensive: Resend has never returned this shape, but if it ever
      // does we want an alert rather than a silent drop.
      const wrapped = new Error('Resend sendResponseMissingId');
      captureException(wrapped, { tags: tagsFor('sendResponseMissingId') });
      return { ok: false, simulated: false, error: 'Resend response missing id' };
    }
    return { ok: true, id: res.data.id, simulated: false };
  } catch (err) {
    // Transport layer: DNS, TLS, socket reset, timeout. Always a real
    // Error from the SDK/fetch; wrap the non-Error case for consistency.
    const wrapped = err instanceof Error ? err : new Error(String(err));
    captureException(wrapped, { tags: tagsFor('sendTransportFailed') });
    return {
      ok: false,
      simulated: false,
      error: wrapped.message,
    };
  }
}
