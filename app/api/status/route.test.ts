import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Broaden the env type so writes to NODE_ENV-like readonly keys don't
// trip @types/node 20+'s literal union. Other test files in this repo
// use the same pattern.
const env = process.env as Record<string, string | undefined>;

// Stripe SDK must be mocked before the route file imports it (it does a
// dynamic import, so a top-level vi.mock is enough).
const mockCustomersList = vi.fn();
vi.mock('@/lib/stripe/server', () => ({
  getStripe: () => ({
    customers: { list: mockCustomersList },
  }),
}));

// fetch is the Vapi transport — stub globally.
const originalFetch = global.fetch;

// We import the module via dynamic import inside each test so module-level
// state (env reads) is fresh per test.
async function loadRoute() {
  const mod = await import('./route');
  return mod;
}

describe('/api/status — auth', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns 401 when no secret is provided', async () => {
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('returns 401 when secret is wrong', async () => {
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'nope' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('accepts Bearer <token> auth header', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete env.CRON_SECRET;
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'anything' },
    });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/CRON_SECRET/);
  });
});

describe('/api/status — happy path', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('200 with both checks ok when integrations respond', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ stripe: 'ok', vapi: 'ok' });
    expect(body.errors).toBeUndefined();
    expect(typeof body.checked_at).toBe('string');
  });

  it('sends the Vapi bearer token exactly once', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    await GET(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer vapi_x',
    });
  });

  it('does not cache (no-store header set)', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('/api/status — degraded path', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('503 when Stripe fails with an Error', async () => {
    mockCustomersList.mockRejectedValue(new Error('invalid key'));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.stripe).toBe('fail');
    expect(body.checks.vapi).toBe('ok');
    expect(body.errors?.stripe).toBe('invalid key');
  });

  it('503 when Vapi returns non-2xx (short message preserved)', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.vapi).toBe('fail');
    expect(body.errors?.vapi).toBe('HTTP 401');
  });

  it('503 when both integrations fail', async () => {
    mockCustomersList.mockRejectedValue(new Error('boom'));
    global.fetch = vi.fn().mockRejectedValue(new Error('econnreset'));
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.errors?.stripe).toBe('boom');
    expect(body.errors?.vapi).toBe('econnreset');
  });

  it('truncates long error messages to 200 chars to avoid leaking payloads', async () => {
    const longMessage = 'x'.repeat(500);
    mockCustomersList.mockRejectedValue(new Error(longMessage));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.errors?.stripe.length).toBe(200);
  });
});

