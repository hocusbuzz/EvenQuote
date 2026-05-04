// Tests for the coupon code generator + validator.

import { describe, it, expect } from 'vitest';
import {
  generateCouponCode,
  isWellFormedCouponCode,
  normalizeCouponCode,
} from './codes';

describe('generateCouponCode', () => {
  it('returns the canonical XXXX-XXXX-XXXX shape (14 chars total, 12 alpha + 2 hyphens)', () => {
    const code = generateCouponCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).toHaveLength(14);
  });

  it('uses only the no-confusion alphabet (no 0/O, 1/I/L, lowercase)', () => {
    // Run a batch — the bias filter has to catch any forbidden char
    // in 1000 codes' worth of output (12000 char draws).
    const codes = Array.from({ length: 1000 }, generateCouponCode);
    for (const c of codes) {
      expect(c).not.toMatch(/[0O1IL]/);
      expect(c).not.toMatch(/[a-z]/);
    }
  });

  it('returns a different code on each call (no reused entropy)', () => {
    // Birthday-paradox math says collisions in 1000 draws on a
    // 31^12 ≈ 8e17 space are vanishingly unlikely. If this ever
    // fails, the CSPRNG seeding is broken.
    const codes = new Set(Array.from({ length: 1000 }, generateCouponCode));
    expect(codes.size).toBe(1000);
  });
});

describe('isWellFormedCouponCode', () => {
  it('accepts a freshly-generated code', () => {
    expect(isWellFormedCouponCode(generateCouponCode())).toBe(true);
  });

  it('rejects lowercase, hyphenless, wrong-segment-length, forbidden-alphabet inputs', () => {
    expect(isWellFormedCouponCode('abcd-1234-5678')).toBe(false); // lowercase + 0/1
    expect(isWellFormedCouponCode('ABCD12345678')).toBe(false); // no hyphens
    expect(isWellFormedCouponCode('ABC-XYZ-DEF-GHJ')).toBe(false); // 3-char segments
    expect(isWellFormedCouponCode('AB0D-EFGH-JKMN')).toBe(false); // 0 not in alphabet
    expect(isWellFormedCouponCode('ABCD-EFGH-JKMI')).toBe(false); // I not in alphabet
    expect(isWellFormedCouponCode('')).toBe(false);
    expect(isWellFormedCouponCode('not a code')).toBe(false);
  });
});

describe('normalizeCouponCode', () => {
  it('uppercases + trims + strips non-alnum/hyphen so the lookup is forgiving of paste artifacts', () => {
    expect(normalizeCouponCode('  k9xp-2rba-vtqf  ')).toBe('K9XP-2RBA-VTQF');
    expect(normalizeCouponCode('K9XP–2RBA–VTQF')).toBe('K9XP2RBAVTQF'); // em-dash stripped
    expect(normalizeCouponCode('K9XP 2RBA VTQF')).toBe('K9XP2RBAVTQF'); // nbsp stripped
  });
});
