// Tests for the assertRateLimit helper.
//
// The underlying token-bucket is already covered in
// `lib/rate-limit.test.ts`. This file only needs to verify the
// NextResponse wrapper contract: 429 status, Retry-After +
// X-RateLimit-Reset headers, body shape, and that a within-limit
// call returns null (not a response).
//
// Each test resets module state by re-importing via `vi.resetModules`
// so adjacent tests don't leak buckets between cases.

import { describe, it, expect, beforeEach, vi } from 'vitest';

function freshModule() {
  // Import lazily after a reset so each test gets its own empty
  // bucket map. The module imports `@/lib/rate-limit` transitively;
  // we need both to be fresh.
  return import('./rate-limit-auth');
}

function req(ip = '203.0.113.7'): Request {
  return new Request('https://example.com/endpoint', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

describe('assertRateLimit', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null on the first request under the limit', async () => {
    const { assertRateLimit } = await freshModule();
    const deny = assertRateLimit(req(), { prefix: 'test', limit: 3 });
    expect(deny).toBeNull();
  });

  it('returns a 429 NextResponse after the limit is exceeded', async () => {
    const { assertRateLimit } = await freshModule();
    const opts = { prefix: 'test', limit: 2 };
    expect(assertRateLimit(req('1.2.3.4'), opts)).toBeNull();
    expect(assertRateLimit(req('1.2.3.4'), opts)).toBeNull();
    const deny = assertRateLimit(req('1.2.3.4'), opts);
    expect(deny).not.toBeNull();
    expect(deny!.status).toBe(429);
  });

  it('sets Retry-After and X-RateLimit-Reset headers on 429', async () => {
    const { assertRateLimit } = await freshModule();
    const opts = { prefix: 'test', limit: 1, windowMs: 10_000 };
    assertRateLimit(req('5.5.5.5'), opts);
    const deny = assertRateLimit(req('5.5.5.5'), opts);
    expect(deny).not.toBeNull();
    const retryAfter = deny!.headers.get('retry-after');
    const reset = deny!.headers.get('x-ratelimit-reset');
    expect(retryAfter).not.toBeNull();
    // Retry-After is a non-negative integer string (seconds).
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(0);
    // Reset is a unix-ms timestamp — must be in the near future.
    expect(Number(reset)).toBeGreaterThan(Date.now() - 1000);
  });

  it('returns { ok: false, error: <message> } in the body', async () => {
    const { assertRateLimit } = await freshModule();
    const opts = { prefix: 'test', limit: 1 };
    assertRateLimit(req('7.7.7.7'), opts);
    const deny = assertRateLimit(req('7.7.7.7'), opts);
    expect(deny).not.toBeNull();
    const body = await deny!.json();
    expect(body).toEqual({ ok: false, error: 'Too many requests' });
  });

  it('honours a custom message on the 429 body (but stays generic)', async () => {
    const { assertRateLimit } = await freshModule();
    const opts = { prefix: 'test', limit: 1, message: 'Slow down' };
    assertRateLimit(req('8.8.8.8'), opts);
    const deny = assertRateLimit(req('8.8.8.8'), opts);
    expect(deny).not.toBeNull();
    const body = await deny!.json();
    expect(body.error).toBe('Slow down');
  });

  it('scopes buckets per-prefix so one route does not eat another route\'s budget', async () => {
    const { assertRateLimit } = await freshModule();
    // Burn through the 'waitlist' budget with limit=1.
    const deniedWaitlist = (() => {
      assertRateLimit(req('9.9.9.9'), { prefix: 'waitlist', limit: 1 });
      return assertRateLimit(req('9.9.9.9'), { prefix: 'waitlist', limit: 1 });
    })();
    expect(deniedWaitlist).not.toBeNull();
    // Same IP, different prefix → still has budget.
    const deniedCheckout = assertRateLimit(req('9.9.9.9'), {
      prefix: 'checkout',
      limit: 1,
    });
    expect(deniedCheckout).toBeNull();
  });

  it('honours an explicit key override, bucketing per user instead of per IP', async () => {
    const { assertRateLimit } = await freshModule();
    const opts = { prefix: 'user-scoped', limit: 1, key: 'user_abc' };
    // Two different IPs, same explicit user key → second call denied.
    assertRateLimit(req('10.0.0.1'), opts);
    const deny = assertRateLimit(req('10.0.0.2'), opts);
    expect(deny).not.toBeNull();
    expect(deny!.status).toBe(429);
  });

  it('separates per-IP buckets when no explicit key is provided', async () => {
    const { assertRateLimit } = await freshModule();
    const opts = { prefix: 'ip-scoped', limit: 1 };
    // Same prefix, different IPs → each gets its own budget.
    expect(assertRateLimit(req('11.11.11.11'), opts)).toBeNull();
    expect(assertRateLimit(req('12.12.12.12'), opts)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// assertRateLimitFromHeaders
// -----------------------------------------------------------------------------
// Server-action variant. Unlike the route-handler version, this one does not
// build a NextResponse — it returns either `null` (allowed) or a
// `RateLimitRefusal` object that the caller translates into whatever return
// shape its server action uses. These tests lock that contract.
//
// The underlying token-bucket is identical (same module-level map), so we
// don't retest bucket math here — only the header-bag adapter + refusal shape.

function hdrs(ip = '203.0.113.8'): Headers {
  // next/headers returns a Headers-like — `.get(name)` is the only method
  // the helper calls. Using a real Headers object keeps the shape honest.
  return new Headers({ 'x-forwarded-for': ip });
}

describe('assertRateLimitFromHeaders', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null on the first request under the limit', async () => {
    const { assertRateLimitFromHeaders } = await freshModule();
    const deny = assertRateLimitFromHeaders(hdrs(), { prefix: 'sa', limit: 3 });
    expect(deny).toBeNull();
  });

  it('returns a RateLimitRefusal object after the limit is exceeded', async () => {
    const { assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'sa', limit: 2 };
    expect(assertRateLimitFromHeaders(hdrs('1.2.3.4'), opts)).toBeNull();
    expect(assertRateLimitFromHeaders(hdrs('1.2.3.4'), opts)).toBeNull();
    const deny = assertRateLimitFromHeaders(hdrs('1.2.3.4'), opts);
    expect(deny).not.toBeNull();
    // Refusal shape is a plain object — server actions can serialize it.
    expect(deny).toEqual({
      retryAfterSec: expect.any(Number),
      resetAt: expect.any(Number),
      message: 'Too many requests',
    });
  });

  it('includes retryAfterSec and resetAt on the refusal for UI countdowns', async () => {
    const { assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'sa', limit: 1, windowMs: 10_000 };
    assertRateLimitFromHeaders(hdrs('5.5.5.5'), opts);
    const deny = assertRateLimitFromHeaders(hdrs('5.5.5.5'), opts);
    expect(deny).not.toBeNull();
    // retryAfterSec is a non-negative integer (seconds) — mirrors HTTP
    // Retry-After semantics so the server action can build a message
    // like "Try again in 9s." without unit conversion.
    expect(deny!.retryAfterSec).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(deny!.retryAfterSec)).toBe(true);
    // resetAt is a unix-ms timestamp — must be in the near future.
    expect(deny!.resetAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('honours a custom message on the refusal (but default stays generic)', async () => {
    const { assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'sa', limit: 1, message: 'Ease up, friend' };
    assertRateLimitFromHeaders(hdrs('8.8.8.8'), opts);
    const deny = assertRateLimitFromHeaders(hdrs('8.8.8.8'), opts);
    expect(deny).not.toBeNull();
    expect(deny!.message).toBe('Ease up, friend');
  });

  it('scopes buckets per-prefix so different server actions do not collide', async () => {
    const { assertRateLimitFromHeaders } = await freshModule();
    // Burn through the waitlist budget.
    assertRateLimitFromHeaders(hdrs('9.9.9.9'), { prefix: 'waitlist', limit: 1 });
    const deniedWaitlist = assertRateLimitFromHeaders(hdrs('9.9.9.9'), {
      prefix: 'waitlist',
      limit: 1,
    });
    expect(deniedWaitlist).not.toBeNull();
    // Same IP, different prefix (e.g. magic-link resend) → still has budget.
    const deniedResend = assertRateLimitFromHeaders(hdrs('9.9.9.9'), {
      prefix: 'magic-link-resend',
      limit: 1,
    });
    expect(deniedResend).toBeNull();
  });

  it('shares the bucket backing store with assertRateLimit on the same prefix+IP', async () => {
    // A client that hits both a route handler and a server action under
    // the same prefix (e.g. one exposes /api/waitlist and the other is
    // a server action called from a form) should contend on the same
    // bucket. Prefixes are the isolation boundary, not transport type.
    const { assertRateLimit, assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'shared', limit: 1 };
    // Route handler consumes the 1 token.
    expect(assertRateLimit(req('6.6.6.6'), opts)).toBeNull();
    // Server action under same prefix + same IP now denied.
    const deny = assertRateLimitFromHeaders(hdrs('6.6.6.6'), opts);
    expect(deny).not.toBeNull();
  });

  it('honours an explicit key override for user-scoped buckets', async () => {
    const { assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'user-sa', limit: 1, key: 'user_xyz' };
    // Two different IPs, same explicit user key → second call denied.
    assertRateLimitFromHeaders(hdrs('10.0.0.1'), opts);
    const deny = assertRateLimitFromHeaders(hdrs('10.0.0.2'), opts);
    expect(deny).not.toBeNull();
  });

  it('falls back to x-real-ip when x-forwarded-for is missing', async () => {
    // next/headers forwards whatever the platform sets. Vercel sets
    // x-forwarded-for; local dev / other platforms may set x-real-ip.
    // Both should key the bucket consistently.
    const { assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'real-ip', limit: 1 };
    const realIpOnly = new Headers({ 'x-real-ip': '13.13.13.13' });
    expect(assertRateLimitFromHeaders(realIpOnly, opts)).toBeNull();
    // Second request from the SAME real-ip (fresh Headers object, same
    // value) hits the same bucket → denied.
    const again = new Headers({ 'x-real-ip': '13.13.13.13' });
    const deny = assertRateLimitFromHeaders(again, opts);
    expect(deny).not.toBeNull();
  });

  it('groups header-less requests under the "unknown" bucket (deny-by-default)', async () => {
    // If both x-forwarded-for and x-real-ip are absent, every such caller
    // shares the "unknown" bucket. This is deliberate — it prevents an
    // attacker from escaping the limiter by stripping headers.
    const { assertRateLimitFromHeaders } = await freshModule();
    const opts = { prefix: 'no-hdr', limit: 1 };
    expect(assertRateLimitFromHeaders(new Headers(), opts)).toBeNull();
    const deny = assertRateLimitFromHeaders(new Headers(), opts);
    expect(deny).not.toBeNull();
  });
});
