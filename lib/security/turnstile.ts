// Cloudflare Turnstile — invisible CAPTCHA, env-gated activation.
//
// WHAT IT IS
// ──────────
// Turnstile is Cloudflare's bot-detection challenge — primarily
// invisible to real users (it analyzes mouse movements, browser
// fingerprints, IP reputation), with a fallback interactive checkbox
// for genuinely suspicious sessions. Free for unlimited use, no
// signup beyond a Cloudflare account.
//
// WHEN IT'S ACTIVE
// ────────────────
// Both env vars must be set:
//   • NEXT_PUBLIC_TURNSTILE_SITE_KEY — public, baked into client bundle
//   • TURNSTILE_SECRET_KEY            — server-only, used to verify tokens
//
// When EITHER is missing the entire Turnstile path is a no-op:
//   • Client widget renders nothing
//   • Server verification returns ok:true
// This keeps local dev / preview deploys / staging frictionless.
// Production must set both for the protection to actually fire.
//
// WHAT IT CATCHES
// ───────────────
// Sophisticated bots that the honeypot + rate-limit miss:
//   • Headless browsers (Puppeteer, Playwright) without Turnstile cookies
//   • Datacenter / VPN IPs with bad reputation
//   • Sessions with no human-like interaction (no mouse movement, no
//     timing jitter, no scroll events)
//
// LAYERING
// ────────
// Turnstile is the LAST line of defense, not the first:
//   1. Honeypot (free, instant) → catches lazy bots
//   2. Per-IP rate limit (free, instant) → catches flooding
//   3. Per-email rate limit (free, instant) → catches multi-IP abuse
//   4. Turnstile (free, ~50ms server round-trip) → catches sophisticated bots
//
// We check Turnstile AFTER the cheaper checks so 99% of abuse never
// touches Cloudflare's API at all.

import { createLogger } from '@/lib/logger';

const log = createLogger('turnstile');

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Returns true if Turnstile is fully configured (both env vars
 * present). Callers can short-circuit setup work when this is false.
 */
export function isTurnstileConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY &&
      process.env.TURNSTILE_SECRET_KEY,
  );
}

/**
 * Public site key (or null when not configured). Safe to bake into
 * the client bundle — the secret key is server-only.
 */
export function turnstileSiteKey(): string | null {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;
}

export type VerifyResult =
  | { ok: true; reason?: never }
  | { ok: false; reason: string };

/**
 * Verify a Turnstile token returned by the client widget.
 *
 * NO-OP IN DEV / STAGING: when env vars are missing, returns ok:true
 * so the action proceeds. Production deploys must set both env vars
 * for this to actually verify anything — featureReadiness in lib/env.ts
 * surfaces missing keys.
 *
 * Failures are NOT thrown — analytics / form submissions must not be
 * broken by a Turnstile outage. We log + return ok:false with a
 * specific reason; the caller decides whether to soft-allow or hard-
 * block on outages.
 */
export async function verifyTurnstileToken(args: {
  /** The token from `data-cf-turnstile-response` on the client. */
  token: string | null | undefined;
  /** Optional: client IP for stricter scoring (Vercel header). */
  remoteIp?: string | null;
}): Promise<VerifyResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Not configured — soft-allow.
    return { ok: true };
  }

  const token = args.token?.trim();
  if (!token) {
    // Configured BUT no token submitted — that's a fail, not a no-op.
    // The client widget should have produced one. Likely a bot that
    // skipped the widget entirely.
    return { ok: false, reason: 'missing-token' };
  }

  // Cloudflare expects application/x-www-form-urlencoded.
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (args.remoteIp) body.set('remoteip', args.remoteIp);

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body,
      // Keepalive so a serverless function shutting down right after
      // the call doesn't drop the request.
      keepalive: true,
    });
    if (!res.ok) {
      log.warn('turnstile verify HTTP error', { status: res.status });
      // Soft-allow on transport errors. The honeypot + rate limits
      // still ran first; we'd rather let a real customer through than
      // hard-block on Cloudflare's downtime.
      return { ok: true };
    }
    const json = (await res.json()) as {
      success?: boolean;
      'error-codes'?: string[];
    };
    if (json.success === true) return { ok: true };
    return {
      ok: false,
      reason: (json['error-codes'] ?? ['verify-failed']).join(','),
    };
  } catch (err) {
    log.warn('turnstile verify threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    // Same soft-allow rationale as the non-2xx branch above.
    return { ok: true };
  }
}
