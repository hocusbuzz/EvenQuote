import { describe, it, expect } from 'vitest';
import { normalizeToE164 } from './phone';

describe('normalizeToE164', () => {
  it('accepts various NANP formats', () => {
    expect(normalizeToE164('+1 415-555-0100')).toBe('+14155550100');
    expect(normalizeToE164('(415) 555-0100')).toBe('+14155550100');
    expect(normalizeToE164('415.555.0100')).toBe('+14155550100');
    expect(normalizeToE164('4155550100')).toBe('+14155550100');
    expect(normalizeToE164('1-415-555-0100')).toBe('+14155550100');
    expect(normalizeToE164('+1-415-555-0100')).toBe('+14155550100');
  });

  it('returns null for empty, null, or undefined', () => {
    expect(normalizeToE164(null)).toBeNull();
    expect(normalizeToE164(undefined)).toBeNull();
    expect(normalizeToE164('')).toBeNull();
    expect(normalizeToE164('   ')).toBeNull();
  });

  it('rejects numbers that do not match NANP format', () => {
    // area code starts with 1 — invalid NANP
    expect(normalizeToE164('115-555-0100')).toBeNull();
    // too short
    expect(normalizeToE164('555-0100')).toBeNull();
    // non-US international
    expect(normalizeToE164('+44 20 7946 0958')).toBeNull();
    // garbage
    expect(normalizeToE164('not-a-phone')).toBeNull();
  });

  it('rejects exchange code starting with 0 or 1', () => {
    // exchange starts with 0
    expect(normalizeToE164('415-055-0100')).toBeNull();
    // exchange starts with 1
    expect(normalizeToE164('415-155-0100')).toBeNull();
  });
});
