// Tests for /api/cron/check-status — the cron-friendly companion
// to /api/status.
//
// We mock the underlying probes (checkStripe / checkVapi from the
// status route) so the tests are pure and don't try to dial Stripe.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCheckStripe = vi.fn();
const mockCheckVapi = vi.fn();

vi.mock('@/app/api/status/route', () => ({
  checkStripe: () => mockCheckStripe(),
  checkVapi: () => mockCheckVapi(),
}));

const env = process.env as Record<string, string | undefined>;

async function loadRoute() {
  const mod = await import('./route');
  return mod;
}

function makeReq(headers: Record<string, string> = {}) {
  return new Request('https://example.com/api/cron/check-status', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('/api/cron/check-status', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheckStripe.mockReset();
    mockCheckVapi.mockReset();
    env.CRON_SECRET = 'cron_test_secret';
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete env.CRON_SECRET;
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'anything' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/CRON_SECRET/);
  });

  it('returns 401 when secret is missing from request', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(mockCheckStripe).not.toHaveBeenCalled();
    expect(mockCheckVapi).not.toHaveBeenCalled();
  });

  it('returns 401 when provided secret does not match', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'WRONG' }));
    expect(res.status).toBe(401);
  });

  it('accepts the secret via Authorization: Bearer header', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq({ authorization: 'Bearer cron_test_secret' })
    );
    expect(res.status).toBe(200);
  });

  it('returns 200 with both ok when both probes succeed', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ stripe: 'ok', vapi: 'ok' });
    expect(body.errors).toBeUndefined();
  });

  it('treats "skip" outcomes as healthy (preview env, no key)', async () => {
    // Critical: a preview env without VAPI_API_KEY should NOT page.
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'skip' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.vapi).toBe('skip');
  });

  it('returns 503 with errors when Stripe probe fails', async () => {
    mockCheckStripe.mockResolvedValue({
      outcome: 'fail',
      message: 'Invalid API Key',
    });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.stripe).toBe('fail');
    expect(body.errors.stripe).toBe('Invalid API Key');
  });

  it('returns 503 when both probes fail and surfaces both errors', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'fail', message: 'foo' });
    mockCheckVapi.mockResolvedValue({ outcome: 'fail', message: 'bar' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual({ stripe: 'foo', vapi: 'bar' });
  });

  it('responds to POST identically to GET (Vercel Cron uses POST)', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { POST } = await loadRoute();
    const req = new Request('https://example.com/api/cron/check-status', {
      method: 'POST',
      headers: new Headers({ 'x-cron-secret': 'cron_test_secret' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('sets Cache-Control: no-store to keep monitor results fresh', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
  });
});

// Response-envelope invariants — see the matching block in
// retry-failed-calls/route.test.ts. These lock the cross-outcome shape
// (`{ ok: boolean }`, ok agrees with status class, ok:false carries an
// error field where appropriate, and no stack traces leak).
describe('response envelope invariants — /api/cron/check-status', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheckStripe.mockReset();
    mockCheckVapi.mockReset();
    env.CRON_SECRET = 'cron_test_secret';
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{ label: string; status: number; body: Record<string, unknown> }> = [];

    // 1. Missing CRON_SECRET → 500.
    {
      delete env.CRON_SECRET;
      const { GET } = await loadRoute();
      const res = await GET(makeReq({ 'x-cron-secret': 'nope' }));
      outcomes.push({ label: 'missing-secret-env', status: res.status, body: await res.json() });
      env.CRON_SECRET = 'cron_test_secret';
    }

    // 2. Unauthorized (no header).
    {
      vi.resetModules();
      const { GET } = await loadRoute();
      const res = await GET(makeReq());
      outcomes.push({ label: 'unauth', status: res.status, body: await res.json() });
    }

    // 3. Happy path — both probes ok.
    {
      vi.resetModules();
      mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
      mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
      const { GET } = await loadRoute();
      const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
      outcomes.push({ label: 'happy', status: res.status, body: await res.json() });
    }

    // 4. Degraded — probe fails, expect 503 + ok:false envelope.
    {
      vi.resetModules();
      mockCheckStripe.mockResolvedValue({ outcome: 'fail', message: 'boom' });
      mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
      const { GET } = await loadRoute();
      const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
      outcomes.push({ label: 'degraded', status: res.status, body: await res.json() });
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

  it('ok:false auth/config outcomes carry a string `error`', async () => {
    const outcomes = await collectAllOutcomes();
    // 'degraded' reports failures via `errors` (plural, per-check), not
    // `error`, which is a distinct contract. Auth/config outcomes use the
    // flat `error` field. Check the right one per label.
    for (const o of outcomes) {
      if (o.label === 'missing-secret-env' || o.label === 'unauth') {
        expect(typeof o.body.error, `${o.label} error not string`).toBe('string');
        expect((o.body.error as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('degraded outcome reports per-check errors via `errors` object, not a flat error string', async () => {
    const outcomes = await collectAllOutcomes();
    const degraded = outcomes.find((o) => o.label === 'degraded');
    expect(degraded).toBeTruthy();
    expect(degraded!.body.ok).toBe(false);
    expect(typeof degraded!.body.errors).toBe('object');
    expect((degraded!.body.errors as Record<string, unknown>).stripe).toBe('boom');
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
