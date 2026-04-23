// Integration tests for /api/cron/send-reports.
//
// Focus: auth gating (CRON_SECRET) and the envelope shape returned by
// the handler. Deeper tests of the report generation / refund path live
// next to lib/cron/send-reports.ts in a dedicated unit suite; the HTTP
// handler here is a thin shell around that.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Supabase client stub: processing queue empty → sendPendingReports
// returns { ok:true, scanned:0, sent:0, failed:0, skipped:0, details:[] }.
function buildAdminStub() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
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

describe('GET /api/cron/send-reports', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CRON_SECRET;
  });

  it('returns 500 when CRON_SECRET is not configured (fail-closed)', async () => {
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/send-reports');
    const res = await mod.GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not configured/i);
  });

  it('returns 401 when no secret is provided', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/send-reports');
    const res = await mod.GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong secret', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/send-reports', {
      headers: { authorization: 'Bearer nope' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(401);
  });

  it('accepts secret via x-cron-secret header and returns zero-scan envelope', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/send-reports', {
      headers: { 'x-cron-secret': 'shh-test-secret' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(0);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.skipped).toBe(0);
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('accepts secret via Authorization: Bearer header (pg_cron style)', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/send-reports', {
      headers: { authorization: 'Bearer shh-test-secret' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(200);
  });

  it('POST uses the same auth path', async () => {
    process.env.CRON_SECRET = 'shh-test-secret';
    const mod = await import('./route');
    const req = new Request('http://localhost/api/cron/send-reports', {
      method: 'POST',
      headers: { 'x-cron-secret': 'shh-test-secret' },
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
  });
});

// Response-envelope invariants — see the matching block in
// retry-failed-calls/route.test.ts for the rationale. These lock the
// contract that all monitoring-facing responses have `{ ok: boolean }`
// at the top level and agree with the HTTP status.
describe('response envelope invariants — /api/cron/send-reports', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CRON_SECRET;
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{ label: string; status: number; body: Record<string, unknown> }> = [];

    {
      const mod = await import('./route');
      const res = await mod.GET(
        new Request('http://localhost/api/cron/send-reports')
      );
      outcomes.push({ label: 'missing-secret-env', status: res.status, body: await res.json() });
    }

    {
      vi.resetModules();
      process.env.CRON_SECRET = 'inv-secret';
      const mod = await import('./route');
      const res = await mod.GET(
        new Request('http://localhost/api/cron/send-reports')
      );
      outcomes.push({ label: 'unauth', status: res.status, body: await res.json() });
    }

    {
      vi.resetModules();
      process.env.CRON_SECRET = 'inv-secret';
      const mod = await import('./route');
      const res = await mod.GET(
        new Request('http://localhost/api/cron/send-reports', {
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
