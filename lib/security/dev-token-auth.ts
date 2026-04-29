// Centralized dev-route authentication.
//
// Two dev-only routes previously duplicated the same two-layer auth:
//   • /api/dev/trigger-call
//   • /api/dev/backfill-call
//
// Each:
//   1. Hard-refused when NODE_ENV === 'production' (404).
//   2. If DEV_TRIGGER_TOKEN was set, required a matching `?token=` via
//      `constantTimeEqual()`.
//
// This helper folds that pair into one call so that a third dev route
// adds one line instead of fifteen, and so any future change
// (accepting a header instead of a query param, logging failed
// attempts, widening to additional non-prod NODE_ENVs) happens in
// exactly one place.
//
// Contract (mirrors lib/security/cron-auth.ts):
//   • Returns `null` when the request is authorized → caller continues.
//   • Returns a `NextResponse` when the request is NOT authorized →
//     caller returns it directly.
//
// Status semantics (unchanged from what the two routes were doing):
//   • 404 in production — behaves as if the route doesn't exist, so an
//     accidental prod deploy doesn't leak the dev surface's existence
//     (no 401/403 probe signal).
//   • 401 when DEV_TRIGGER_TOKEN is set and the provided `?token=`
//     does not match.
//   • `null` when:
//       - NODE_ENV is not 'production' AND either DEV_TRIGGER_TOKEN is
//         unset OR the provided token matches (constant-time).
//
// NOTE the asymmetry with cron-auth: there we fail CLOSED if
// CRON_SECRET is missing because the cron helper's whole job is to
// authenticate. Here, the token is an *additional* gate layered on
// top of the NODE_ENV gate — the NODE_ENV check alone is already a
// hard refusal in prod. Missing DEV_TRIGGER_TOKEN in dev is a
// deliberate ergonomic default so the browser-address-bar workflow
// keeps working locally.

import { NextResponse } from 'next/server';
import { constantTimeEqual } from './constant-time-equal';

/**
 * Pull the dev token from an inbound request's URL. Exported
 * separately so tests can exercise the extraction in isolation and a
 * future telemetry layer can log what was sent without going through
 * the full auth dance.
 *
 * Returns an empty string when `?token=` is absent — the caller's
 * `constantTimeEqual` check will reject that.
 */
export function extractDevToken(req: Request): string {
  try {
    const url = new URL(req.url);
    return url.searchParams.get('token') ?? '';
  } catch {
    // new URL() throws on malformed input; treat as "no token".
    return '';
  }
}

/**
 * Assert that `req` is allowed to reach a dev-only route. Returns a
 * response to send on failure, or `null` to signal "keep going" on
 * success.
 *
 * Usage:
 *
 *   export async function GET(req: Request) {
 *     const deny = assertDevToken(req);
 *     if (deny) return deny;
 *     // …dev-only path…
 *   }
 */
export function assertDevToken(req: Request): NextResponse | null {
  // ── Layer 1: NODE_ENV gate ──
  // Fails as a 404 rather than 401/403 so an accidental prod deploy
  // gives no probe signal that the dev route exists.
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { ok: false, error: 'Dev route is disabled in production' },
      { status: 404 },
    );
  }

  // ── Layer 2: required-on-remote shared-secret gate ──
  //
  // R47.4: previously, DEV_TRIGGER_TOKEN was OPTIONAL when NODE_ENV
  // was anything other than 'production'. That was fine on a
  // laptop, but exposed every /api/dev/* route wide-open on any
  // staging / preview / `*.vercel.app` deploy that wasn't the live
  // prod env. Anyone who found the URL could:
  //   • POST /api/dev/skip-payment with any quote_request_id and
  //     get the full call pipeline to fire on someone else's row
  //   • GET  /api/dev/trigger-call to dial a contractor at will
  //   • GET  /api/dev/backfill-call to mutate call state
  //
  // New rule: if the request is reaching us OVER THE INTERNET (host
  // is not a localhost/private-network address), DEV_TRIGGER_TOKEN
  // is REQUIRED — even outside production. Localhost loopback
  // requests can still skip the token (laptop dev workflow keeps
  // working unchanged).
  const expectedToken = process.env.DEV_TRIGGER_TOKEN?.trim();
  const isLocal = isLocalRequest(req);

  if (!isLocal && !expectedToken) {
    // Remote env without a token configured = wide-open dev route.
    // Refuse with 403 (not 404 — the route DOES exist on remote
    // dev, ops just can't authenticate it). The 403 also tells the
    // operator: "set DEV_TRIGGER_TOKEN if you want this exposed."
    return NextResponse.json(
      {
        ok: false,
        error:
          'DEV_TRIGGER_TOKEN must be set for non-localhost dev routes. ' +
          'Set the env var or call from localhost.',
      },
      { status: 403 },
    );
  }

  if (expectedToken) {
    if (!constantTimeEqual(extractDevToken(req), expectedToken)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid or missing ?token= for DEV_TRIGGER_TOKEN' },
        { status: 401 },
      );
    }
  }

  return null;
}

/**
 * Determine whether the request is reaching us from a localhost /
 * private-network address. We inspect the Host header (which Next.js
 * sets from the inbound URL) and check for the standard local
 * patterns. Anything outside that set is treated as remote.
 *
 * Loopback patterns matched:
 *   • localhost (any port)
 *   • 127.0.0.1 (any port)
 *   • ::1 (any port, IPv6 loopback)
 *
 * Not currently treated as local (could be in the future if needed):
 *   • RFC1918 ranges (10.*, 192.168.*, 172.16-31.*) — a developer's
 *     LAN-exposed dev server could be reached at 192.168.1.10:3000
 *     without the token. Acceptable because that's a deliberate
 *     exposure step, not an accidental public surface.
 */
function isLocalRequest(req: Request): boolean {
  let host = '';
  try {
    host = new URL(req.url).host;
  } catch {
    return false;
  }
  // Strip port for the comparison.
  const hostnameOnly = host.split(':')[0];
  if (hostnameOnly === 'localhost') return true;
  if (hostnameOnly === '127.0.0.1') return true;
  if (hostnameOnly === '[::1]') return true;
  if (hostnameOnly === '::1') return true;
  return false;
}
