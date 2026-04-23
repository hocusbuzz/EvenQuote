import { describe, it, expect } from 'vitest';
import { redactPII, fingerprintError } from './logger';

describe('redactPII', () => {
  it('masks emails preserving first char and domain', () => {
    const out = redactPII('user signed up with alice@example.com today');
    expect(out).toContain('a***@example.com');
    expect(out).not.toContain('alice@example.com');
  });

  it('masks a US phone number', () => {
    const out = redactPII('called 415-555-0100 successfully');
    expect(out).toContain('[phone]');
    expect(out).not.toContain('415-555-0100');
  });

  it('masks multiple emails in one string', () => {
    const out = redactPII('from alice@a.com to bob@b.com');
    expect(out).not.toContain('alice@a.com');
    expect(out).not.toContain('bob@b.com');
    expect(out).toContain('@a.com');
    expect(out).toContain('@b.com');
  });

  it('is a no-op on empty strings', () => {
    expect(redactPII('')).toBe('');
  });

  it('leaves non-PII text alone', () => {
    expect(redactPII('nothing to see here')).toBe('nothing to see here');
  });

  it('handles E.164 international format', () => {
    const out = redactPII('phone: +14155550100');
    expect(out).toContain('[phone]');
  });

  it('does NOT redact UUIDs as phone numbers (regression guard)', () => {
    // UUID digit-runs previously triggered the phone regex and came out
    // as `[phone]-1111-[phone]11111`, destroying traceability for
    // request ids in logs. Hex-hyphen boundaries must skip the match.
    const uuid = '11111111-1111-1111-1111-111111111111';
    const out = redactPII(`requestId=${uuid} failed`);
    expect(out).toContain(uuid);
    expect(out).not.toContain('[phone]');
  });

  it('does NOT redact a lowercase-hex UUID', () => {
    const uuid = 'a1b2c3d4-5e6f-7890-abcd-1234567890ef';
    const out = redactPII(`requestId=${uuid}`);
    expect(out).toContain(uuid);
    expect(out).not.toContain('[phone]');
  });

  it('still redacts a phone that appears immediately after a UUID', () => {
    // Adjacency check: UUID then space then phone must still mask the
    // phone, because the whitespace separator breaks the hex boundary.
    const line = 'req=11111111-1111-1111-1111-111111111111 phone 415-555-0100';
    const out = redactPII(line);
    expect(out).toContain('[phone]');
    expect(out).toContain('11111111-1111-1111-1111-111111111111');
  });
});

describe('fingerprintError', () => {
  // Helper: build an Error with a fixed stack so tests don't depend on the
  // actual test-runner call-site layout.
  function withStack(name: string, stack: string): Error {
    const err = new Error('msg-does-not-matter');
    err.name = name;
    err.stack = stack;
    return err;
  }

  it('returns an 8-char hex string', () => {
    const fp = fingerprintError(new Error('boom'));
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable across calls with the same error shape', () => {
    const stack = [
      'TypeError: cannot read foo',
      '    at handler (/Users/a/p/lib/calls/engine.ts:42:9)',
      '    at runMicrotasks (<anonymous>)',
    ].join('\n');
    const a = fingerprintError(withStack('TypeError', stack));
    const b = fingerprintError(withStack('TypeError', stack));
    expect(a).toBe(b);
  });

  it('ignores dynamic data in the message — same stack, different message → same fp', () => {
    // This is the whole point of fingerprinting. Messages with user ids /
    // row ids must not fragment the catalog.
    const stack = [
      'Error: user user_111 not found',
      '    at load (/Users/a/p/lib/actions/intake.ts:88:13)',
    ].join('\n');
    const a = withStack('Error', stack);
    const b = withStack('Error', stack.replace('user_111', 'user_999'));
    expect(fingerprintError(a)).toBe(fingerprintError(b));
  });

  it('ignores absolute-path prefix churn (build env / host difference)', () => {
    // Same file basename on two different machines should collide.
    const stackA = 'at handler (/Users/antonio/p/lib/calls/engine.ts:42:9)';
    const stackB = 'at handler (/vercel/path0/lib/calls/engine.ts:42:9)';
    const a = withStack('TypeError', `TypeError: x\n    ${stackA}`);
    const b = withStack('TypeError', `TypeError: x\n    ${stackB}`);
    expect(fingerprintError(a)).toBe(fingerprintError(b));
  });

  it('ignores line/column churn from tiny edits', () => {
    // Insert a blank line above the failing line → :43: instead of :42:.
    // Fingerprint must not churn.
    const a = withStack(
      'TypeError',
      'TypeError: x\n    at handler (/p/lib/x.ts:42:9)',
    );
    const b = withStack(
      'TypeError',
      'TypeError: x\n    at handler (/p/lib/x.ts:53:9)',
    );
    expect(fingerprintError(a)).toBe(fingerprintError(b));
  });

  it('produces different fingerprints for different error names at the same site', () => {
    const stack = 'X: foo\n    at handler (/p/lib/x.ts:42:9)';
    const a = withStack('TypeError', stack.replace('X', 'TypeError'));
    const b = withStack('RangeError', stack.replace('X', 'RangeError'));
    expect(fingerprintError(a)).not.toBe(fingerprintError(b));
  });

  it('produces different fingerprints for errors in different files', () => {
    const a = withStack('Error', 'Error: x\n    at f (/p/lib/a.ts:1:1)');
    const b = withStack('Error', 'Error: x\n    at f (/p/lib/b.ts:1:1)');
    expect(fingerprintError(a)).not.toBe(fingerprintError(b));
  });

  it('respects the `frames` option (deeper frames should not change the hash)', () => {
    // Same top-3 frames, different 4th frame. With frames=3, fp must match.
    const topThree = [
      'Error: x',
      '    at a (/p/lib/a.ts:1:1)',
      '    at b (/p/lib/b.ts:1:1)',
      '    at c (/p/lib/c.ts:1:1)',
    ];
    const stackA = [...topThree, '    at d (/p/lib/d.ts:1:1)'].join('\n');
    const stackB = [...topThree, '    at e (/p/lib/e.ts:1:1)'].join('\n');
    const a = withStack('Error', stackA);
    const b = withStack('Error', stackB);
    expect(fingerprintError(a, 3)).toBe(fingerprintError(b, 3));
    // But default depth (5) picks them up as distinct.
    expect(fingerprintError(a)).not.toBe(fingerprintError(b));
  });

  it('handles a missing stack gracefully', () => {
    const err = new Error('boom');
    err.stack = undefined;
    const fp = fingerprintError(err);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles non-Error values without throwing', () => {
    expect(fingerprintError('just a string')).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprintError(null)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprintError(undefined)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprintError({ code: 'ENOENT' })).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles error-shaped objects with name/stack but not instanceof Error', () => {
    // e.g. an err returned by a Promise.reject of a plain object.
    const shaped = {
      name: 'TypeError',
      stack: 'TypeError: x\n    at handler (/p/lib/x.ts:42:9)',
    };
    const real = withStack('TypeError', shaped.stack);
    expect(fingerprintError(shaped)).toBe(fingerprintError(real));
  });
});
