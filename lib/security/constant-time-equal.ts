// Constant-time string comparison.
//
// All webhook + cron secret checks (CRON_SECRET, VAPI_WEBHOOK_SECRET,
// DEV_TRIGGER_TOKEN, BACKFILL_TOKEN, etc.) MUST go through this helper
// instead of the language-native `===` / `!==`.
//
// Why this matters:
//   • A naive string comparison short-circuits on the first mismatched
//     byte. Across many requests, an attacker can detect the timing
//     difference between "first byte wrong" vs "first ten bytes right"
//     and progressively recover the secret.
//   • Node's `crypto.timingSafeEqual` compares the full Buffer in
//     constant time relative to length. The Buffers MUST be the same
//     length, so we hash both sides first — that turns any input into
//     a fixed-length 32-byte SHA-256 digest, side-stepping the
//     length-leak vector entirely (an attacker can't probe length by
//     sending different-length tokens).
//
// This helper is intentionally null-safe: passing `undefined` or `null`
// returns `false` (rather than throwing) so callers can chain it
// directly after env / header lookups without a noisy null guard.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets in constant time. Safe to call with arbitrary
 * (possibly undefined / different-length) inputs.
 *
 * Returns `true` only when both inputs are non-empty strings and their
 * SHA-256 digests are byte-identical. Hashing equalises length so the
 * underlying `timingSafeEqual` never throws and the wall-clock cost
 * does not depend on where the inputs first diverge.
 */
export function constantTimeEqual(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  // SHA-256 → 32-byte Buffer; timingSafeEqual needs equal-length inputs.
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
