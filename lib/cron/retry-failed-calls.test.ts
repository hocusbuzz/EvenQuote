// Tests for retryFailedCalls — the worker that re-dispatches calls
// whose initial Vapi dispatch failed (status='failed' AND started_at
// IS NULL). Exercises:
//   • candidate query filters (status, started_at null, retry_count<3,
//     24h window, ordering, limit)
//   • per-row throttle by last_retry_at
//   • successful retry updates calls row to in_progress with new
//     vapi_call_id
//   • failed retry bumps retry_count + last_retry_at, leaves status=failed
//   • exhaustion (retry_count → 3) fires apply_call_end with
//     p_quote_inserted=false so the request can advance
//   • apply_call_end failure on exhaustion is logged but does not throw
//
// Supabase is stubbed; startOutboundCall is mocked at module level.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const startOutboundSpy = vi.fn();
vi.mock('@/lib/calls/vapi', () => ({
  startOutboundCall: (...args: unknown[]) => startOutboundSpy(...args),
}));

// R27 capture-site audit: stub Sentry at the module boundary so tests
// can assert canonical `{lib:'cron-retry-failed-calls', reason}` tag
// shapes. Mock is hoisted above the import under test.
const captureExceptionSpy = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionSpy(...args),
  captureMessage: vi.fn(),
}));

// Import after the mock is registered.
import { retryFailedCalls } from './retry-failed-calls';

// ─── Stub factory ─────────────────────────────────────────────────────

type CandidateRow = {
  id: string;
  quote_request_id: string;
  business_id: string;
  retry_count: number;
  last_retry_at: string | null;
  created_at: string;
  businesses: { name: string; phone: string } | null;
  quote_requests:
    | {
        intake_data: Record<string, unknown> | null;
        city: string | null;
        state: string | null;
        zip_code: string | null;
      }
    | null;
};

type StubState = {
  candidates: CandidateRow[];
  candidatesError: { message: string } | null;
  // Each entry captures one .update() payload against calls.
  callsUpdates: Array<{ id: string; payload: Record<string, unknown> }>;
  callsUpdateError: { message: string } | null;
  rpcCalls: Array<{ fn: string; args: unknown }>;
  applyCallEndError: { message: string } | null;
  // Captured select query shape, for assertion on filters.
  capturedCallsQuery: {
    filters: Record<string, unknown>;
    isNullCols: string[];
    ltFilters: Record<string, unknown>;
    gteFilters: Record<string, unknown>;
    ordering: Array<{ col: string; asc?: boolean; nullsFirst?: boolean }>;
    limit?: number;
  };
};

