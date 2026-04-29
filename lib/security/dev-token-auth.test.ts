// Tests for the centralized dev-token-auth helper.
//
// Locks the same invariants both dev routes depended on:
//
//   1. In production → 404 regardless of token (no probe signal).
//   2. In dev, no DEV_TRIGGER_TOKEN → null (authorized).
//   3. In dev, DEV_TRIGGER_TOKEN set but `?token=` missing or wrong → 401.
//   4. In dev, DEV_TRIGGER_TOKEN set and matching → null (authorized).
//   5. Timing-safety: near-miss prefix must be rejected by constantTimeEqual.
//   6. Token comparison uses the post-trim value (`.trim()` mirrored).
//
// We save NODE_ENV and DEV_TRIGGER_TOKEN on entry and restore on exit so
// tests are hermetic and don't leak env state to sibling files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertDevToken, extractDevToken } from './dev-token-auth';

// Writable view to bypass TS's readonly narrowing of NODE_ENV. This is
// the same pattern used in app/api/dev/trigger-call/route.test.ts.
const ENV = process.env as Record<string, string | undefined>;

function makeRequest(url: string = 'https://example.com/api/dev/fake') {
  return new Request(url);
}

describe('assertDevToken', () => {
  const ENV_KEYS = ['NODE_ENV', 'DEV_TRIGGER_TOKEN'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = ENV[k];
    for (const k of ENV_KEYS) delete ENV[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete ENV[k];
      else ENV[k] = saved[k];
    }
  });

  describe('in production', () => {
    beforeEach(() => {
      ENV.NODE_ENV = 'production';
    });

    it('returns 404 even with no token configured', async () => {
      const res = assertDevToken(makeRequest());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(404);
      const body = await res!.json();
      expect(body).toEqual({ ok: false, error: 'Dev route is disabled in production' });
    });

    it('returns 404 even with a matching token (no probe signal)', async () => {
      // Critical invariant: the response MUST be 404, not 401. A 401
      // would tell a prod probe "this route exists, keep guessing."
      ENV.DEV_TRIGGER_TOKEN = 'real-token';
      const res = assertDevToken(
        makeRequest('https://example.com/api/dev/fake?token=real-token'),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(404);
    });
  });

  describe('in development, DEV_TRIGGER_TOKEN not configured', () => {
    beforeEach(() => {
      ENV.NODE_ENV = 'development';
      delete ENV.DEV_TRIGGER_TOKEN;
    });

    // R47.4: rule split — laptop dev still works without a token,
    // but anything reaching us over the internet (any non-localhost
    // host) requires a token even in dev. The localhost-friendly
    // tests use http://localhost; the new "remote without token"
    // tests use a public-shaped host.

    it('returns null (authorized) with no query params on localhost', () => {
      expect(
        assertDevToken(new Request('http://localhost:3000/api/dev/fake')),
      ).toBeNull();
    });

    it('returns null (authorized) on 127.0.0.1 loopback', () => {
      expect(
        assertDevToken(new Request('http://127.0.0.1:3000/api/dev/fake')),
      ).toBeNull();
    });

    it('returns null (authorized) even with an unexpected ?token= query on localhost', () => {
      // No DEV_TRIGGER_TOKEN means the second layer is off — any
      // ?token= value is ignored on local-only requests.
      expect(
        assertDevToken(
          new Request('http://localhost:3000/api/dev/fake?token=whatever'),
        ),
      ).toBeNull();
    });

    it('returns 403 for a remote (non-localhost) request without a token', async () => {
      // R47.4: closing the previously-open dev surface on
      // staging / preview / *.vercel.app URLs.
      const res = assertDevToken(makeRequest());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(403);
      const body = await res!.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/DEV_TRIGGER_TOKEN/);
    });
  });

  describe('in development, DEV_TRIGGER_TOKEN configured', () => {
    const TOKEN = 'super-secret-dev-token-32chars-abc';

    beforeEach(() => {
      ENV.NODE_ENV = 'development';
      ENV.DEV_TRIGGER_TOKEN = TOKEN;
    });

    it('returns null (authorized) with matching ?token=', () => {
      const res = assertDevToken(
        makeRequest(`https://example.com/api/dev/fake?token=${TOKEN}`),
      );
      expect(res).toBeNull();
    });

    it('returns 401 when ?token= is missing', async () => {
      const res = assertDevToken(makeRequest());
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
      const body = await res!.json();
      expect(body).toEqual({
        ok: false,
        error: 'Invalid or missing ?token= for DEV_TRIGGER_TOKEN',
      });
    });

    it('returns 401 when ?token= does not match', async () => {
      const res = assertDevToken(
        makeRequest('https://example.com/api/dev/fake?token=wrong-token'),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it('returns 401 for a near-miss prefix (timing-safety regression)', () => {
      // Drop the last character. Locks that a future refactor back to
      // `===` is caught — constantTimeEqual + SHA-256 digest makes
      // the compare length-independent on the matched path.
      const almost = TOKEN.slice(0, -1);
      const res = assertDevToken(
        makeRequest(`https://example.com/api/dev/fake?token=${almost}`),
      );
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it('trims surrounding whitespace on the expected token', () => {
      // `.trim()` on the expected is deliberate — if the operator
      // accidentally wraps the .env value in quotes or adds a stray
      // newline, the compare would otherwise silently always fail.
      ENV.DEV_TRIGGER_TOKEN = `  ${TOKEN}  `;
      const res = assertDevToken(
        makeRequest(`https://example.com/api/dev/fake?token=${TOKEN}`),
      );
      expect(res).toBeNull();
    });
  });
});

describe('extractDevToken', () => {
  it('returns empty string when no token param is present', () => {
    expect(extractDevToken(makeRequest())).toBe('');
  });

  it('returns the token value when present', () => {
    expect(
      extractDevToken(makeRequest('https://example.com/api/dev/fake?token=abc')),
    ).toBe('abc');
  });

  it('returns empty string on a malformed URL', () => {
    // Extremely defensive — if Next's Request somehow surfaces a
    // non-absolute URL, new URL() throws. The helper swallows that.
    // We can't easily construct a real malformed Request, so we stub.
    const fake = { url: 'not-a-url' } as unknown as Request;
    expect(extractDevToken(fake)).toBe('');
  });

  it('returns empty string for ?token= (empty value)', () => {
    expect(
      extractDevToken(makeRequest('https://example.com/api/dev/fake?token=')),
    ).toBe('');
  });
});
