// Centralized Vapi webhook authentication.
//
// The Vapi webhook (/api/vapi/webhook) is the single inbound write
// surface from the AI telephony provider. If an attacker can forge a
// request that passes verification, they can:
//   • Inject arbitrary transcript text into extract-quote → poisoned
//     quotes land in the user-visible report.
//   • Mark an in-flight call as ended with fake end-reason data.
// Both would land in the service-role Supabase path (admin client).
//
// So this module does three things:
//   1. Reads VAPI_WEBHOOK_SECRET from env.
//   2. Accepts three header presentations (x-vapi-secret / X-Vapi-Secret
//      / Authorization: Bearer) — Vapi's Server Configuration UI uses
//      different names for legacy vs. current credential types.
//   3. Compares via constantTimeEqual to block length-oracle +
//      char-index timing attacks.
//
// Why this lives under lib/security/* (alongside cron-auth and
// dev-token-auth) rather than under lib/calls/ (where the rest of the
// Vapi client lives): verification is a security concern, not a
// telephony one. Grouping with the other auth helpers means:
//   • The "every security helper" surface (`lib/security/exports.test.ts`)
//     includes it → a silent rename gets caught.
//   • Call sites have one place to look for "how does this service
//     authenticate inbound webhooks?".
//   • The webhook test surface sits next to the security tests, not
//     tangled with the outbound-call-dispatch tests.
//
// NOTE the contract asymmetry with cron-auth/dev-token-auth:
//   • cron-auth + dev-token-auth return `NextResponse | null`.
//   • This module returns `{ ok, error? }` because the Vapi webhook
//     route builds its own 401 response (log format is webhook-
//     specific and includes the Vapi event payload shape). A
//     NextResponse wrapper would force the caller to unwrap + rebuild.
//
// Backwards compatibility: `lib/calls/vapi.ts` re-exports
// `verifyVapiWebhook` from here so existing imports keep working.

import { createLogger } from '@/lib/logger';
import { constantTimeEqual } from './constant-time-equal';

const log = createLogger('vapi-auth');

export type VerifyVapiWebhookResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Extract the Vapi-provided secret from a webhook request.
 *
 * Exported separately so tests and a future logger can inspect what
 * the caller sent without going through the full auth dance. Returns
 * an empty string when all four channels are absent — the caller's
 * `constantTimeEqual` check will then reject that against the
 * configured secret.
 *
 * Lookup precedence:
 *   1. `?token=` URL query param — load-bearing fallback because Vapi
 *      silently drops `assistantOverrides.server.headers` AND
 *      `assistantOverrides.server.secret` from per-call configuration
 *      (only `server.url` is honored). The smoke test on 2026-04-29
 *      proved it: webhooks arrived with only `Content-Type` and
 *      `Accept-Encoding` headers, no auth, even when we passed both
 *      `server.headers.Authorization` and `server.secret`. Putting the
 *      token in the URL guarantees Vapi can't strip it.
 *   2. `x-vapi-secret`        — lowercased variant (assistant-level
 *                               credential, when applied — but the
 *                               assistant-level credential UI selection
 *                               also doesn't propagate to webhook
 *                               deliveries reliably).
 *   3. `X-Vapi-Secret`        — defensive duplicate for proxies that
 *                               don't normalize header casing.
 *   4. `Authorization: Bearer …` — current "Bearer Token" credential
 *                                  shape (when honored).
 */
export function extractVapiSecret(req: Request): string {
  // 1. URL query param — primary, since Vapi can't strip URL params.
  let queryToken = '';
  try {
    queryToken = new URL(req.url).searchParams.get('token') ?? '';
  } catch {
    // URL parse failures shouldn't blow up auth — fall through to
    // header-based lookups.
  }
  if (queryToken) return queryToken;

  // 2-4. Header-based lookups (legacy / belt-and-suspenders).
  const bearer = (req.headers.get('authorization') ?? '').replace(
    /^Bearer\s+/i,
    '',
  );
  return (
    req.headers.get('x-vapi-secret') ??
    req.headers.get('X-Vapi-Secret') ??
    bearer ??
    ''
  );
}

/**
 * Verify a Vapi webhook. See module-level comment for the contract.
 *
 * Usage:
 *
 *   export async function POST(req: Request) {
 *     const auth = verifyVapiWebhook(req);
 *     if (!auth.ok) {
 *       return NextResponse.json({ ok: false, error: auth.error }, { status: 401 });
 *     }
 *     // …authorized path…
 *   }
 */
export function verifyVapiWebhook(req: Request): VerifyVapiWebhookResult {
  const expected = process.env.VAPI_WEBHOOK_SECRET;

  // ── No secret configured ──
  // In production we HARD-REFUSE. A missing secret would otherwise
  // silently turn the webhook into an unauthenticated write surface
  // against the service-role Supabase client.
  //
  // In non-prod we accept without verification so local dev + CI keep
  // working. We log loudly so the operator notices before shipping.
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      log.error(
        'VAPI_WEBHOOK_SECRET is not set in production — refusing to accept request',
      );
      return { ok: false, error: 'Webhook misconfigured: secret not set' };
    }
    log.warn(
      'VAPI_WEBHOOK_SECRET not set — DEV MODE, accepting without verification',
    );
    return { ok: true };
  }

  // Constant-time compare — prevents timing-side-channel secret
  // recovery when an attacker can probe the webhook with many guesses.
  // constantTimeEqual rejects length-mismatched inputs cheaply without
  // leaking which length matched, so a 31-char prefix of a 32-char
  // secret fails the same way a fully-wrong guess does.
  if (!constantTimeEqual(extractVapiSecret(req), expected)) {
    return {
      ok: false,
      error:
        'Invalid or missing auth header (expected x-vapi-secret or Authorization: Bearer)',
    };
  }
  return { ok: true };
}
