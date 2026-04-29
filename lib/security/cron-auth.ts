// Centralized CRON_SECRET authentication.
//
// Four routes previously duplicated the exact same 15-line pattern:
//   • /api/cron/send-reports
//   • /api/cron/retry-failed-calls
//   • /api/cron/check-status
//   • /api/status
//
// Each read `CRON_SECRET` from env, extracted a token from one of three
// header spellings, and compared via `constantTimeEqual()`. This helper
// folds that into one call so that adding a fifth auth'd route means
// writing one line, and so that any future change (e.g. accepting a new
// header, logging failed attempts, adding jitter) happens in exactly
// one place.
//
// Contract:
//   • Returns `null` when the request is authorized → call site
//     continues.
//   • Returns a `NextResponse` when the request is NOT authorized →
//     call site returns it directly.
//
// Status semantics (unchanged from what the four routes were doing):
//   • 500 when CRON_SECRET is not configured (fail CLOSED — we never
//     want an unconfigured secret to silently become "no auth needed").
//   • 401 when the provided token does not match.
//
// Accepted header spellings (exact order the old routes used):
//   1. `x-cron-secret`          — what pg_cron + pg_net sets
//   2. `X-Cron-Secret`          — defensive duplicate for reverse-proxy
//                                 normalizers that don't lowercase
//   3. `Authorization: Bearer …` — what Vercel Cron's native wiring used
//
// This file does NOT depend on `next/server` for the request type —
// it accepts the standard `Request` so route handlers written against
// either `Request` or `NextRequest` work interchangeably.

import { NextResponse } from 'next/server';
import { constantTimeEqual } from './constant-time-equal';

/**
 * Pull the cron secret from an inbound request's headers.
 *
 * Exported separately so tests and a future logger can inspect
 * what the caller sent without going through the full auth dance.
 */
export function extractCronSecret(req: Request): string {
  return (
    req.headers.get('x-cron-secret') ??
    req.headers.get('X-Cron-Secret') ??
    (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  );
}

/**
 * Assert that `req` carries a valid CRON_SECRET. Returns a response to
 * send on failure, or `null` to signal "keep going" on success.
 *
 * Usage:
 *
 *   async function handle(req: Request) {
 *     const deny = assertCronAuth(req);
 *     if (deny) return deny;
 *     // …authorized path…
 *   }
 */
export function assertCronAuth(req: Request): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }
  if (!constantTimeEqual(extractCronSecret(req), expected)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    );
  }
  return null;
}