function makeAdmin(initial: Partial<StubState> = {}): {
  admin: SupabaseClient;
  state: StubState;
} {
  const state: StubState = {
    candidates: [],
    candidatesError: null,
    callsUpdates: [],
    callsUpdateError: null,
    rpcCalls: [],
    applyCallEndError: null,
    capturedCallsQuery: {
      filters: {},
      isNullCols: [],
      ltFilters: {},
      gteFilters: {},
      ordering: [],
    },
    ...initial,
  };

  const admin = {
    from: (table: string) => {
      if (table !== 'calls') {
        throw new Error(`unexpected table ${table}`);
      }

      return {
        select: (_cols: string) => {
          const api: Record<string, unknown> = {};
          api.eq = (col: string, val: unknown) => {
            state.capturedCallsQuery.filters[col] = val;
            return api;
          };
          api.is = (col: string, val: unknown) => {
            if (val === null) state.capturedCallsQuery.isNullCols.push(col);
            return api;
          };
          api.lt = (col: string, val: unknown) => {
            state.capturedCallsQuery.ltFilters[col] = val;
            return api;
          };
          api.gte = (col: string, val: unknown) => {
            state.capturedCallsQuery.gteFilters[col] = val;
            return api;
          };
          api.order = (
            col: string,
            opts?: { ascending?: boolean; nullsFirst?: boolean }
          ) => {
            state.capturedCallsQuery.ordering.push({
              col,
              asc: opts?.ascending,
              nullsFirst: opts?.nullsFirst,
            });
            return api;
          };
          api.limit = (n: number) => {
            state.capturedCallsQuery.limit = n;
            return Promise.resolve({
              data: state.candidatesError ? null : state.candidates,
              error: state.candidatesError,
            });
          };
          return api;
        },
        update: (payload: Record<string, unknown>) => {
          // Two chain shapes both terminate here:
          //
          //   1. Direct fire-and-forget:   .update(...).eq('id', X)
          //      → resolves to { error }.
          //
          //   2. CAS-guarded write (R47.4):
          //      .update(...).eq('id', X).eq('retry_count', N)
          //      → resolves the same way; the CAS column doesn't
          //        change semantics for the mock.
          const finalize = (id: string) => {
            state.callsUpdates.push({ id, payload });
            return Promise.resolve({
              data: null,
              error: state.callsUpdateError,
            });
          };
          return {
            eq: (col: string, val: unknown) => {
              if (col === 'id') {
                const id = val as string;
                const terminator: Record<string, unknown> = {
                  // CAS chain: second .eq() returns the resolved
                  // promise. Awaiting `.eq().eq()` is fine because
                  // promises chain through the .then on the result.
                  eq: (_col2: string, _val2: unknown) => finalize(id),
                  // Direct chain: bare .then so awaiting after the
                  // single .eq() works.
                  then: (resolve: (v: unknown) => unknown) =>
                    finalize(id).then(resolve),
                };
                return terminator;
              }
              return finalize('');
            },
          };
        },
      };
    },
    rpc: (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      if (fn === 'apply_call_end') {
        return Promise.resolve({
          data: null,
          error: state.applyCallEndError,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;

  return { admin, state };
}

// ─── Fixtures ─────────────────────────────────────────────────────────

function candidate(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 'call_1',
    quote_request_id: 'qr_1',
    business_id: 'biz_1',
    retry_count: 0,
    last_retry_at: null,
    created_at: new Date().toISOString(),
    businesses: { name: 'Acme Movers', phone: '+14155551234' },
    quote_requests: {
      intake_data: {
        // PII — must NOT leak through.
        contact_name: 'Alex',
        contact_email: 'alex@example.com',
        contact_phone: '+14155559999',
        address: '123 Main St',
        // Allowlisted real intake fields.
        home_size: '2 bedroom',
        special_items: ['stairs', 'piano'],
      },
      city: 'San Francisco',
      state: 'CA',
      zip_code: '94110',
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('retryFailedCalls', () => {
  beforeEach(() => {
    startOutboundSpy.mockReset();
    captureExceptionSpy.mockReset();
  });

  it('returns zero counts when there are no candidates', async () => {
    const { admin } = makeAdmin({ candidates: [] });
    const result = await retryFailedCalls(admin);
    expect(result).toMatchObject({
      ok: true,
      scanned: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
      throttled: 0,
    });
    expect(startOutboundSpy).not.toHaveBeenCalled();
  });

  it('applies the correct candidate query — status, started_at null, retry_count<1, 24h window', async () => {
    const { admin, state } = makeAdmin({ candidates: [] });
    await retryFailedCalls(admin);

    expect(state.capturedCallsQuery.filters).toMatchObject({
      status: 'failed',
    });
    expect(state.capturedCallsQuery.isNullCols).toContain('started_at');
    // Cost control: cap total attempts per business at 2 (initial
    // dispatch + 1 retry). Was retry_count<3 pre-launch — dropped to <1
    // after per-call spend audit showed dispatch retries were a minor
    // share of overall cost while eating margin.
    expect(state.capturedCallsQuery.ltFilters).toMatchObject({
      retry_count: 1,
    });
    // 24h window: gte on created_at with an ISO string roughly 24h ago.
    const windowStart = state.capturedCallsQuery.gteFilters['created_at'];
    expect(typeof windowStart).toBe('string');
    const diffMs = Date.now() - new Date(windowStart as string).getTime();
    expect(diffMs).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    expect(diffMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
    // Ordered by last_retry_at asc, nullsFirst=true so never-retried
    // rows surface first.
    expect(state.capturedCallsQuery.ordering[0]).toMatchObject({
      col: 'last_retry_at',
      asc: true,
      nullsFirst: true,
    });
    // Cap of 25 per run — prevents the worker from blowing past its
    // serverless time budget.
    expect(state.capturedCallsQuery.limit).toBe(25);
  });

  it('returns ok:false when candidate query errors', async () => {
    const { admin } = makeAdmin({
      candidatesError: { message: 'connection reset' },
    });
    const result = await retryFailedCalls(admin);
    expect(result.ok).toBe(false);
    expect(result.notes[0]).toMatch(/candidate query/);
    expect(result.notes[0]).toMatch(/connection reset/);
  });

  it('throttles rows with last_retry_at within 5 minutes', async () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { admin, state } = makeAdmin({
      candidates: [candidate({ last_retry_at: oneMinuteAgo })],
    });

    const result = await retryFailedCalls(admin);

    expect(result.throttled).toBe(1);
    expect(result.retried).toBe(0);
    expect(startOutboundSpy).not.toHaveBeenCalled();
    expect(state.callsUpdates).toHaveLength(0);
  });

  it('does NOT throttle rows where last_retry_at is older than 5 minutes', async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    startOutboundSpy.mockResolvedValue({
      ok: true,
      simulated: false,
      vapiCallId: 'vapi_new_1',
    });
    const { admin } = makeAdmin({
      candidates: [candidate({ last_retry_at: sixMinutesAgo })],
    });

    const result = await retryFailedCalls(admin);

    expect(result.throttled).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('successful retry: calls Vapi with correct args, updates row to in_progress with new vapi_call_id', async () => {
    startOutboundSpy.mockResolvedValue({
      ok: true,
      simulated: false,
      vapiCallId: 'vapi_new_xyz',
    });
    const { admin, state } = makeAdmin({
      candidates: [candidate({ retry_count: 0 })],
    });

    const result = await retryFailedCalls(admin);

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    // startOutboundCall args — metadata carries the retry attempt.
    expect(startOutboundSpy).toHaveBeenCalledTimes(1);
    const args = startOutboundSpy.mock.calls[0][0];
    expect(args.toPhone).toBe('+14155551234');
    expect(args.businessName).toBe('Acme Movers');
    expect(args.metadata.call_id).toBe('call_1');
    expect(args.metadata.quote_request_id).toBe('qr_1');
    expect(args.metadata.business_id).toBe('biz_1');
    expect(args.metadata.retry_attempt).toBe('1');

    // R49 / task #116 — buildSafeVariableValues uses an allowlist.
    // PII keys (contact_name, contact_phone, contact_email, address)
    // MUST NOT leak through; only allowlisted intake fields + city/
    // state/zip from the qr row reach the assistant.
    expect(args.variableValues.contact_name).toBeUndefined();
    expect(args.variableValues.contact_email).toBeUndefined();
    expect(args.variableValues.contact_phone).toBeUndefined();
    expect(args.variableValues.address).toBeUndefined();
    // Allowlisted intake fields pass through; arrays are joined.
    expect(args.variableValues.home_size).toBe('2 bedroom');
    expect(args.variableValues.special_items).toBe('stairs, piano');
    // Top-level qr fields propagate so the assistant has a service area.
    expect(args.variableValues.city).toBe('San Francisco');
    expect(args.variableValues.state).toBe('CA');
    expect(args.variableValues.zip_code).toBe('94110');

    // R47.4 — TWO row updates:
    //   1. Pre-mark BEFORE dialing: retry_count + last_retry_at.
    //      Throttle gate so a worst-case "dial succeeded but every
    //      subsequent write failed" scenario doesn't double-dial on
    //      the next cron tick.
    //   2. Post-dispatch on success: status='in_progress' +
    //      vapi_call_id + started_at.
    expect(state.callsUpdates).toHaveLength(2);
    expect(state.callsUpdates[0].id).toBe('call_1');
    expect(state.callsUpdates[0].payload).toMatchObject({
      retry_count: 1,
    });
    expect(state.callsUpdates[0].payload.last_retry_at).toBeDefined();
    expect(state.callsUpdates[1].id).toBe('call_1');
    expect(state.callsUpdates[1].payload).toMatchObject({
      status: 'in_progress',
      vapi_call_id: 'vapi_new_xyz',
    });
    expect(state.callsUpdates[1].payload.started_at).toBeDefined();

    // No apply_call_end yet — we haven't exhausted retries.
    expect(
      state.rpcCalls.filter((c) => c.fn === 'apply_call_end')
    ).toHaveLength(0);
  });

  it('exhaustion: a failed retry pushes retry_count to 1 and fires apply_call_end with p_quote_inserted=false', async () => {
    // Under the 2-total-attempts cap, any failed retry IS the
    // exhaustion: retry_count 0 → 1 hits the ceiling. There's no
    // intermediate "bumped retry_count but not yet exhausted" state.
    startOutboundSpy.mockResolvedValue({
      ok: false,
      simulated: false,
      error: 'HTTP 502 Bad Gateway',
    });
    const { admin, state } = makeAdmin({
      candidates: [candidate({ retry_count: 0 })],
    });

    const result = await retryFailedCalls(admin);

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(state.callsUpdates).toHaveLength(1);
    expect(state.callsUpdates[0].payload.retry_count).toBe(1);
    expect(state.callsUpdates[0].payload.last_retry_at).toEqual(expect.any(String));

    // apply_call_end must fire exactly once with the right args. This
    // is the fix for the stuck-batch bug — without it, a permanently-
    // dead number strands the whole quote_request in 'calling' forever.
    const applyCalls = state.rpcCalls.filter(
      (c) => c.fn === 'apply_call_end'
    );
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].args).toEqual({
      p_request_id: 'qr_1',
      p_call_id: 'call_1',
      p_quote_inserted: false,
    });

    expect(result.notes.join(' ')).toMatch(/exhausted/);
    expect(result.notes.join(' ')).toMatch(/HTTP 502/);
  });

  it('apply_call_end failure on exhaustion is logged but does NOT throw', async () => {
    startOutboundSpy.mockResolvedValue({
      ok: false,
      simulated: false,
      error: 'peer unreachable',
    });
    const { admin, state } = makeAdmin({
      candidates: [candidate({ retry_count: 0 })],
      applyCallEndError: { message: 'deadlock detected' },
    });

    // Must not throw.
    const result = await retryFailedCalls(admin);

    expect(result.ok).toBe(true);
    expect(result.failed).toBe(1);
    // Note must surface the apply_call_end failure so ops can see it.
    expect(result.notes.join(' ')).toMatch(/apply_call_end/);
    expect(result.notes.join(' ')).toMatch(/deadlock/);
    expect(state.rpcCalls).toHaveLength(1);
  });

  it('skips rows where the business/request join is null and records a note', async () => {
    const { admin, state } = makeAdmin({
      candidates: [
        candidate({ businesses: null }),
        candidate({ id: 'call_2', quote_requests: null }),
      ],
    });

    const result = await retryFailedCalls(admin);

    expect(result.retried).toBe(0);
    expect(startOutboundSpy).not.toHaveBeenCalled();
    expect(state.callsUpdates).toHaveLength(0);
    expect(result.notes.filter((n) => n.includes('missing'))).toHaveLength(2);
  });

  it('flattens array-shaped joins — supabase-js returns [obj] for nested selects', async () => {
    startOutboundSpy.mockResolvedValue({
      ok: true,
      simulated: false,
      vapiCallId: 'vapi_from_array',
    });
    const row = candidate();
    // supabase-js can return joined rows as single-element arrays depending
    // on cardinality; flattenOne in the worker handles that shape.
    const arrayShaped = {
      ...row,
      businesses: [row.businesses!],
      quote_requests: [row.quote_requests!],
    } as unknown as CandidateRow;
    const { admin } = makeAdmin({ candidates: [arrayShaped] });

    const result = await retryFailedCalls(admin);

    expect(result.succeeded).toBe(1);
    expect(startOutboundSpy).toHaveBeenCalledTimes(1);
    const args = startOutboundSpy.mock.calls[0][0];
    expect(args.toPhone).toBe('+14155551234');
    expect(args.businessName).toBe('Acme Movers');
  });

  it('processes multiple candidates in one run, preserving counters', async () => {
    startOutboundSpy
      .mockResolvedValueOnce({
        ok: true,
        simulated: false,
        vapiCallId: 'vapi_a',
      })
      .mockResolvedValueOnce({
        ok: false,
        simulated: false,
        error: 'timeout',
      });

    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

    const { admin } = makeAdmin({
      candidates: [
        candidate({ id: 'c1', last_retry_at: null }),
        candidate({ id: 'c2', last_retry_at: sixMinutesAgo }),
        candidate({ id: 'c3', last_retry_at: oneMinuteAgo }), // throttled
      ],
    });

    const result = await retryFailedCalls(admin);

    expect(result.scanned).toBe(3);
    expect(result.retried).toBe(2);
    expect(result.throttled).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('skips the dispatch entirely when the pre-mark write fails', async () => {
    // R47.4: write order changed. The retry_count + last_retry_at
    // pre-mark happens BEFORE the dispatch now, so an RLS denial
    // here means we never call Vapi at all — better than letting
    // a throttle-gate-less dispatch race on the next cron tick.
    const { admin, state } = makeAdmin({
      candidates: [candidate()],
      callsUpdateError: { message: 'RLS denied' },
    });

    const result = await retryFailedCalls(admin);

    // No dispatch attempted — the pre-mark write failed.
    expect(startOutboundSpy).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(0);
    expect(result.notes.join(' ')).toMatch(
      /pre-mark write failed, skipping dispatch/
    );
    // Single update attempt (the failed pre-mark) was recorded.
    expect(state.callsUpdates).toHaveLength(1);
  });

  // ── R27: lib-level capture-site audit ────────────────────────────
  //
  // Two genuinely silent failure paths in this module pre-R27:
  //
  //   (a) candidateQueryFailed — the initial .select().eq().is()...
  //       query returns `{ok:false, notes:[...]}` WITHOUT throwing.
  //       The route handler at app/api/cron/retry-failed-calls/route.ts
  //       wraps retryFailedCalls in try/catch, but ok:false does not
  //       propagate as a throw → Sentry silent. An RLS drift on
  //       `calls` or a table rename would stop the retry worker
  //       indefinitely with zero pages.
  //
  //   (b) applyCallEndFailed — the exact "stuck-batch" bug the code's
  //       own comments name. If apply_call_end for an exhausted row
  //       errors, the quote_request sits in status='calling' forever,
  //       send-reports never picks it up, customer paid and got nothing.
  //
  // Both now capture with `{lib:'cron-retry-failed-calls', reason}`.
  // The allow-list is locked by the regression-guard test below.
  describe('captureException tag shape (R27)', () => {
    it('(a) candidate query error fires candidateQueryFailed with {lib, reason}', async () => {
      const { admin } = makeAdmin({
        candidatesError: { message: 'permission denied for table calls' },
      });

      const result = await retryFailedCalls(admin);
      expect(result.ok).toBe(false);

      expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
      const [err, ctx] = captureExceptionSpy.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('permission denied for table calls');
      expect(ctx).toEqual({
        tags: {
          lib: 'cron-retry-failed-calls',
          reason: 'candidateQueryFailed',
        },
      });
    });

    it('(b) apply_call_end error on exhausted row fires applyCallEndFailed with callId + quoteRequestId', async () => {
      // Setup: a candidate at retry_count=0 fails its retry attempt,
      // tipping retry_count → 1 (the exhaustion threshold). The code
      // then calls apply_call_end, which errors.
      startOutboundSpy.mockResolvedValue({ ok: false, error: 'vapi 500' });
      const { admin } = makeAdmin({
        candidates: [
          candidate({
            id: 'call_exhausted',
            quote_request_id: 'qr_stuck',
            retry_count: 0,
          }),
        ],
        applyCallEndError: { message: 'fn does not exist' },
      });

      await retryFailedCalls(admin);

      expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
      const [err, ctx] = captureExceptionSpy.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('fn does not exist');
      expect(ctx).toEqual({
        tags: {
          lib: 'cron-retry-failed-calls',
          reason: 'applyCallEndFailed',
          callId: 'call_exhausted',
          quoteRequestId: 'qr_stuck',
        },
      });
      // PII negative: no phone/email leak into tags. Tag values must
      // be opaque IDs only.
      for (const v of Object.values(
        (ctx as { tags: Record<string, string> }).tags
      )) {
        expect(v).not.toMatch(/@/);
        expect(v).not.toMatch(/\+?\d{10,}/);
      }
    });

    it('regression-guard: no catch-all reason values — every capture carries a canonical reason', async () => {
      const ALLOWED = new Set<string>([
        'candidateQueryFailed',
        'applyCallEndFailed',
      ]);

      // Fire both capture sites in sequence. Can't do them in one
      // retryFailedCalls call because candidateQueryFailed returns
      // early. Run two separate calls and assert across both.
      const { admin: admin1 } = makeAdmin({
        candidatesError: { message: 'scan fail' },
      });
      await retryFailedCalls(admin1);

      startOutboundSpy.mockResolvedValue({ ok: false, error: 'vapi bad' });
      const { admin: admin2 } = makeAdmin({
        candidates: [
          candidate({
            id: 'call_regression',
            quote_request_id: 'qr_regression',
            retry_count: 0,
          }),
        ],
        applyCallEndError: { message: 'rpc fail' },
      });
      await retryFailedCalls(admin2);

      expect(captureExceptionSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, ctx] of captureExceptionSpy.mock.calls) {
        const tags = (ctx as { tags?: Record<string, string> })?.tags;
        expect(tags?.lib).toBe('cron-retry-failed-calls');
        const reason = tags?.reason;
        expect(reason, `missing reason in tags: ${JSON.stringify(tags)}`).toBeDefined();
        expect(
          ALLOWED.has(String(reason)),
          `reason "${reason}" is not in the allow-list`
        ).toBe(true);
        // Explicit catch-all guards.
        expect(reason).not.toBe('retryFailed');
        expect(reason).not.toBe('runFailed');
        expect(reason).not.toBe('unknown');
        expect(reason).not.toBe('error');
      }
    });
  });
});
