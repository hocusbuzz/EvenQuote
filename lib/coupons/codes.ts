// Coupon code generator.
//
// Codes are 12 random characters drawn from a no-confusion alphabet
// (drops 0/O/1/I/L/etc.) formatted as 3 groups of 4 separated by
// hyphens for readability — e.g. `K9XP-2RBA-VTQF` (15 chars total).
// Entropy ≈ 12 chars × log2(31) ≈ 59 bits, far past brute-force
// territory for a low-rate-limit lookup endpoint.
//
// We use crypto.randomBytes (Node) for the entropy source, NOT
// Math.random — Math.random is predictable and would let a determined
// attacker enumerate codes given a seed leak. crypto.randomBytes is
// CSPRNG-backed (OpenSSL) and the right primitive for any "should
// not be guessable" string.
//
// Exported so scripts/mint-coupons.ts and any future admin UI both
// produce the same shape. Tests lock the format.

import { randomBytes } from 'node:crypto';

// 31 chars — drops 0/O, 1/I/L, no lowercase to avoid case-confusion
// when the operator reads + dictates a code over the phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SEGMENT_LEN = 4;
const SEGMENTS = 3;
const TOTAL_CHARS = SEGMENT_LEN * SEGMENTS; // 12

/**
 * Generate a single random coupon code in the canonical
 * `XXXX-XXXX-XXXX` shape. Each call uses fresh CSPRNG bytes.
 */
export function generateCouponCode(): string {
  // randomBytes(N) gives N bytes (0-255 each). We map each byte to
  // an alphabet index by modulo. Modulo bias is acceptable here:
  // 256 % 31 = 8, so chars 0-7 of ALPHABET are very slightly more
  // likely than 8-30. The bias amounts to <0.04 bits of entropy
  // loss per char which is negligible for our threat model.
  const bytes = randomBytes(TOTAL_CHARS);
  let out = '';
  for (let i = 0; i < TOTAL_CHARS; i += 1) {
    if (i > 0 && i % SEGMENT_LEN === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Validate that a string LOOKS like a coupon code (right shape,
 * right alphabet). Cheap pre-check before hitting the DB — if the
 * shape is wrong, the user typo'd and we can short-circuit with a
 * clearer error than "not_found". Does NOT prove the code exists.
 */
export function isWellFormedCouponCode(s: string): boolean {
  // Pattern: ^[ALPHABET]{4}-[ALPHABET]{4}-[ALPHABET]{4}$
  // Build it dynamically so a future ALPHABET edit only changes one constant.
  const re = new RegExp(`^[${ALPHABET}]{${SEGMENT_LEN}}(-[${ALPHABET}]{${SEGMENT_LEN}}){${SEGMENTS - 1}}$`);
  return re.test(s);
}

/**
 * Normalize a user-supplied code: uppercase + trim + strip stray
 * whitespace. Customers WILL paste with a trailing space or in
 * lowercase. Keep the alphabet upper-only at the lookup boundary.
 */
export function normalizeCouponCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    // Strip everything that isn't alphanumeric or hyphen.
    .replace(/[^A-Z0-9-]/g, '');
}
