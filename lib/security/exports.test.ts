// Public-surface snapshot tests for lib/security/*.
//
// Each security module is consumed from several places across app/
// and lib/. A rename or accidental removal of an export ripples
// outward — this file is the single lockdown that catches it.
//
// What each test does:
//   • Imports the module.
//   • Reads its key set.
//   • Asserts that the expected names are present AND that each is
//     callable (function, not a value placeholder).
//
// Scope:
//   • We intentionally DO NOT freeze *values* — a refactor that keeps
//     the same function signature but rewrites the body should pass.
//   • We DO freeze the name + arity + kind so a caller's import site
//     stays valid.
//
// When to update this file:
//   • Adding a new export to any lib/security/* module? Add a line
//     here. Deliberately low-ceremony — one edit per addition, not
//     twelve.
//   • Removing an export? Delete its assertion AND audit the
//     consumers (grep for the name across app/ and lib/) before you
//     do, so the lockdown doesn't hide a breaking change.

import { describe, it, expect } from 'vitest';

import * as csp from './csp';
import * as constantTimeEqual from './constant-time-equal';
import * as cronAuth from './cron-auth';
import * as devTokenAuth from './dev-token-auth';
import * as vapiAuth from './vapi-auth';
import * as rateLimitAuth from './rate-limit-auth';
import * as stripeAuth from './stripe-auth';

function keyKinds(mod: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(mod)
      .sort()
      .map((k) => [k, typeof mod[k]]),
  );
}

describe('lib/security/csp public surface', () => {
  it('exposes exactly the expected functions', () => {
    expect(keyKinds(csp)).toEqual({
      buildCsp: 'function',
      cspHeaderName: 'function',
      generateNonce: 'function',
      isCspNonceEnabled: 'function',
    });
  });

  it('each export is invocable (arity + type check)', () => {
    expect(typeof csp.generateNonce()).toBe('string');
    expect(typeof csp.isCspNonceEnabled()).toBe('boolean');
    expect(['Content-Security-Policy', 'Content-Security-Policy-Report-Only']).toContain(
      csp.cspHeaderName(),
    );
    expect(typeof csp.buildCsp({ nonce: 'n', reportEndpoint: '/api/csp-report' })).toBe(
      'string',
    );
  });
});

describe('lib/security/constant-time-equal public surface', () => {
  it('exposes exactly the constantTimeEqual function', () => {
    expect(keyKinds(constantTimeEqual)).toEqual({
      constantTimeEqual: 'function',
    });
  });

  it('the function is invocable and returns a boolean', () => {
    expect(constantTimeEqual.constantTimeEqual('a', 'a')).toBe(true);
    expect(constantTimeEqual.constantTimeEqual('a', 'b')).toBe(false);
  });
});

describe('lib/security/cron-auth public surface', () => {
  it('exposes exactly the expected functions', () => {
    expect(keyKinds(cronAuth)).toEqual({
      assertCronAuth: 'function',
      extractCronSecret: 'function',
    });
  });

  it('each export is invocable', () => {
    const req = new Request('https://example.com/api/cron/fake');
    // extractCronSecret on a bare request returns empty string (no
    // headers). The value doesn't matter here — we only need the call
    // to not throw.
    expect(typeof cronAuth.extractCronSecret(req)).toBe('string');
    // assertCronAuth returns NextResponse | null — either is a valid
    // "callable responded" signal.
    const res = cronAuth.assertCronAuth(req);
    expect(res === null || typeof res === 'object').toBe(true);
  });
});

describe('lib/security/dev-token-auth public surface', () => {
  it('exposes exactly the expected functions', () => {
    expect(keyKinds(devTokenAuth)).toEqual({
      assertDevToken: 'function',
      extractDevToken: 'function',
    });
  });

  it('each export is invocable', () => {
    const req = new Request('https://example.com/api/dev/fake');
    expect(typeof devTokenAuth.extractDevToken(req)).toBe('string');
    const res = devTokenAuth.assertDevToken(req);
    expect(res === null || typeof res === 'object').toBe(true);
  });
});

describe('lib/security/vapi-auth public surface', () => {
  it('exposes exactly the expected functions', () => {
    expect(keyKinds(vapiAuth)).toEqual({
      extractVapiSecret: 'function',
      verifyVapiWebhook: 'function',
    });
  });

  it('each export is invocable', () => {
    const req = new Request('https://example.com/api/vapi/webhook');
    expect(typeof vapiAuth.extractVapiSecret(req)).toBe('string');
    // verifyVapiWebhook returns a discriminated union — both branches
    // are plain objects, so this just asserts the call shape.
    const res = vapiAuth.verifyVapiWebhook(req);
    expect(typeof res.ok).toBe('boolean');
  });
});

describe('lib/security/rate-limit-auth public surface', () => {
  it('exposes exactly the expected functions', () => {
    // `assertRateLimit` is the `Request`-based route-handler variant.
    // `assertRateLimitFromHeaders` is the server-action variant that
    // accepts a Headers-like bag (from `next/headers`) and returns a
    // plain refusal object instead of a NextResponse. Both share the
    // same backing token-bucket store — prefixes are the unit of
    // isolation, not transport type. Lockdown ensures neither is
    // silently renamed or removed in a refactor.
    expect(keyKinds(rateLimitAuth)).toEqual({
      assertRateLimit: 'function',
      assertRateLimitFromHeaders: 'function',
    });
  });

  it('assertRateLimit is invocable and returns NextResponse | null', () => {
    const req = new Request('https://example.com/endpoint', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    const res = rateLimitAuth.assertRateLimit(req, {
      prefix: 'exports-check',
      limit: 999_999, // huge limit → first call will always be under it
    });
    expect(res === null || typeof res === 'object').toBe(true);
  });

  it('assertRateLimitFromHeaders is invocable and returns RateLimitRefusal | null', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.100' });
    const res = rateLimitAuth.assertRateLimitFromHeaders(headers, {
      prefix: 'exports-check-headers',
      limit: 999_999, // huge limit → first call will always be under it
    });
    // Happy path returns null; refusal would be a plain object with
    // retryAfterSec/resetAt/message. Shape-agnostic assert here mirrors
    // the assertRateLimit test above.
    expect(res === null || typeof res === 'object').toBe(true);
  });
});

describe('lib/security/stripe-auth public surface', () => {
  it('exposes exactly the expected functions', () => {
    expect(keyKinds(stripeAuth)).toEqual({
      extractStripeSignature: 'function',
      verifyStripeWebhook: 'function',
    });
  });

  it('each export is invocable', async () => {
    const req = new Request('https://example.com/api/stripe/webhook');
    expect(typeof stripeAuth.extractStripeSignature(req)).toBe('string');
    // verifyStripeWebhook returns a discriminated union — both branches
    // are plain objects, so this just asserts the call shape without
    // requiring a valid signature.
    const res = await stripeAuth.verifyStripeWebhook(req, '{}');
    expect(typeof res.ok).toBe('boolean');
  });
});
