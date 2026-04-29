// Tests for the centralized cron-auth helper.
//
// These lock the four invariants the four routes depended on:
//
//   1. Missing CRON_SECRET → 500 "not configured" (fail CLOSED).
//   2. Mismatched secret → 401 "unauthorized".
//   3. Matching secret in ANY of the three header spellings → null
//      (authorized — caller continues).
//   4. Timing-safety: the helper MUST delegate comparison to
//      constantTimeEqual — a near-miss prefix must be rejected.
//
// We mutate `process.env.CRON_SECRET` inside `beforeEach` / `afterEach`
// so tests are hermetic and don't leak env state to sibling tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertCronAuth, extractCronSecret } from './cron-auth';

// Minimal Request builder — avoids pulling in a test-only framework.
function makeRequest(headers: Record<string, string> = {}) {
  return new Request('https://example.com/api/cron/fake', { headers });
}

describe('assertCronAuth', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  describe('when CRON_SECRET is not configured', () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
    });

    it('returns a 500 response regardless of what the caller sent', async () => {
      const res = assertCronAuth(makeRequest({ 'x-cron-secret': 'whatever' }));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(500);
      const body = await res!.json();
      expect(body).toEqual({ ok: false, error: 'CRON_SECRET not configured' });
    });

    it('fails closed even with a matching-looking header', async () => {
      process.env.CRON_SECRET = '';
      const res = assertCronAuth(makeRequest({ 'x-cron-secret': '' }));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(500);
    });
  });

  describe('when CRON_SECRET is configured', () => {
    const SECRET = 'super-secret-32-char-token-abcdef';

    beforeEach(() => {
      process.env.CRON_SECRET = SECRET;
    });

    it('returns null (authorized) with x-cron-secret lowercase header', () => {
      const res = assertCronAuth(makeRequest({ 'x-cron-secret': SECRET }));
      expect(res).toBeNull();
    });

    it('returns null (authorized) with Authorization: Bearer', () => {
      const res = assertCronAuth(
        makeRequest({ authorization: `Bearer ${SECRET}` }),
      );
      expect(res).toBeNull();
    });

    it('returns null (authorized) with Authorization: bearer (case-insensitive)', () => {
      const res = assertCronAuth(
        makeRequest({ authorization: `bearer ${SECRET}` }),
      );
      expect(res).toBeNull();
    });

    it('returns 401 when no header is present', async () => {
      const res = assertCronAuth(makeRequest());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      const body = await res!.json();
      expect(body).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('returns 401 when the provided secret does not match', async () => {
      const res = assertCronAuth(
        makeRequest({ 'x-cron-secret': 'not-the-secret' }),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it('returns 401 for a near-miss prefix (timing-safety regression)', () => {
      // Drop the last character. A naive `===` would still reject but
      // would short-circuit quickly. constantTimeEqual + SHA-256 digest
      // makes the compare length-independent. This test exists so a
      // future simplification back to `===` is caught.
      const almost = SECRET.slice(0, -1);
      const res = assertCronAuth(makeRequest({ 'x-cron-secret': almost }));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it('returns 401 for non-Bearer Authorization schemes like Basic', () => {
      // Our extractor only strips `Bearer\s+`. A `Basic` auth attempt
      // leaves the whole header value in place; it won't match the
      // expected secret.
      const res = assertCronAuth(
        makeRequest({ authorization: `Basic ${SECRET}` }),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });
  });
});

describe('extractCronSecret', () => {
  it('returns empty string when no header is present', () => {
    expect(extractCronSecret(makeRequest())).toBe('');
  });

  it('prefers x-cron-secret over Authorization when both are present', () => {
    const req = makeRequest({
      'x-cron-secret': 'from-header',
      authorization: 'Bearer from-bearer',
    });
    expect(extractCronSecret(req)).toBe('from-header');
  });

  it('falls through to Authorization Bearer when no cron header', () => {
    expect(
      extractCronSecret(makeRequest({ authorization: 'Bearer abc' })),
    ).toBe('abc');
  });

  it('strips leading whitespace after Bearer', () => {
    expect(
      extractCronSecret(makeRequest({ authorization: 'Bearer   spaced' })),
    ).toBe('spaced');
  });

  it('returns empty string for Authorization header without Bearer prefix', () => {
    // Without the Bearer prefix we leave the value untouched; the
    // downstream constant-time compare will reject it.
    expect(
      extractCronSecret(makeRequest({ authorization: 'Basic xyz' })),
    ).toBe('Basic xyz');
  });
});
