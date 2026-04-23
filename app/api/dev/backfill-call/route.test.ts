// Tests for /api/dev/backfill-call.
//
// This route pulls a completed call's state from Vapi's REST API and
// replays it through the same applyEndOfCall() pipeline the webhook
// uses. Because it mutates DB state, gating has to be airtight:
//   • NODE_ENV=production → 404
//   • DEV_TRIGGER_TOKEN mismatch → 401
//   • VAPI_API_KEY missing → 500 (nothing to fetch from)
//   • Neither vapi_call_id nor quote_request_id → 400
//
// Happy path assertions are kept surface-level: the route's real
// contract is "shape Vapi's GET response into VapiEndOfCallReport and
// hand off to applyEndOfCall()". The deeper behavior of applyEndOfCall
// is tested by lib/calls/apply-end-of-call.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────

const applyEndOfCallSpy = vi.fn();
vi.mock('@/lib/calls/apply-end-of-call', () => ({
  applyEndOfCall: (...args: unknown[]) => applyEndOfCallSpy(...args),
}));

// Stub admin client: one variant for vapi_call_id lookup, another for
// quote_request_id scan. Behavior is selected via a module-scope handle.
type AdminBehavior =
  | { kind: 'none' }
  | { kind: 'vapi-id-found'; row: { id: string; vapi_call_id: string } | null }
  | { kind: 'vapi-id-error'; message: string }
  | {
      kind: 'qr-scan';
      rows: Array<{ id: string; vapi_call_id: string | null; status: string }>;
    }
  | { kind: 'qr-scan-error'; message: string };

let adminBehavior: AdminBehavior = { kind: 'none' };

function buildAdminStub() {
  return {
    from: (table: string) => {
      if (table !== 'calls') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => {
            const api: Record<string, unknown> = {};
            api.maybeSingle = () => {
              if (adminBehavior.kind === 'vapi-id-found') {
                return Promise.resolve({ data: adminBehavior.row, error: null });
              }
              if (adminBehavior.kind === 'vapi-id-error') {
                return Promise.resolve({
                  data: null,
                  error: { message: adminBehavior.message },
                });
              }
              return Promise.resolve({ data: null, error: null });
            };
            api.in = () => {
              if (adminBehavior.kind === 'qr-scan') {
                return Promise.resolve({ data: adminBehavior.rows, error: null });
              }
              if (adminBehavior.kind === 'qr-scan-error') {
                return Promise.resolve({
                  data: null,
                  error: { message: adminBehavior.message },
                });
              }
              return Promise.resolve({ data: [], error: null });
            };
            return api;
          },
        }),
      };
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => buildAdminStub(),
}));

// ─── Env harness ─────────────────────────────────────────────────────

// Plain string[] (not `as const`) so indexing process.env with these keys
// doesn't narrow to NODE_ENV's readonly literal type under strict TS.
const ENV_KEYS: string[] = ['NODE_ENV', 'DEV_TRIGGER_TOKEN', 'VAPI_API_KEY'];
const saved: Record<string, string | undefined> = {};

