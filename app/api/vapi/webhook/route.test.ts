// Integration tests for the Vapi end-of-call webhook.
//
// Strategy:
//   • Stub the admin client with a per-test tracker for update/insert/rpc.
//   • Stub quote extraction so we control whether a quote row gets inserted.
//   • VAPI_WEBHOOK_SECRET is set to a known value; tests send requests
//     with the correct Authorization: Bearer header.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type RpcCall = { name: string; args: Record<string, unknown> };
type Tracker = {
  rpcCalls: RpcCall[];
  callUpdates: Array<Record<string, unknown>>;
  quoteInserts: Array<Record<string, unknown>>;
};

function buildAdminStub(opts: {
  callRow: {
    id: string;
    quote_request_id: string;
    business_id: string;
    status: string;
    quote_requests?: unknown;
  } | null;
  rpcErrors?: Record<string, { message: string }>;
  tracker: Tracker;
}) {
  return {
    from: (table: string) => {
      if (table === 'calls') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.callRow, error: null }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            opts.tracker.callUpdates.push(row);
            return {
              eq: () => Promise.resolve({ error: null }),
            };
          },
        };
      }
      if (table === 'quotes') {
        return {
          insert: (row: Record<string, unknown>) => {
            opts.tracker.quoteInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {};
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      opts.tracker.rpcCalls.push({ name, args });
      const err = opts.rpcErrors?.[name];
      return Promise.resolve({ error: err ?? null });
    },
  };
}

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/vapi/webhook', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });
}

