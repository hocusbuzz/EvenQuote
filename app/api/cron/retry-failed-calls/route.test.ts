// Integration tests for /api/cron/retry-failed-calls.
//
// Focus: auth gating (CRON_SECRET) and that a configured-but-empty run
// returns the expected shape. Business-logic coverage for the worker
// itself lives alongside lib/cron/retry-failed-calls.ts (the handler
// here is a thin auth + dispatch shell).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Supabase client stub: an empty candidate list short-circuits the
// worker before any writes or outbound Vapi calls happen.
function buildAdminStub() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            lt: () => ({
              gte: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => buildAdminStub(),
}));

describe('GET /api/cron/retry-failed-calls', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CRON_SECRET;
  });

  it('returns 500 when CRON_SECRET is not configured (fail-closed)', async () => {
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls');
    const res = await mod.GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not configured/i);
  });

  it('returns 401 when no secret is provided', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls');
    const res = await mod.GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 for wrong secret', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls', {
      headers: { 'x-cron-secret': 'nope' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(401);
  });

  it('accepts secret via x-cron-secret header', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls', {
      headers: { 'x-cron-secret': 'shh-test-secret' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(0);
    expect(body.retried).toBe(0);
  });

  it('accepts secret via Authorization: Bearer header (pg_cron style)', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls', {
      headers: { authorization: 'Bearer shh-test-secret' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(200);
  });

  it('POST uses the same auth path', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls', {
      method: 'POST',
      headers: { 'x-cron-secret': 'shh-test-secret' },
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
  });

  it('POST rejects wrong secret with 401', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls', {
      method: 'POST',
      headers: { 'x-cron-secret': 'wrong' },
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });
});

// Response-envelope invariants. Locks the cross-outcome shape so any
// future monitoring integration (Sentry webhook, Datadog HTTP check,
// Better Stack heartbeat) can rely on "there is always a top-level
// `ok: boolean`, and if ok is false there is always a top-level
// `error: string`." If someone later refactors to return raw text or
// a different envelope, these tests fail fast.
describe('response envelope invariants — /api/cron/retry-failed-calls', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CRON_SECRET;
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{ label: string; status: number; body: Record<string, unknown> }> = [];

    // 1. Missing CRON_SECRET → 500 envelope.
    {
      const mod = await import('./route');
      const res = await mod.GET(
        new Request('http://localhost/api/cron/retry-failed-calls')
      );
      outcomes.push({ label: 'missing-secret-env', status: res.status, body: await res.json() });
    }

    // 2. Unauthorized (no header).
    {
      vi.resetModules();
      process.env.CRON_SECRET = 'inv-secret';
      const mod = await import('./route');
      const res = await mod.GET(
        new Request('http://localhost/api/cron/retry-failed-calls')
      );
      outcomes.push({ label: 'unauth', status: res.status, body: await res.json() });
    }

    // 3. Authorized happy path.
    {
      vi.resetModules();
      process.env.CRON_SECRET = 'inv-secret';
      const mod = await import('./route');
      const res = await mod.GET(
        new Request('http://localhost/api/cron/retry-failed-calls', {
          headers: { 'x-cron-secret': 'inv-secret' },
        })
      );
      outcomes.push({ label: 'happy', status: res.status, body: await res.json() });
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

  it('every ok:false outcome carries a string `error`', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      if (o.body.ok === false) {
        expect(typeof o.body.error, `${o.label} error not string`).toBe('string');
        expect((o.body.error as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('no ok:false outcome leaks a stack trace into the envelope', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      if (o.body.ok === false) {
        const err = String(o.body.error ?? '');
        expect(err.includes('    at '), `${o.label} leaked stack: ${err}`).toBe(false);
      }
    }
  });
});