describe('GET /api/dev/backfill-call', () => {
  beforeEach(() => {
    vi.resetModules();
    applyEndOfCallSpy.mockReset();
    applyEndOfCallSpy.mockResolvedValue({
      applied: true,
      status: 'completed',
      quoteInserted: true,
    });
    adminBehavior = { kind: 'none' };
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    // VAPI_API_KEY is required for every non-gating test — set it by default.
    process.env.VAPI_API_KEY = 'vapi_test_key';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it('returns 404 in production regardless of token', async () => {
    // Writable view to bypass TS's readonly narrowing of NODE_ENV.
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.DEV_TRIGGER_TOKEN = 't';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=abc&token=t')
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/disabled in production/);
  });

  it('returns 401 when DEV_TRIGGER_TOKEN is set and no token provided', async () => {
    process.env.DEV_TRIGGER_TOKEN = 'shh';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=abc')
    );
    expect(res.status).toBe(401);
  });

  it('returns 500 when VAPI_API_KEY is not set', async () => {
    delete process.env.VAPI_API_KEY;
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=abc')
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/VAPI_API_KEY/);
  });

  it('returns 400 when neither vapi_call_id nor quote_request_id is provided', async () => {
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call')
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/vapi_call_id|quote_request_id/);
  });

  it('returns ok with processed=0 when the quote_request has no stuck calls', async () => {
    adminBehavior = { kind: 'qr-scan', rows: [] };
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?quote_request_id=qr_x')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.note).toMatch(/No matching calls/);
  });

  it('returns error from calls lookup when vapi_call_id lookup fails', async () => {
    adminBehavior = { kind: 'vapi-id-error', message: 'db down' };
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=abc')
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/db down/);
  });

  it('happy path: fetches Vapi, shapes report, hands off to applyEndOfCall', async () => {
    adminBehavior = {
      kind: 'vapi-id-found',
      row: { id: 'call_int_1', vapi_call_id: 'vapi_abc' },
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'vapi_abc',
          status: 'ended',
          endedReason: 'customer-hang-up',
          transcript: 'Yes, we can do $800.',
          summary: 'Quoted $800 flat.',
          recordingUrl: 'https://storage.vapi.ai/r/abc',
          cost: 0.4,
          durationSeconds: 120,
          analysis: {
            structuredData: { price: 800 },
            successEvaluation: 'yes',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=vapi_abc')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(1);
    expect(body.applied).toBe(1);
    expect(body.quotes_inserted).toBe(1);

    // Fetch used the correct Authorization header.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.vapi.ai/call/vapi_abc',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer vapi_test_key',
        }),
      })
    );

    // applyEndOfCall received the shaped VapiEndOfCallReport.
    expect(applyEndOfCallSpy).toHaveBeenCalledTimes(1);
    const [, vapiId, report] = applyEndOfCallSpy.mock.calls[0];
    expect(vapiId).toBe('vapi_abc');
    expect(report).toMatchObject({
      type: 'end-of-call-report',
      call: { id: 'vapi_abc' },
      callId: 'vapi_abc',
      transcript: 'Yes, we can do $800.',
      summary: 'Quoted $800 flat.',
      cost: 0.4,
      durationSeconds: 120,
      endedReason: 'customer-hang-up',
      analysis: {
        structuredData: { price: 800 },
        successEvaluation: 'yes',
      },
    });
  });

  it('skips calls where Vapi says status != ended (not yet completed)', async () => {
    adminBehavior = {
      kind: 'vapi-id-found',
      row: { id: 'call_int_2', vapi_call_id: 'vapi_ongoing' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'vapi_ongoing', status: 'in-progress' }), {
          status: 200,
        })
      )
    );

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=vapi_ongoing')
    );
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.applied).toBe(0);
    expect(body.results[0].note).toMatch(/not ended yet/);
    expect(applyEndOfCallSpy).not.toHaveBeenCalled();
  });

  it('records per-call error when Vapi returns non-2xx', async () => {
    adminBehavior = {
      kind: 'vapi-id-found',
      row: { id: 'call_int_3', vapi_call_id: 'vapi_err' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('forbidden', {
          status: 403,
          statusText: 'Forbidden',
        })
      )
    );

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=vapi_err')
    );
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/403/);
  });

  it('records per-call error when fetch throws', async () => {
    adminBehavior = {
      kind: 'vapi-id-found',
      row: { id: 'call_int_4', vapi_call_id: 'vapi_net' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    );

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=vapi_net')
    );
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/ECONNRESET/);
  });

  it('allows explicit vapi_call_id even when no local row exists (replay)', async () => {
    adminBehavior = { kind: 'vapi-id-found', row: null };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'orphan', status: 'ended', transcript: '...' }),
          { status: 200 }
        )
      )
    );

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=orphan')
    );
    const body = await res.json();
    // applyEndOfCall WAS invoked (with 'orphan' as vapi id). It's then
    // the applyEndOfCall's job to short-circuit on a missing local row —
    // that's tested in lib/calls/apply-end-of-call.test.ts.
    expect(applyEndOfCallSpy).toHaveBeenCalledTimes(1);
    expect(body.processed).toBe(1);
  });

  it('computes durationSeconds from startedAt/endedAt when not provided directly', async () => {
    adminBehavior = {
      kind: 'vapi-id-found',
      row: { id: 'call_int_5', vapi_call_id: 'vapi_dur' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'vapi_dur',
            status: 'ended',
            startedAt: '2026-04-22T00:00:00Z',
            endedAt: '2026-04-22T00:02:30Z',
          }),
          { status: 200 }
        )
      )
    );

    const mod = await import('./route');
    await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?vapi_call_id=vapi_dur')
    );

    expect(applyEndOfCallSpy).toHaveBeenCalledTimes(1);
    const [, , report] = applyEndOfCallSpy.mock.calls[0];
    expect(report.durationSeconds).toBe(150);
  });

  it('quote_request_id mode respects ?all=1 by widening the stuck-status filter', async () => {
    // The stub doesn't actually branch on the .in() args — what we're
    // asserting is that the route doesn't blow up and returns processed=N
    // matching the stub's row count.
    adminBehavior = {
      kind: 'qr-scan',
      rows: [
        { id: 'c1', vapi_call_id: 'v1', status: 'in_progress' },
        { id: 'c2', vapi_call_id: 'v2', status: 'queued' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'v1', status: 'ended', transcript: '...' }),
          { status: 200 }
        )
      )
    );

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?quote_request_id=qr_x&all=1')
    );
    const body = await res.json();
    expect(body.processed).toBe(2);
  });

  it('skips calls in the scan that have no vapi_call_id set', async () => {
    adminBehavior = {
      kind: 'qr-scan',
      rows: [
        { id: 'c1', vapi_call_id: null, status: 'in_progress' },
        { id: 'c2', vapi_call_id: 'v2', status: 'in_progress' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'v2', status: 'ended', transcript: 'x' }),
          { status: 200 }
        )
      )
    );

    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/backfill-call?quote_request_id=qr_y')
    );
    const body = await res.json();
    expect(body.processed).toBe(1); // only c2
  });
});
