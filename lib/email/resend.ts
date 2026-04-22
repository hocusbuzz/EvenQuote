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
  if (!client) {
    const fakeId = `sim_email_${Math.random().toString(36).slice(2, 12)}`;
    const toPreview = Array.isArray(input.to) ? input.to.join(', ') : input.to;
    console.log(
      `[email] simulated send → ${toPreview} — subject="${input.subject}" id=${fakeId}${
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
      return {
        ok: false,
        simulated: false,
        error: `${res.error.name}: ${res.error.message}`,
      };
    }
    if (!res.data?.id) {
      return { ok: false, simulated: false, error: 'Resend response missing id' };
    }
    return { ok: true, id: res.data.id, simulated: false };
  } catch (err) {
    return {
      ok: false,
      simulated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
