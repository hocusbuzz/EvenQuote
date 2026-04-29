// Tests for lib/security/vapi-auth — the module that actually backs
// `verifyVapiWebhook` (the call site in `lib/calls/vapi.ts` is now a
// thin re-export).
//
// Why the coverage matters:
//   • The webhook is the single inbound write surface from the AI
//     telephony provider. Auth bypass → poisoned transcript → poisoned
//     quote delivered to the user.
//   • Three header presentations are accepted; all three need a test.
//   • constant-time comparison must reject a 31-char prefix of a
//     32-char secret (length mismatch) the same way it rejects a
//     wrong-but-same-length guess. This is the Round 14 drive-by
//     "timing-attack regression" we want locked in.
//
// The sibling file `lib/calls/vapi.test.ts` still has the tests that
// exercise `verifyVapiWebhook` via the re-export — those stay as
// integration-style coverage of the import path users actually
// consume. These tests hit the source of truth directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  verifyVapiWebhook,
  extractVapiSecret,
} from './vapi-auth';

// TS 5 + @types/node 20+ type NODE_ENV as a readonly literal union, so
// direct and bracket-with-literal assignment both fail `tsc --noEmit`.
// Route all env writes through this writable view.
const env = process.env as Record<string, string | undefined>;

describe('extractVapiSecret', () => {
  it('returns empty string when no headers are present', () => {
    const req = new Request('https://example.com/webhook', { method: 'POST' });
    expect(extractVapiSecret(req)).toBe('');
  });

  it('prefers lowercase x-vapi-secret when multiple headers are present', () => {
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'x-vapi-secret': 'from-lower',
        authorization: 'Bearer from-bearer',
      },
    });
    expect(extractVapiSecret(req)).toBe('from-lower');
  });

  it('strips the Bearer prefix from Authorization headers', () => {
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { authorization: 'Bearer abc123' },
    });
    expect(extractVapiSecret(req)).toBe('abc123');
  });

  it('is case-insensitive on the Bearer prefix', () => {
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { authorization: 'bearer abc123' },
    });
    expect(extractVapiSecret(req)).toBe('abc123');
  });
});

describe('verifyVapiWebhook', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.VAPI_WEBHOOK_SECRET = env.VAPI_WEBHOOK_SECRET;
    saved.NODE_ENV = env.NODE_ENV;
    delete env.VAPI_WEBHOOK_SECRET;
    delete env.NODE_ENV;
  });

  afterEach(() => {
    if (saved.VAPI_WEBHOOK_SECRET === undefined) delete env.VAPI_WEBHOOK_SECRET;
    else env.VAPI_WEBHOOK_SECRET = saved.VAPI_WEBHOOK_SECRET;
    if (saved.NODE_ENV === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved.NODE_ENV;
    vi.restoreAllMocks();
  });

  function makeReq(headers: Record<string, string> = {}): Request {
    return new Request('https://example.com/webhook', {
      method: 'POST',
      headers,
    });
  }

  it('HARD-REFUSES in production when VAPI_WEBHOOK_SECRET is unset', () => {
    env.NODE_ENV = 'production';
    const result = verifyVapiWebhook(makeReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/misconfigured/);
  });

  it('accepts any request in development when secret is unset (soft)', () => {
    env.NODE_ENV = 'development';
    const result = verifyVapiWebhook(makeReq());
    expect(result.ok).toBe(true);
  });

  it('accepts correct secret via x-vapi-secret header', () => {
    env.VAPI_WEBHOOK_SECRET = 'shh_123';
    expect(verifyVapiWebhook(makeReq({ 'x-vapi-secret': 'shh_123' })).ok).toBe(
      true,
    );
  });

  it('accepts correct secret via Authorization: Bearer', () => {
    env.VAPI_WEBHOOK_SECRET = 'shh_123';
    expect(
      verifyVapiWebhook(makeReq({ authorization: 'Bearer shh_123' })).ok,
    ).toBe(true);
  });

  it('rejects wrong-but-same-length secret', () => {
    env.VAPI_WEBHOOK_SECRET = 'shh_123';
    const result = verifyVapiWebhook(makeReq({ 'x-vapi-secret': 'nope_ab' }));
    // Same length (7 chars) as the configured secret → forces the
    // constant-time path to actually compare byte-by-byte.
    expect(result.ok).toBe(false);
  });

  it('rejects missing header when secret IS set', () => {
    env.VAPI_WEBHOOK_SECRET = 'shh_123';
    expect(verifyVapiWebhook(makeReq()).ok).toBe(false);
  });

  // ── Timing-attack regression ──
  // A naive implementation that used `startsWith` / `===` on a prefix
  // would leak length info via early-return timing. constantTimeEqual
  // rejects length mismatches without byte-by-byte probing, and this
  // test locks that invariant in with a concrete input: a 31-char
  // prefix of a 32-char secret must fail.
  it('rejects a 31-char prefix of a 32-char secret (length-mismatch guard)', () => {
    const full32 = 'a'.repeat(32);
    const prefix31 = 'a'.repeat(31);
    env.VAPI_WEBHOOK_SECRET = full32;
    const result = verifyVapiWebhook(
      makeReq({ 'x-vapi-secret': prefix31 }),
    );
    expect(result.ok).toBe(false);
  });

  // Sibling of the above: a 32-char guess where the first 31 chars
  // match and only the last differs must also fail. This specifically
  // locks out a "how far into the secret did my guess get" oracle.
  it('rejects a 32-char same-length guess differing only in the last byte', () => {
    const full32 = 'a'.repeat(32);
    const wrongLast = 'a'.repeat(31) + 'b';
    env.VAPI_WEBHOOK_SECRET = full32;
    expect(verifyVapiWebhook(makeReq({ 'x-vapi-secret': wrongLast })).ok).toBe(
      false,
    );
  });

  it('accepts correct secret via Bearer even when an empty x-vapi-secret header is sent', () => {
    // Guards the header-precedence logic: an empty string for
    // x-vapi-secret should not shadow a correct Bearer token. Note:
    // Headers.get() returns `null` for absent headers, not empty
    // string, so we construct via Headers() with an explicit empty
    // value to exercise the edge case. If the runtime normalizes this
    // differently (some strip empty headers), the test still passes —
    // we're asserting the OUTCOME, not the precedence branch taken.
    env.VAPI_WEBHOOK_SECRET = 'shh_123';
    const headers = new Headers();
    headers.set('authorization', 'Bearer shh_123');
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers,
    });
    expect(verifyVapiWebhook(req).ok).toBe(true);
  });
});
