import { describe, it, expect } from 'vitest';
import { constantTimeEqual } from './constant-time-equal';

describe('constantTimeEqual', () => {
  it('returns true for two identical non-empty strings', () => {
    expect(constantTimeEqual('a-very-long-secret', 'a-very-long-secret')).toBe(true);
  });

  it('returns false for two different non-empty strings of the same length', () => {
    expect(constantTimeEqual('aaaaaaaaaaaa', 'aaaaaaaaaaab')).toBe(false);
  });

  it('returns false for two different-length strings (no length leak)', () => {
    // The function should not throw — internal hash equalises length.
    expect(constantTimeEqual('short', 'longer-string')).toBe(false);
    expect(constantTimeEqual('', 'longer-string')).toBe(false);
  });

  it('returns false when either side is undefined or null', () => {
    expect(constantTimeEqual(undefined, 'x')).toBe(false);
    expect(constantTimeEqual('x', undefined)).toBe(false);
    expect(constantTimeEqual(null, 'x')).toBe(false);
    expect(constantTimeEqual('x', null)).toBe(false);
    expect(constantTimeEqual(undefined, undefined)).toBe(false);
    expect(constantTimeEqual(null, null)).toBe(false);
  });

  it('returns false for two empty strings (defensive — empty secret is a bug)', () => {
    // We could return true here, but an empty expected secret is always
    // a misconfiguration; refusing to authenticate is safer than passing.
    expect(constantTimeEqual('', '')).toBe(false);
  });

  it('handles non-ASCII / multi-byte input without throwing', () => {
    expect(constantTimeEqual('séance', 'séance')).toBe(true);
    expect(constantTimeEqual('séance', 'seance')).toBe(false);
  });

  it('is symmetric (a==b iff b==a) across many random pairs', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['x', ''],
      ['abc', 'abc'],
      ['abc', 'abd'],
      ['short', 'a-much-longer-string-that-is-different'],
    ];
    for (const [a, b] of cases) {
      expect(constantTimeEqual(a, b)).toBe(constantTimeEqual(b, a));
    }
  });

  it('matches direct equality for non-trivial real-world-shaped tokens', () => {
    // 32-char token (typical CRON_SECRET shape).
    const token = 'k7Wq3pZ9xR2nL5vT8yC4dF6gH1jM0bA9';
    expect(constantTimeEqual(token, token)).toBe(true);
    // Single-byte difference at the end.
    const off = token.slice(0, -1) + (token.slice(-1) === 'X' ? 'Y' : 'X');
    expect(constantTimeEqual(token, off)).toBe(false);
    // Single-byte difference at the start.
    const off2 = (token[0] === 'X' ? 'Y' : 'X') + token.slice(1);
    expect(constantTimeEqual(token, off2)).toBe(false);
  });
});
