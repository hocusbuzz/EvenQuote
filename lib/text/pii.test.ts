import { describe, it, expect } from 'vitest';
import { maskEmail } from './pii';

describe('maskEmail', () => {
  it('masks a typical email, keeping first char and full domain', () => {
    expect(maskEmail('biggsontheshow@hotmail.com')).toBe(
      'b*************@hotmail.com'
    );
  });

  it('keeps minimum 3 stars for short local parts', () => {
    // one-char local part → first char + 3 stars
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });

  it('handles two-char local part with the 3-star minimum', () => {
    expect(maskEmail('ab@c.io')).toBe('a***@c.io');
  });

  it('returns null for null, undefined, empty string', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('')).toBeNull();
    expect(maskEmail('   ')).toBeNull();
  });

  it('returns null for strings without @ or with malformed @ placement', () => {
    expect(maskEmail('no-at-sign')).toBeNull();
    expect(maskEmail('@leading-at.com')).toBeNull();
    expect(maskEmail('trailing-at@')).toBeNull();
  });

  it('handles emails with a + tag', () => {
    const result = maskEmail('user+tag@example.com');
    expect(result).toMatch(/^u\*+@example\.com$/);
  });

  it('lowercases nothing on its own — callers are responsible for normalization', () => {
    // The mask preserves the original casing for visual confirmation.
    expect(maskEmail('Alice@Example.Com')).toBe('A****@Example.Com');
  });
});