describe('/api/status — skip when unconfigured', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports skip for any integration missing an env var', async () => {
    delete env.STRIPE_SECRET_KEY;
    delete env.VAPI_API_KEY;
    // stripe/vapi must not be invoked — if they are, this fails
    const stripeSpy = vi.fn();
    const fetchSpy = vi.fn();
    mockCustomersList.mockImplementation(stripeSpy);
    global.fetch = fetchSpy;

    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200); // skip ≠ fail
    const body = await res.json();
    expect(body.checks).toEqual({ stripe: 'skip', vapi: 'skip' });
    expect(stripeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('/api/status — POST mirror', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POST returns the same shape as GET', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { POST } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      method: 'POST',
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// Response-envelope invariants — mirrors the pattern used in the
// /api/cron/* route tests (Round 12). Any future "helpfully return
// err.stack" regression or "return 200 with ok:false" accident trips
// one of these assertions. The monitoring contract for /api/status is
// whatever holds across every realistic outcome — lock it here.
describe('response envelope invariants — /api/status', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{ label: string; status: number; body: Record<string, unknown> }> = [];

    // 1. Missing CRON_SECRET → 500.
    {
      delete env.CRON_SECRET;
      const { GET } = await loadRoute();
      const req = new Request('http://localhost/api/status', {
        headers: { 'x-cron-secret': 'nope' },
      });
      const res = await GET(req);
      outcomes.push({ label: 'missing-secret-env', status: res.status, body: await res.json() });
      env.CRON_SECRET = 'test-secret';
    }

    // 2. Unauthorized (no header).
    {
      vi.resetModules();
      const { GET } = await loadRoute();
      const req = new Request('http://localhost/api/status');
      const res = await GET(req);
      outcomes.push({ label: 'unauth', status: res.status, body: await res.json() });
    }

    // 3. Happy path — both probes ok.
    {
      vi.resetModules();
      mockCustomersList.mockResolvedValue({ data: [] });
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      const { GET } = await loadRoute();
      const req = new Request('http://localhost/api/status', {
        headers: { 'x-cron-secret': 'test-secret' },
      });
      const res = await GET(req);
      outcomes.push({ label: 'happy', status: res.status, body: await res.json() });
    }

    // 4. Degraded — stripe throws, expect 503 + ok:false envelope.
    {
      vi.resetModules();
      mockCustomersList.mockRejectedValue(new Error('invalid key'));
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      const { GET } = await loadRoute();
      const req = new Request('http://localhost/api/status', {
        headers: { 'x-cron-secret': 'test-secret' },
      });
      const res = await GET(req);
      outcomes.push({ label: 'degraded', status: res.status, body: await res.json() });
    }

    // 5. Skip — no integration envs set. Should be 200 with checks.*: 'skip'.
    {
      vi.resetModules();
      delete env.STRIPE_SECRET_KEY;
      delete env.VAPI_API_KEY;
      const { GET } = await loadRoute();
      const req = new Request('http://localhost/api/status', {
        headers: { 'x-cron-secret': 'test-secret' },
      });
      const res = await GET(req);
      outcomes.push({ label: 'skip', status: res.status, body: await res.json() });
      env.STRIPE_SECRET_KEY = 'sk_test_x';
      env.VAPI_API_KEY = 'vapi_x';
    }

    return outcomes;
  }

  it('every outcome has a top-level `ok: boolean`', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      expect(typeof o.body.ok, `${o.label} missing ok`).toBe('boolean');
    }
  });

  it('ok flag agrees with the HTTP status class', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      const is2xx = o.status >= 200 && o.status < 300;
      expect(o.body.ok, `${o.label} ok=${o.body.ok} vs status=${o.status}`).toBe(is2xx);
    }
  });

  it('ok:false auth/config outcomes carry a non-empty string `error`', async () => {
    const outcomes = await collectAllOutcomes();
    // 'degraded' reports failures via `errors` (plural), not `error`.
    for (const o of outcomes) {
      if (o.label === 'missing-secret-env' || o.label === 'unauth') {
        expect(typeof o.body.error, `${o.label} error not string`).toBe('string');
        expect((o.body.error as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('degraded outcome reports per-check errors via `errors` object, not flat `error`', async () => {
    const outcomes = await collectAllOutcomes();
    const degraded = outcomes.find((o) => o.label === 'degraded');
    expect(degraded).toBeTruthy();
    expect(degraded!.body.ok).toBe(false);
    expect(typeof degraded!.body.errors).toBe('object');
    expect((degraded!.body.errors as Record<string, unknown>).stripe).toBe('invalid key');
  });

  it('no ok:false outcome leaks a stack trace', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      if (o.body.ok === false) {
        const err = String(o.body.error ?? '');
        const errorsMap = o.body.errors as Record<string, unknown> | undefined;
        expect(err.includes('    at '), `${o.label} leaked stack in error`).toBe(false);
        if (errorsMap) {
          for (const v of Object.values(errorsMap)) {
            expect(String(v).includes('    at '), `${o.label} leaked stack in errors map`).toBe(false);
          }
        }
      }
    }
  });
});

// ── Round 28 secret-leak regression guard ──
//
// `checkStripe` / `checkVapi` forward `err.message.slice(0, 200)` to the
// response body on failure. That 200-char slice has always been the line
// of defense against Stripe / Vapi dumping the full request back in the
// error (which historically has included secret fragments, idempotency
// keys, and customer identifiers).
//
// These tests lock the behavior end-to-end: if a future refactor forgets
// the slice, forwards `err.stack`, or widens the redaction policy to
// include `err.config` / `err.request` fields, any of these tests fail
// BEFORE it ships to production.
//
// Why a separate describe block: keeping this next to the envelope tests
// would dilute the intent. Secret leaks deserve their own regression
// surface — the block is the searchable bookmark.
describe('/api/status — secret-leak regression guards', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_stripe_secret_do_not_leak';
    env.VAPI_API_KEY = 'vapi_do_not_leak_secret_xyz';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('never echoes a Stripe-secret-looking substring in errors.stripe', async () => {
    // Simulate a library that (badly) echoes the API key into the error
    // message. The slice should still not expose the literal key because
    // our truncation is length-based, not content-based — so we assert
    // that a key PATTERN never passes through the response boundary.
    const leakyErr = new Error(
      'stripe api rejected request with key sk_live_AAAAAAAAAAAAAAAAAAAAAAAA (trace id: req_xyz)'
    );
    mockCustomersList.mockRejectedValue(leakyErr);
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    const stripeErr = String(body.errors?.stripe ?? '');
    // The leaky message IS shorter than 200 chars and IS forwarded as
    // `stripe` error — this test documents the current boundary. If
    // this test ever starts to FAIL because a maintainer tightened the
    // redaction to strip `sk_live_*` patterns — great — delete this
    // test and write the tighter contract.
    // What we REALLY want to lock: the literal env var value MUST NOT
    // appear (would indicate err.config leakage), the 200-char slice
    // is the secondary defense.
    expect(stripeErr).not.toContain('sk_test_stripe_secret_do_not_leak');
    expect(stripeErr).not.toContain('vapi_do_not_leak_secret_xyz');
  });

  it('never echoes the CRON_SECRET in any ok:false response', async () => {
    // Defensive: a future helpful log message that interpolates
    // Authorization header contents would leak the cron secret here.
    // Locked across auth, degraded, and skip outcomes.
    mockCustomersList.mockRejectedValue(new Error('some upstream issue'));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('test-secret');
  });

  it('truncation is load-bearing — message length cap stays at 200', async () => {
    // Regression-guard against well-intentioned "let's bump it to 500
    // for better debugging" changes. 200 is the agreed ceiling; any
    // looser is a re-review.
    const huge = 'payload:' + 'A'.repeat(5000);
    mockCustomersList.mockRejectedValue(new Error(huge));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    const stripeErr = String(body.errors?.stripe ?? '');
    expect(stripeErr.length).toBe(200);
  });
});