describe('POST /api/vapi/webhook', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      VAPI_WEBHOOK_SECRET: 'test-vapi-secret',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc_test',
    };
  });

  it('rejects unauthenticated requests in production', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(makeReq({ message: {} })); // no auth header
    expect(res.status).toBe(401);
  });

  it('rejects requests with the wrong shared secret', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq({ message: {} }, { authorization: 'Bearer wrong-secret' })
    );
    expect(res.status).toBe(401);
  });

  it('ignores non-end-of-call message types with 200', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        { message: { type: 'status-update' } },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ignored');
  });

  it('returns 400 when call.id is missing', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        { message: { type: 'end-of-call-report' } },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(400);
  });

  it('is idempotent — skips terminal-status rows to avoid double counters', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-1',
            quote_request_id: 'req-1',
            business_id: 'biz-1',
            status: 'completed',
          },
          tracker,
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-123' },
            transcript: 'hello again',
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    // No counter RPC, no call update, no quote insert
    expect(tracker.rpcCalls).toHaveLength(0);
    expect(tracker.callUpdates).toHaveLength(0);
    expect(tracker.quoteInserts).toHaveLength(0);
  });

  it('processes a successful end-of-call report and extracts a quote', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-2',
            quote_request_id: 'req-2',
            business_id: 'biz-2',
            status: 'ringing',
            quote_requests: {
              category_id: 'cat-1',
              service_categories: { name: 'Moving', slug: 'moving' },
            },
          },
          tracker,
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn().mockResolvedValue({
        ok: true,
        quote: {
          priceMin: 350,
          priceMax: 500,
          priceDescription: 'Flat rate',
          availability: 'Saturday',
          includes: ['truck', 'two movers'],
          excludes: [],
          notes: null,
          contactName: 'Pat',
          contactPhone: null,
          contactEmail: null,
          requiresOnsiteEstimate: false,
          confidenceScore: 0.85,
        },
      }),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-ok' },
            transcript: 'transcript text',
            durationSeconds: 120,
            endedReason: 'assistant-hangup',
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    // Flipped to 'completed'
    expect(tracker.callUpdates[0]?.status).toBe('completed');
    // Inserted a quote
    expect(tracker.quoteInserts).toHaveLength(1);
    expect(tracker.quoteInserts[0].call_id).toBe('call-2');
    // Bumped the request counter
    const apply = tracker.rpcCalls.find((c) => c.name === 'apply_call_end');
    expect(apply).toBeDefined();
    expect(apply?.args.p_quote_inserted).toBe(true);
  });

  it('returns 400 when the request body is not valid JSON', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const req = new Request('https://example.com/api/vapi/webhook', {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        authorization: 'Bearer test-vapi-secret',
      }),
      body: '{not json',
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('invalid JSON');
  });

  it('returns 500 when the DB lookup throws so Vapi will retry', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: null,
                  error: { message: 'db boom' },
                }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-err' },
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('handler error');
  });

  it('is tolerant when the calls row cannot be found (foreign vapi account)', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: null, // not one of ours
          tracker,
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-foreign' },
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    // 200 so Vapi doesn't retry forever. No DB mutations.
    expect(res.status).toBe(200);
    expect(tracker.callUpdates).toHaveLength(0);
    expect(tracker.rpcCalls).toHaveLength(0);
    expect(tracker.quoteInserts).toHaveLength(0);
  });

  it('still 200s when extraction fails — the counter advances with quote_inserted=false', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-ext-fail',
            quote_request_id: 'req-ext-fail',
            business_id: 'biz-ext-fail',
            status: 'ringing',
            quote_requests: {
              category_id: 'cat-1',
              service_categories: { name: 'Moving', slug: 'moving' },
            },
          },
          tracker,
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'claude_http_503',
      }),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-ext-fail' },
            transcript: 'something was discussed',
            durationSeconds: 42,
            endedReason: 'assistant-hangup',
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    // 200: extraction failure is non-fatal; the call is still "completed".
    expect(res.status).toBe(200);
    expect(tracker.callUpdates[0]?.status).toBe('completed');
    // No quote row inserted
    expect(tracker.quoteInserts).toHaveLength(0);
    // Counter advances with quote_inserted=false
    const apply = tracker.rpcCalls.find((c) => c.name === 'apply_call_end');
    expect(apply).toBeDefined();
    expect(apply?.args.p_quote_inserted).toBe(false);
  });

  it('still 200s when the success-rate recompute fails (best-effort)', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-sc',
            quote_request_id: 'req-sc',
            business_id: 'biz-sc',
            status: 'ringing',
          },
          tracker,
          rpcErrors: {
            recompute_business_success_rate: { message: 'rpc unreachable' },
          },
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn().mockResolvedValue({ ok: false, reason: 'no transcript' }),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-sc' },
            transcript: null,
            endedReason: 'no-answer',
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    // Both rpcs attempted: the primary counter AND the best-effort score
    const names = tracker.rpcCalls.map((c) => c.name);
    expect(names).toContain('apply_call_end');
    expect(names).toContain('recompute_business_success_rate');
  });

  it('replay protection: two webhooks for the same vapiCallId — first processes, second is a no-op', async () => {
    // Stateful stub: after the first call's row update flips status to 'completed',
    // a subsequent lookup on the same row must reflect that. This proves the
    // idempotency guarantee against Vapi retries (which can hit our endpoint
    // multiple times for the same call.id).
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    let currentStatus = 'ringing';
    const stubAdmin = {
      from: (table: string) => {
        if (table === 'calls') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: 'call-rp',
                      quote_request_id: 'req-rp',
                      business_id: 'biz-rp',
                      status: currentStatus,
                      quote_requests: {
                        category_id: 'cat-1',
                        service_categories: { name: 'Moving', slug: 'moving' },
                      },
                    },
                    error: null,
                  }),
              }),
            }),
            update: (row: Record<string, unknown>) => {
              tracker.callUpdates.push(row);
              // Mutate the in-memory status so the next lookup reflects reality.
              if (typeof row.status === 'string') currentStatus = row.status;
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        }
        if (table === 'quotes') {
          return {
            insert: (row: Record<string, unknown>) => {
              tracker.quoteInserts.push(row);
              return Promise.resolve({ error: null });
            },
          };
        }
        return {};
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        tracker.rpcCalls.push({ name, args });
        return Promise.resolve({ error: null });
      },
    };

    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => stubAdmin,
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn().mockResolvedValue({
        ok: true,
        quote: {
          priceMin: 200,
          priceMax: 300,
          priceDescription: 'Flat',
          availability: 'Mon',
          includes: ['truck'],
          excludes: [],
          notes: null,
          contactName: 'Sam',
          contactPhone: null,
          contactEmail: null,
          requiresOnsiteEstimate: false,
          confidenceScore: 0.9,
        },
      }),
    }));

    const mod = await import('./route');
    const body = {
      message: {
        type: 'end-of-call-report',
        call: { id: 'vapi-replay-1' },
        transcript: 'first delivery',
        durationSeconds: 100,
        endedReason: 'assistant-hangup',
      },
    };
    const auth = { authorization: 'Bearer test-vapi-secret' };

    // First webhook delivery — should fully process.
    const r1 = await mod.POST(makeReq(body, auth));
    expect(r1.status).toBe(200);
    expect(tracker.callUpdates).toHaveLength(1);
    expect(tracker.callUpdates[0]?.status).toBe('completed');
    expect(tracker.quoteInserts).toHaveLength(1);
    expect(tracker.rpcCalls.filter((c) => c.name === 'apply_call_end')).toHaveLength(1);

    // Second webhook delivery (Vapi retry) — must be a no-op.
    const r2 = await mod.POST(makeReq(body, auth));
    expect(r2.status).toBe(200);
    // No new mutations: quote not double-inserted, counters not double-bumped.
    expect(tracker.callUpdates).toHaveLength(1);
    expect(tracker.quoteInserts).toHaveLength(1);
    expect(tracker.rpcCalls.filter((c) => c.name === 'apply_call_end')).toHaveLength(1);
  });

  it('replay protection: terminal-status replay is the same no-op shape (defensive even when row already says completed)', async () => {
    // Direct test of the "already terminal" path. Real-world this would happen
    // if the worker that processed the first webhook crashed *after* writing
    // the status update but *before* responding 200, causing Vapi to retry
    // against an already-terminal row.
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-rp2',
            quote_request_id: 'req-rp2',
            business_id: 'biz-rp2',
            // Any of the terminal statuses must short-circuit.
            status: 'failed',
          },
          tracker,
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-rp2' },
            transcript: 'should not be processed',
            durationSeconds: 60,
            endedReason: 'assistant-hangup',
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    // No mutations — the row is already in a terminal state.
    expect(tracker.callUpdates).toHaveLength(0);
    expect(tracker.quoteInserts).toHaveLength(0);
    expect(tracker.rpcCalls).toHaveLength(0);
  });

  it('classifies short silent calls as refused', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-3',
            quote_request_id: 'req-3',
            business_id: 'biz-3',
            status: 'ringing',
          },
          tracker,
        }),
    }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const res = await mod.POST(
      makeReq(
        {
          message: {
            type: 'end-of-call-report',
            call: { id: 'vapi-short' },
            durationSeconds: 3,
            // no transcript
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    expect(tracker.callUpdates[0]?.status).toBe('refused');
    // No quote extraction on non-completed outcome
    expect(tracker.quoteInserts).toHaveLength(0);
    // Counter still bumped, but quote_inserted=false
    const apply = tracker.rpcCalls.find((c) => c.name === 'apply_call_end');
    expect(apply?.args.p_quote_inserted).toBe(false);
  });
});
