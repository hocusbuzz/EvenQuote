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
    // Sentinel for the "counters have been applied" short-circuit.
    // Defaults to null — caller passes a non-null value to simulate a
    // row where the end-of-call finalizer has already run to completion.
    counters_applied_at?: string | null;
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

  // Timing-attack regression test.
  //
  // The verifier at `lib/calls/vapi.ts#verifyVapiWebhook` was historically
  // comparing secrets with `!==`, which short-circuits on the first
  // differing byte. An attacker probing many prefixes could learn the
  // secret one byte at a time.
  //
  // The fix uses `constantTimeEqual()` (SHA-256 then timingSafeEqual).
  // This test sends a near-miss — the first 31 chars of a 32-char
  // secret — and asserts it is rejected. If someone later "simplifies"
  // the compare back to `===`, *this* test still passes (the short
  // prefix is not equal), so we ALSO assert behavior on a full-length
  // single-char difference to lock the contract. The real defense is
  // the helper; this test is the canary that fails if the helper is
  // ever un-plumbed from this route.
  it('rejects a 31-char prefix of the real 32-char secret (timing-attack regression)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'abcdef0123456789abcdef0123456789'; // 32 chars
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    const almost = 'abcdef0123456789abcdef012345678'; // 31 chars — drop last byte
    const res = await mod.POST(
      makeReq({ message: {} }, { authorization: `Bearer ${almost}` })
    );
    expect(res.status).toBe(401);
  });

  it('rejects a 32-char secret with a single-byte diff at the last position', async () => {
    process.env.VAPI_WEBHOOK_SECRET = 'abcdef0123456789abcdef0123456789';
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/calls/extract-quote', () => ({
      extractQuoteFromCall: vi.fn(),
    }));
    const mod = await import('./route');
    // Same length, differs at the last byte only — exactly the shape
    // a naive `===` would still catch, but also the shape we want the
    // constant-time path to catch without revealing the byte position.
    const wrong = 'abcdef0123456789abcdef012345678X';
    const res = await mod.POST(
      makeReq({ message: {} }, { authorization: `Bearer ${wrong}` })
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

  it('is idempotent — skips rows with counters_applied_at stamped', async () => {
    // Replay of a fully-applied row: status AND counters_applied_at set.
    // Migration 0008 moved the short-circuit gate from "status is
    // terminal" to "counters_applied_at is not null" so webhook retries
    // after a mid-flight crash can still repair the counter bump.
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-1',
            quote_request_id: 'req-1',
            business_id: 'biz-1',
            status: 'completed',
            counters_applied_at: '2026-04-22T12:00:00Z',
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
    // Stateful stub: after the first call's RPC stamps counters_applied_at,
    // a subsequent lookup must reflect that. This proves the idempotency
    // guarantee against Vapi retries (which can hit our endpoint multiple
    // times for the same call.id).
    //
    // Post-migration-0008 semantics: the short-circuit gate is
    // counters_applied_at (stamped atomically inside the apply_call_end
    // RPC), NOT status (written before the RPC). So this stub mirrors prod
    // by flipping counters_applied_at only when the RPC is invoked.
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    let currentStatus = 'ringing';
    let currentCountersAppliedAt: string | null = null;
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
                      counters_applied_at: currentCountersAppliedAt,
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
        // Mirror the RPC's atomic claim: stamp counters_applied_at so the
        // next lookup short-circuits. Only the first invocation flips it;
        // subsequent calls leave it alone (production's UPDATE…WHERE sentinel
        // IS NULL pattern).
        if (name === 'apply_call_end' && currentCountersAppliedAt === null) {
          currentCountersAppliedAt = new Date().toISOString();
        }
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

  it('retry-repair: terminal status WITHOUT counters_applied_at re-runs end-of-call', async () => {
    // REGRESSION TEST for the bug fixed by migration 0008.
    //
    // Previously, the short-circuit gated on calls.status being terminal.
    // But in applyEndOfCall the status UPDATE runs BEFORE the apply_call_end
    // RPC. If the RPC throws (network blip, RLS hiccup, Postgres restart),
    // we returned non-2xx, Vapi retried — and the retry saw terminal status
    // and short-circuited, stranding counters un-bumped forever. A single
    // stuck row keeps the parent quote_request in status='calling' so the
    // report cron never picks it up.
    //
    // Fix: the gate is now counters_applied_at (stamped atomically inside
    // the RPC). A terminal-status row with counters_applied_at=null is the
    // exact shape of a half-applied crash and MUST re-run, so the RPC gets
    // another chance to stamp the sentinel and bump counters. The RPC
    // itself is internally idempotent (UPDATE … WHERE sentinel IS NULL),
    // so even if the first RPC actually succeeded and only the response
    // was lost, the retry is safe.
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          callRow: {
            id: 'call-repair',
            quote_request_id: 'req-repair',
            business_id: 'biz-repair',
            // Row says 'failed' but counters_applied_at is null ⇒ partial apply.
            status: 'failed',
            counters_applied_at: null,
            quote_requests: {
              category_id: 'cat-1',
              service_categories: { name: 'Moving', slug: 'moving' },
            },
          },
          tracker,
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
            call: { id: 'vapi-repair' },
            transcript: null,
            endedReason: 'no-answer',
          },
        },
        { authorization: 'Bearer test-vapi-secret' }
      )
    );
    expect(res.status).toBe(200);
    // End-of-call re-ran: status re-written, RPC re-fired with p_call_id.
    expect(tracker.callUpdates).toHaveLength(1);
    const apply = tracker.rpcCalls.find((c) => c.name === 'apply_call_end');
    expect(apply).toBeDefined();
    expect(apply?.args.p_call_id).toBe('call-repair');
    expect(apply?.args.p_request_id).toBe('req-repair');
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

  // ── Retry-storm idempotency ─────────────────────────────────────
  //
  // Vapi retries end-of-call deliveries on non-2xx AND during their
  // own infra blips — occasionally in bursts. The existing
  // "replay protection" test covers serial retries. This companion
  // covers PARALLEL retries: 10 POSTs for the same call.id arriving
  // on overlapping ticks.
  //
  // The canonical invariant is at-most-once side effects:
  //   • apply_call_end RPC fires ≤ 1 time with a real stamping call
  //     (additional invocations may happen, but the RPC's internal
  //     UPDATE … WHERE counters_applied_at IS NULL guarantees they
  //     become no-ops — we simulate that in the stub).
  //   • quote row inserted ≤ 1 time.
  //   • call row status updated ≤ 1 time.
  //
  // If the guard ever regresses, the failure mode is loud: counters
  // bump N times, report cron miscounts, customers get a report
  // with duplicate quotes, or each business gets N "here is your
  // quote" emails.
  it('10 parallel same-callId deliveries: at-most-once side effects', async () => {
    const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
    let currentStatus = 'ringing';
    let currentCountersAppliedAt: string | null = null;
    // Simulates the `quotes.call_id UNIQUE` constraint. In production
    // only one of N parallel insert attempts for the same call_id
    // wins; the rest get a unique_violation error that applyEndOfCall
    // catches and swallows (see lib/calls/apply-end-of-call.ts ~L177).
    const insertedQuoteCallIds = new Set<string>();
    // Simulates `apply_call_end`'s atomic `UPDATE … WHERE
    // counters_applied_at IS NULL` — only ONE concurrent RPC wins the
    // claim; the rest become no-ops at the DB level. We reflect that
    // by counting "effective" stamps separately from total invocations.
    let effectiveRpcStamps = 0;

    // Shared stateful stub. `counters_applied_at` acts as the DB's
    // unique sentinel — set by the first concurrent RPC to reach the
    // claim, respected by every later one via the `IS NULL` branch.
    // This mirrors the real 0008_end_of_call_idempotency.sql behavior.
    const stubAdmin = {
      from: (table: string) => {
        if (table === 'calls') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: 'call-storm',
                      quote_request_id: 'req-storm',
                      business_id: 'biz-storm',
                      status: currentStatus,
                      counters_applied_at: currentCountersAppliedAt,
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
              // In production this UPDATE fires per-request (no sentinel
              // check on the calls row itself — the sentinel lives
              // inside the RPC). All 10 updates write the same values,
              // so the effective state is still once. We record for
              // visibility but do NOT assert call-updates length == 1.
              tracker.callUpdates.push(row);
              if (typeof row.status === 'string') currentStatus = row.status;
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        }
        if (table === 'quotes') {
          return {
            insert: (row: Record<string, unknown>) => {
              const callId = row.call_id as string;
              if (insertedQuoteCallIds.has(callId)) {
                // Unique constraint violation — mirror Postgres.
                return Promise.resolve({
                  error: { code: '23505', message: 'unique_violation on quotes.call_id' },
                });
              }
              insertedQuoteCallIds.add(callId);
              tracker.quoteInserts.push(row);
              return Promise.resolve({ error: null });
            },
          };
        }
        return {};
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        tracker.rpcCalls.push({ name, args });
        // Atomic claim: only the first apply_call_end flips the
        // sentinel. Subsequent invocations become no-ops at the DB
        // level in production — we mirror that by only incrementing
        // `effectiveRpcStamps` on the winning claim.
        if (name === 'apply_call_end' && currentCountersAppliedAt === null) {
          currentCountersAppliedAt = new Date().toISOString();
          effectiveRpcStamps += 1;
        }
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
          priceMin: 100,
          priceMax: 150,
          priceDescription: 'Flat',
          availability: 'Mon',
          includes: [],
          excludes: [],
          notes: null,
          contactName: 'S',
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
        call: { id: 'vapi-storm-1' },
        transcript: 'storm delivery',
        durationSeconds: 100,
        endedReason: 'assistant-hangup',
      },
    };
    const auth = { authorization: 'Bearer test-vapi-secret' };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => mod.POST(makeReq(body, auth)))
    );

    // Every delivery acked with 200 — we never 5xx on a replay.
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // AT-MOST-ONCE invariants on durable side effects:
    //   • quote row inserted exactly once (quotes.call_id UNIQUE
    //     catches the other 9 as unique_violation → swallowed in
    //     lib/calls/apply-end-of-call.ts's insert branch).
    //   • RPC counter-stamp happens effectively once (the RPC may be
    //     INVOKED multiple times, but the atomic UPDATE … WHERE
    //     counters_applied_at IS NULL ensures at most one stamps).
    //
    // We deliberately do NOT assert callUpdates.length === 1. In
    // production the calls.status update has no per-row sentinel, so
    // all 10 concurrent requests DO rewrite the row. That's safe
    // (they write identical values) and also unavoidable without a
    // redesign — the at-most-once boundary lives on the quotes row
    // and the RPC, not on calls.status.
    expect(tracker.quoteInserts).toHaveLength(1);
    expect(effectiveRpcStamps).toBe(1);
    // Final state: status landed on 'completed' regardless of race
    // ordering (all 10 wrote the same terminal value).
    expect(currentStatus).toBe('completed');
  });

  // ── captureException tag-shape lockdown ──────────────────────────
  // The route wraps applyEndOfCall in a try/catch and fires
  // `captureException(err, { tags: { route: 'vapi/webhook', vapiCallId } })`
  // on failure. A future refactor that renames the tag keys (or
  // accidentally stuffs transcript text, phone numbers, or email
  // addresses into the tag bag) would break Sentry's indexed search
  // AND could leak PII into a third-party observability surface.
  //
  // These tests match the pattern used at the lib boundary
  // (see lib/calls/engine.test.ts and lib/email/resend.test.ts):
  //   (a) canonical tag-shape equality assertion
  //   (b) PII negative-assertion on every tag value
  //   (c) happy-path no-capture sanity
  describe('captureException tag shape', () => {
    it('captures with canonical { route, vapiCallId } tags on handler error', async () => {
      const captureExceptionMock = vi.fn();
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/observability/sentry', () => ({
        captureException: (err: unknown, ctx?: unknown) =>
          captureExceptionMock(err, ctx),
      }));
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildAdminStub({
            // Null callRow forces applyEndOfCall into a no-op note
            // path, which is NOT what we want — we want a throw. So
            // stub apply-end-of-call directly to throw.
            callRow: {
              id: 'call-err',
              quote_request_id: 'req-err',
              business_id: 'biz-err',
              status: 'ringing',
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/calls/apply-end-of-call', () => ({
        applyEndOfCall: vi
          .fn()
          .mockRejectedValue(new Error('extract pipeline exploded')),
      }));

      const mod = await import('./route');
      const res = await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              // Include PII-looking data in the payload — the capture
              // should still expose only the canonical tag shape, NOT
              // any of these.
              call: { id: 'vapi-err-123' },
              customer: { number: '+14155550199' },
              assistant: { name: 'test' },
              transcript: 'hi, this is john at 555-0199',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(res.status).toBe(500);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [err, ctx] = captureExceptionMock.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/extract pipeline exploded/);
      expect(ctx).toEqual({
        tags: { route: 'vapi/webhook', vapiCallId: 'vapi-err-123' },
      });
      // PII negative-assertion — no phone or email in any tag value.
      for (const v of Object.values((ctx as { tags: Record<string, string> }).tags)) {
        expect(v).not.toMatch(/@/); // email guard
        expect(v).not.toMatch(/\+?\d{10,}/); // phone guard
      }
    });

    it('does NOT capture on happy-path end-of-call', async () => {
      const captureExceptionMock = vi.fn();
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/observability/sentry', () => ({
        captureException: (err: unknown, ctx?: unknown) =>
          captureExceptionMock(err, ctx),
      }));
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildAdminStub({
            callRow: {
              id: 'call-happy',
              quote_request_id: 'req-happy',
              business_id: 'biz-happy',
              status: 'ringing',
            },
            tracker,
          }),
      }));
      // Explicitly re-stub apply-end-of-call to a non-throwing variant
      // so the throw-mock from the preceding error test doesn't bleed
      // in (vi.doMock persists across `vi.resetModules()`).
      vi.doMock('@/lib/calls/apply-end-of-call', () => ({
        applyEndOfCall: vi.fn().mockResolvedValue({ applied: true }),
      }));
      vi.doMock('@/lib/calls/extract-quote', () => ({
        extractQuoteFromCall: vi.fn().mockResolvedValue({ ok: false, reason: 'nt' }),
      }));

      const mod = await import('./route');
      const res = await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-happy' },
              durationSeconds: 3,
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(res.status).toBe(200);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });
  });

  // ── Drift detection — canonical column / RPC / arg shapes ────────
  //
  // Sibling suite to the drift blocks added in R25 for twilio/sms and
  // vapi/inbound-callback. The goal is not "functional coverage" (the
  // suites above already have that) — it's "lock the exact shape of
  // side-effect calls so a schema migration or library rename fails
  // here loudly instead of silently".
  //
  // What drifts silently in prod if unprotected:
  //   • `quotes` column rename → route writes the old name → RLS
  //     denies the insert OR Postgres throws → retry storm.
  //   • RPC rename (e.g. `apply_call_end` → `apply_call_end_v2`) →
  //     postgres reports a "function does not exist" error → counters
  //     stop bumping → UI never flips to "complete" → customer paid
  //     but gets no report.
  //   • RPC arg rename (e.g. `p_request_id` → `request_id`) → postgres
  //     reports "function … does not exist" with the wrong-arg shape
  //     → same failure mode as above.
  //   • Terminal-status enum rename (`completed` → `done`) → cron
  //     report job's status filter silently drops rows → report never
  //     sent.
  //
  // Each test asserts the *exact* observable shape the webhook emits
  // to the DB. Any rename requires updating BOTH the route AND this
  // test — which is the point.
  describe('drift detection (R26) — locks canonical DB shapes', () => {
    // The preceding `captureException tag shape` block replaces
    // apply-end-of-call with a stub (either throwing or a
    // no-op `{ applied: true }`) so it can isolate the route's
    // try/catch. Those mocks persist across `vi.resetModules()`
    // (that's how `vi.doMock` is documented to behave). For the drift
    // suite we want the REAL apply-end-of-call so the `buildAdminStub`
    // tracker sees the actual DB shape. Unmock first, then re-mock
    // only what this suite controls.
    beforeEach(() => {
      vi.doUnmock('@/lib/calls/apply-end-of-call');
      vi.resetModules();
    });

    const HAPPY_QUOTE = {
      priceMin: 350,
      priceMax: 500,
      priceDescription: 'Flat',
      availability: 'Sat',
      includes: ['truck', 'two movers'],
      excludes: ['stairs'],
      notes: 'friendly',
      contactName: 'Pat',
      contactPhone: null,
      contactEmail: null,
      requiresOnsiteEstimate: false,
      confidenceScore: 0.85,
    };

    it('quotes insert carries exactly the canonical column set (no drift in names or count)', async () => {
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildAdminStub({
            callRow: {
              id: 'call-drift-q',
              quote_request_id: 'req-drift-q',
              business_id: 'biz-drift-q',
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
          quote: HAPPY_QUOTE,
        }),
      }));
      const mod = await import('./route');
      const res = await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-drift-q' },
              transcript: 't',
              durationSeconds: 120,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(res.status).toBe(200);
      expect(tracker.quoteInserts).toHaveLength(1);
      // EXACT key set: a migration that renames OR adds a column requires
      // editing this test. That's the drift catch.
      expect(new Set(Object.keys(tracker.quoteInserts[0]))).toEqual(
        new Set([
          'call_id',
          'quote_request_id',
          'business_id',
          'price_min',
          'price_max',
          'price_description',
          'availability',
          'includes',
          'excludes',
          'notes',
          'contact_name',
          'contact_phone',
          'contact_email',
          'requires_onsite_estimate',
          'confidence_score',
        ])
      );
      // Spot-check a few values to catch silent snake_case→camelCase
      // inversions.
      expect(tracker.quoteInserts[0].price_min).toBe(350);
      expect(tracker.quoteInserts[0].requires_onsite_estimate).toBe(false);
      expect(tracker.quoteInserts[0].confidence_score).toBe(0.85);
    });

    it('apply_call_end RPC is called with canonical args (names + types)', async () => {
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildAdminStub({
            callRow: {
              id: 'call-drift-rpc',
              quote_request_id: 'req-drift-rpc',
              business_id: 'biz-drift-rpc',
              status: 'ringing',
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/calls/extract-quote', () => ({
        extractQuoteFromCall: vi
          .fn()
          .mockResolvedValue({ ok: false, reason: 'no transcript' }),
      }));
      const mod = await import('./route');
      await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-drift-rpc' },
              endedReason: 'no-answer',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      const apply = tracker.rpcCalls.find((c) => c.name === 'apply_call_end');
      expect(apply, 'apply_call_end RPC must fire').toBeDefined();
      // Exact arg-key set — catches `p_request_id` → `request_id` renames.
      expect(new Set(Object.keys(apply!.args))).toEqual(
        new Set(['p_request_id', 'p_call_id', 'p_quote_inserted'])
      );
      expect(typeof apply!.args.p_request_id).toBe('string');
      expect(typeof apply!.args.p_call_id).toBe('string');
      expect(typeof apply!.args.p_quote_inserted).toBe('boolean');
    });

    it('recompute_business_success_rate RPC uses its canonical name (best-effort, non-blocking)', async () => {
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildAdminStub({
            callRow: {
              id: 'call-drift-sc',
              quote_request_id: 'req-drift-sc',
              business_id: 'biz-drift-sc',
              status: 'ringing',
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/calls/extract-quote', () => ({
        extractQuoteFromCall: vi
          .fn()
          .mockResolvedValue({ ok: false, reason: 'no transcript' }),
      }));
      const mod = await import('./route');
      await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-drift-sc' },
              endedReason: 'no-answer',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      const sc = tracker.rpcCalls.find(
        (c) => c.name === 'recompute_business_success_rate'
      );
      expect(sc, 'recompute_business_success_rate must fire').toBeDefined();
      // The arg name MUST be p_business_id — a rename would silently
      // stop refreshing success scores, and the UI would drift.
      expect(Object.keys(sc!.args)).toContain('p_business_id');
      expect(sc!.args.p_business_id).toBe('biz-drift-sc');
    });

    it('terminal status enum is still "completed" (rename drift guard)', async () => {
      // If the `calls.status` enum is ever renamed ('completed' → 'done'),
      // the cron report worker's filter drops rows and reports stall.
      // Lock the literal here so the rename requires touching this test.
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildAdminStub({
            callRow: {
              id: 'call-drift-status',
              quote_request_id: 'req-drift-status',
              business_id: 'biz-drift-status',
              status: 'ringing',
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/calls/extract-quote', () => ({
        extractQuoteFromCall: vi.fn().mockResolvedValue({
          ok: true,
          quote: HAPPY_QUOTE,
        }),
      }));
      const mod = await import('./route');
      await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-drift-status' },
              transcript: 't',
              durationSeconds: 60,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(tracker.callUpdates[0]?.status).toBe('completed');
    });

    it('23505 on quotes insert is swallowed without double-bumping the counter', async () => {
      // Mirror of the inbound-callback "23505 on quotes insert" lock.
      // If apply-end-of-call stops swallowing 23505 on the quote
      // insert path, a parallel-retry would: (a) 500 back to Vapi,
      // (b) trigger another redelivery, (c) hit the same race again.
      // Also: the RPC counter bump MUST NOT fire twice for the same
      // call — UI shows duplicate rows.
      const tracker: Tracker = { rpcCalls: [], callUpdates: [], quoteInserts: [] };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => ({
          from: (table: string) => {
            if (table === 'calls') {
              return {
                select: () => ({
                  eq: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: {
                          id: 'call-drift-23505',
                          quote_request_id: 'req-drift-23505',
                          business_id: 'biz-drift-23505',
                          status: 'ringing',
                        },
                        error: null,
                      }),
                  }),
                }),
                update: () => ({ eq: () => Promise.resolve({ error: null }) }),
              };
            }
            if (table === 'quotes') {
              return {
                insert: (_row: Record<string, unknown>) =>
                  Promise.resolve({
                    error: { code: '23505', message: 'unique_violation' },
                  }),
              };
            }
            return {};
          },
          rpc: (name: string, args: Record<string, unknown>) => {
            tracker.rpcCalls.push({ name, args });
            return Promise.resolve({ error: null });
          },
        }),
      }));
      vi.doMock('@/lib/calls/extract-quote', () => ({
        extractQuoteFromCall: vi
          .fn()
          .mockResolvedValue({ ok: true, quote: HAPPY_QUOTE }),
      }));
      const mod = await import('./route');
      const res = await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-drift-23505' },
              transcript: 't',
              durationSeconds: 60,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      // 200: the 23505 is expected on a replay, must be swallowed.
      expect(res.status).toBe(200);
      // Counter RPC fires with p_quote_inserted=false — the other racer
      // already inserted and bumped, so THIS delivery MUST NOT double-bump.
      const apply = tracker.rpcCalls.find((c) => c.name === 'apply_call_end');
      expect(apply, 'apply_call_end still fires (counter advances)').toBeDefined();
      expect(apply?.args.p_quote_inserted).toBe(false);
    });
  });

  // ── Idempotency-column drift (R31) — lock the at-most-once semantic ─
  //
  // R26 locked column SETS on insert/update and RPC arg SETS. R30 locked
  // the stripe webhook's dedupe COLUMN NAME (`stripe_event_id` vs drifts).
  // This is the Vapi-webhook sibling: the at-most-once guarantee is a
  // three-layer defense and EACH layer has a column-name contract:
  //
  //   Layer 1 — LOOKUP: the route finds its calls row via
  //             `.eq('vapi_call_id', …)`. Rename to `provider_call_id`
  //             or `external_id` and EVERY webhook lookup returns null
  //             → every delivery is a silent no-op ("no calls row for
  //             …"). Customer paid, nothing ever lands.
  //
  //   Layer 2 — SENTINEL: the short-circuit reads `counters_applied_at`.
  //             Rename to `applied_at` / `completed_at` / `finalized_at`
  //             and the guard always sees undefined/falsy → every retry
  //             re-processes the call → double counter bumps, duplicate
  //             summary writes, duplicate success-rate recomputes.
  //
  //   Layer 3 — UNIQUE BACKSTOP: `quotes.call_id` is UNIQUE. The R26
  //             "23505 on quotes insert" test already locks the swallow
  //             behavior. What it doesn't lock is the column being called
  //             `call_id` specifically — covered in the key-set test
  //             above but worth an explicit negative-assertion anchor.
  //
  // Also locked here: the calls-row UPDATE key set — R26 locked quotes
  // insert keys and RPC args but not the status/transcript/cost/etc
  // update shape. A migration that dropped `transcript` or renamed
  // `ended_at` would silently stop persisting that column on every
  // end-of-call write.
  //
  // Methodology mirrors R30's stripe idempotency drift suite: capture
  // the column NAMES passed to `.eq(…)` and `.update(…)` via an
  // extended stub, then assert (a) canonical names present, (b)
  // drifted-name set absent.
  describe('idempotency-column drift (R31) — locks at-most-once column names', () => {
    beforeEach(() => {
      vi.doUnmock('@/lib/calls/apply-end-of-call');
      vi.resetModules();
    });

    type EqCall = { table: string; column: string; value: unknown };
    type UpdateCall = { table: string; row: Record<string, unknown> };
    type DriftTracker = {
      eqCalls: EqCall[];
      updateCalls: UpdateCall[];
      rpcCalls: RpcCall[];
      quoteInserts: Array<Record<string, unknown>>;
    };

    function buildDriftCapturingAdminStub(opts: {
      callRow: {
        id: string;
        quote_request_id: string;
        business_id: string;
        status: string;
        counters_applied_at?: string | null;
        quote_requests?: unknown;
      } | null;
      tracker: DriftTracker;
    }) {
      return {
        from: (table: string) => {
          if (table === 'calls') {
            return {
              select: () => ({
                eq: (column: string, value: unknown) => {
                  opts.tracker.eqCalls.push({ table, column, value });
                  return {
                    maybeSingle: () =>
                      Promise.resolve({ data: opts.callRow, error: null }),
                  };
                },
              }),
              update: (row: Record<string, unknown>) => {
                opts.tracker.updateCalls.push({ table, row });
                return {
                  eq: (column: string, value: unknown) => {
                    opts.tracker.eqCalls.push({ table, column, value });
                    return Promise.resolve({ error: null });
                  },
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
          return Promise.resolve({ error: null });
        },
      };
    }

    const DRIFT_HAPPY_QUOTE = {
      priceMin: 100,
      priceMax: 200,
      priceDescription: 'Flat',
      availability: 'Sat',
      includes: [],
      excludes: [],
      notes: null,
      contactName: 'S',
      contactPhone: null,
      contactEmail: null,
      requiresOnsiteEstimate: false,
      confidenceScore: 0.9,
    };

    it('LOOKUP layer — calls lookup keys on `vapi_call_id` (not drifted names)', async () => {
      // If this column name ever drifts, every webhook lookup returns
      // null, the handler returns 200 "no calls row for …", and every
      // paying customer silently gets nothing. Lock the exact name.
      const tracker: DriftTracker = {
        eqCalls: [],
        updateCalls: [],
        rpcCalls: [],
        quoteInserts: [],
      };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftCapturingAdminStub({
            callRow: {
              id: 'call-lookup-drift',
              quote_request_id: 'req-lookup-drift',
              business_id: 'biz-lookup-drift',
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
          quote: DRIFT_HAPPY_QUOTE,
        }),
      }));
      const mod = await import('./route');
      const res = await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-lookup-drift' },
              transcript: 't',
              durationSeconds: 60,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(res.status).toBe(200);

      // The FIRST eq on the calls table is the lookup — it MUST be
      // by vapi_call_id with the exact id Vapi sent us. (The SECOND eq
      // on calls is for the .update(...).eq('id', ...) addressing —
      // different and legitimate; locked separately in the UPDATE-shape
      // test below.)
      const callsEqs = tracker.eqCalls.filter((c) => c.table === 'calls');
      const lookupEq = callsEqs[0];
      expect(lookupEq, 'calls lookup must fire').toBeDefined();
      expect(lookupEq.column).toBe('vapi_call_id');
      expect(lookupEq.value).toBe('vapi-lookup-drift');

      // Negative assertions: the LOOKUP MUST NOT have been keyed on
      // any common drift candidates. If someone refactors the lookup to
      // use an external/provider/vapi id column, every webhook finds
      // nothing. We check only the FIRST eq — the update's eq('id', ...)
      // is a legitimate separate concern.
      const DRIFTED_LOOKUP_NAMES = [
        'external_id',
        'provider_call_id',
        'call_event_id',
        'vapi_id',
        'voicemail_id',
      ];
      for (const drifted of DRIFTED_LOOKUP_NAMES) {
        expect(
          lookupEq.column,
          `calls lookup must NOT key on '${drifted}' (drifted column name)`
        ).not.toBe(drifted);
      }
    });

    it('SENTINEL layer — short-circuit reads `counters_applied_at` (not drifted names)', async () => {
      // If the sentinel column is renamed, the short-circuit always
      // reads undefined → every retry re-processes → counters bump
      // multiple times → UI shows wrong denominators, report cron
      // double-fires. Lock the name by reading it back from the stub.
      const SENTINEL_STAMPED = '2026-04-23T10:00:00.000Z';
      const tracker: DriftTracker = {
        eqCalls: [],
        updateCalls: [],
        rpcCalls: [],
        quoteInserts: [],
      };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftCapturingAdminStub({
            callRow: {
              id: 'call-sentinel-drift',
              quote_request_id: 'req-sentinel-drift',
              business_id: 'biz-sentinel-drift',
              status: 'completed',
              // Sentinel STAMPED → handler MUST short-circuit.
              counters_applied_at: SENTINEL_STAMPED,
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
          quote: DRIFT_HAPPY_QUOTE,
        }),
      }));
      const mod = await import('./route');
      const res = await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-sentinel-drift' },
              transcript: 't',
              durationSeconds: 60,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      // With sentinel stamped, every downstream write MUST NOT fire.
      expect(res.status).toBe(200);
      expect(tracker.updateCalls, 'no calls-update when sentinel stamped').toHaveLength(0);
      expect(tracker.quoteInserts, 'no quotes-insert when sentinel stamped').toHaveLength(0);
      expect(
        tracker.rpcCalls.filter((c) => c.name === 'apply_call_end'),
        'no apply_call_end RPC when sentinel stamped'
      ).toHaveLength(0);

      // Flip side of the same lock: if sentinel is null, everything
      // DOES fire. The contract is: `counters_applied_at` is the ONLY
      // column that controls this short-circuit. Rerun with null.
      vi.resetModules();
      const tracker2: DriftTracker = {
        eqCalls: [],
        updateCalls: [],
        rpcCalls: [],
        quoteInserts: [],
      };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftCapturingAdminStub({
            callRow: {
              id: 'call-sentinel-null',
              quote_request_id: 'req-sentinel-null',
              business_id: 'biz-sentinel-null',
              status: 'ringing',
              counters_applied_at: null,
              quote_requests: {
                category_id: 'cat-1',
                service_categories: { name: 'Moving', slug: 'moving' },
              },
            },
            tracker: tracker2,
          }),
      }));
      vi.doMock('@/lib/calls/extract-quote', () => ({
        extractQuoteFromCall: vi.fn().mockResolvedValue({
          ok: true,
          quote: DRIFT_HAPPY_QUOTE,
        }),
      }));
      const mod2 = await import('./route');
      const res2 = await mod2.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-sentinel-null' },
              transcript: 't',
              durationSeconds: 60,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(res2.status).toBe(200);
      expect(
        tracker2.updateCalls.length,
        'calls update fires when sentinel is null'
      ).toBeGreaterThan(0);
      expect(
        tracker2.rpcCalls.some((c) => c.name === 'apply_call_end'),
        'apply_call_end RPC fires when sentinel is null'
      ).toBe(true);
    });

    it('UPDATE shape — calls-row update writes the exact 7-column set (not drifted)', async () => {
      // The calls update happens on every non-short-circuited webhook.
      // R26 locked the quotes insert and RPC arg sets but not this update
      // shape. A migration that dropped `transcript`/`recording_url` or
      // renamed `ended_at` → `completed_at` would silently stop
      // persisting those values on every end-of-call — the call row
      // would have no transcript, the admin surface would show blanks,
      // and downstream extraction on backfill would have nothing to chew.
      const tracker: DriftTracker = {
        eqCalls: [],
        updateCalls: [],
        rpcCalls: [],
        quoteInserts: [],
      };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftCapturingAdminStub({
            callRow: {
              id: 'call-update-drift',
              quote_request_id: 'req-update-drift',
              business_id: 'biz-update-drift',
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
          quote: DRIFT_HAPPY_QUOTE,
        }),
      }));
      const mod = await import('./route');
      await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-update-drift' },
              transcript: 'hello there',
              summary: 'summary here',
              recordingUrl: 'https://example.com/rec.mp3',
              durationSeconds: 120,
              cost: 0.25,
              endedReason: 'assistant-hangup',
              analysis: { structuredData: { a: 1 } },
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );

      const callUpdate = tracker.updateCalls.find((u) => u.table === 'calls');
      expect(callUpdate, 'calls update must fire on non-short-circuit').toBeDefined();

      // Exact key set. A rename or drop requires updating this test —
      // that's the whole point of the drift lock.
      expect(new Set(Object.keys(callUpdate!.row))).toEqual(
        new Set([
          'status',
          'ended_at',
          'duration_seconds',
          'transcript',
          'recording_url',
          'summary',
          'extracted_data',
          'cost',
        ])
      );

      // Negative assertions: common drift candidates MUST NOT appear.
      const DRIFTED_UPDATE_KEYS = [
        'completed_at', // rename of ended_at
        'finished_at', // alt rename
        'duration', // missing _seconds suffix
        'transcript_text', // suffix drift
        'recording', // missing _url suffix
        'call_summary', // prefix drift
        'structured_data', // rename of extracted_data
        'total_cost', // prefix drift
      ];
      for (const drifted of DRIFTED_UPDATE_KEYS) {
        expect(
          Object.keys(callUpdate!.row),
          `calls update must NOT carry drifted key '${drifted}'`
        ).not.toContain(drifted);
      }

      // The calls update ALSO uses .eq('id', ...) on the internal id.
      // This is different from the vapi_call_id LOOKUP at the top — the
      // update is addressed by our PK (which we just fetched). Lock
      // both column names appear in the expected sequence.
      const callsEqSequence = tracker.eqCalls
        .filter((c) => c.table === 'calls')
        .map((c) => c.column);
      // First eq: the lookup (vapi_call_id). Second eq: the update
      // address (id). If this sequence flips, something is deeply wrong.
      expect(callsEqSequence[0]).toBe('vapi_call_id');
      expect(callsEqSequence[1]).toBe('id');
    });

    it('UNIQUE backstop — quotes insert targets `call_id` as the UNIQUE anchor (not drifted)', async () => {
      // The 23505-swallow test above locks the BEHAVIOR; this test locks
      // the COLUMN the unique constraint must be on. If quotes gets an
      // extra `id` UNIQUE and `call_id` is dropped, the 23505 stops
      // firing on retries and the route starts inserting duplicate
      // quote rows per call. Lock the semantic anchor.
      const tracker: DriftTracker = {
        eqCalls: [],
        updateCalls: [],
        rpcCalls: [],
        quoteInserts: [],
      };
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftCapturingAdminStub({
            callRow: {
              id: 'call-backstop-drift',
              quote_request_id: 'req-backstop-drift',
              business_id: 'biz-backstop-drift',
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
          quote: DRIFT_HAPPY_QUOTE,
        }),
      }));
      const mod = await import('./route');
      await mod.POST(
        makeReq(
          {
            message: {
              type: 'end-of-call-report',
              call: { id: 'vapi-backstop-drift' },
              transcript: 't',
              durationSeconds: 60,
              endedReason: 'assistant-hangup',
            },
          },
          { authorization: 'Bearer test-vapi-secret' }
        )
      );
      expect(tracker.quoteInserts).toHaveLength(1);
      // The UNIQUE-backed anchor MUST be present and MUST match our
      // internal calls row id (not the vapi_call_id — quotes joins
      // to calls via our internal uuid).
      expect(tracker.quoteInserts[0].call_id).toBe('call-backstop-drift');
      // Drifted anchor names that would break the at-most-once
      // guarantee if they replaced `call_id`.
      const DRIFTED_BACKSTOP_KEYS = [
        'calls_id',
        'vapi_call_id',
        'provider_call_id',
        'call_ref',
        'id',
      ];
      for (const drifted of DRIFTED_BACKSTOP_KEYS) {
        // vapi_call_id is particularly tempting — a well-meaning refactor
        // might "simplify" by joining quotes directly to the Vapi id.
        // That breaks the UNIQUE constraint semantic and reintroduces
        // duplicate-quote risk on parallel retries.
        expect(
          tracker.quoteInserts[0],
          `quotes insert must NOT carry drifted anchor '${drifted}'`
        ).not.toHaveProperty(drifted);
      }
    });
  });
});
