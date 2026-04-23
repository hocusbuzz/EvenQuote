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
  quote_requests: { intake_data: Record<string, unknown> | null } | null;
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
        update: (payload: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            state.callsUpdates.push({ id, payload });
            return Promise.resolve({
              data: null,
              error: state.callsUpdateError,
            });
          },
        }),
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
        contact_name: 'Alex',
        contact_email: 'alex@example.com',
        contact_phone: '+14155559999',
        move_type: 'studio',
        rooms: 2,
        tags: ['stairs', 'piano'],
      },
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('retryFailedCalls', () => {
  beforeEach(() => {
    startOutboundSpy.mockReset();
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

  it('applies the correct candidate query — status, started_at null, retry_count<3, 24h window', async () => {
    const { admin, state } = makeAdmin({ candidates: [] });
    await retryFailedCalls(admin);

    expect(state.capturedCallsQuery.filters).toMatchObject({
      status: 'failed',
    });
    expect(state.capturedCallsQuery.isNullCols).toContain('started_at');
    expect(state.capturedCallsQuery.ltFilters).toMatchObject({
      retry_count: 3,
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
      candidates: [candidate({ retry_count: 1 })],
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
    expect(args.metadata.retry_attempt).toBe('2');

    // variableValues strip business-reachable keys (contact_email, contact_phone) and
    // flatten arrays/primitives. Source intake has both PII keys plus tags as array.
    expect(args.variableValues.contact_name).toBe('Alex');
    expect(args.variableValues.move_type).toBe('studio');
    expect(args.variableValues.rooms).toBe(2);
    expect(args.variableValues.tags).toBe('stairs, piano');
    // BUSINESS_REACHABLE_KEYS must NOT leak through.
    expect(args.variableValues.contact_email).toBeUndefined();
    expect(args.variableValues.contact_phone).toBeUndefined();

    // Row update: status flipped, new vapi_call_id, retry_count+1,
    // last_retry_at populated.
    expect(state.callsUpdates).toHaveLength(1);
    expect(state.callsUpdates[0].id).toBe('call_1');
    expect(state.callsUpdates[0].payload).toMatchObject({
      status: 'in_progress',
      vapi_call_id: 'vapi_new_xyz',
      retry_count: 2,
    });
    expect(state.callsUpdates[0].payload.started_at).toBeDefined();
    expect(state.callsUpdates[0].payload.last_retry_at).toBeDefined();

    // No apply_call_end yet — we haven't exhausted retries.
    expect(
      state.rpcCalls.filter((c) => c.fn === 'apply_call_end')
    ).toHaveLength(0);
  });

  it('failed retry: leaves status=failed, bumps retry_count + last_retry_at, records note', async () => {
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
    // Payload for failed retry should ONLY touch retry_count + last_retry_at.
    expect(state.callsUpdates[0].payload).toMatchObject({
      retry_count: 1,
      last_retry_at: expect.any(String),
    });
    // status and vapi_call_id must NOT be set on the failure path.
    expect(state.callsUpdates[0].payload.status).toBeUndefined();
    expect(state.callsUpdates[0].payload.vapi_call_id).toBeUndefined();

    // apply_call_end must NOT fire — retry_count is 1, not yet 3.
    expect(
      state.rpcCalls.filter((c) => c.fn === 'apply_call_end')
    ).toHaveLength(0);

    expect(result.notes.join(' ')).toMatch(/HTTP 502/);
  });

  it('exhaustion: when retry pushes retry_count to 3, fires apply_call_end with p_quote_inserted=false', async () => {
    startOutboundSpy.mockResolvedValue({
      ok: false,
      simulated: false,
      error: 'peer unreachable',
    });
    // retry_count=2, so this failure makes it 3 → exhausted.
    const { admin, state } = makeAdmin({
      candidates: [candidate({ retry_count: 2 })],
    });

    const result = await retryFailedCalls(admin);

    expect(result.failed).toBe(1);
    expect(state.callsUpdates[0].payload.retry_count).toBe(3);

    // apply_call_end must fire exactly once with the right args. This is
    // the fix for the stuck-batch bug — without it, a permanently-dead
    // number strands the whole quote_request in 'calling' forever.
    const applyCalls = state.rpcCalls.filter(
      (c) => c.fn === 'apply_call_end'
    );
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].args).toEqual({
      p_request_id: 'qr_1',
      p_quote_inserted: false,
    });

    expect(result.notes.join(' ')).toMatch(/exhausted/);
  });

  it('apply_call_end failure on exhaustion is logged but does NOT throw', async () => {
    startOutboundSpy.mockResolvedValue({
      ok: false,
      simulated: false,
      error: 'peer unreachable',
    });
    const { admin, state } = makeAdmin({
      candidates: [candidate({ retry_count: 2 })],
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

  it('records a note when the calls row update fails after a successful dispatch', async () => {
    startOutboundSpy.mockResolvedValue({
      ok: true,
      simulated: false,
      vapiCallId: 'vapi_zzz',
    });
    const { admin, state } = makeAdmin({
      candidates: [candidate()],
      callsUpdateError: { message: 'RLS denied' },
    });

    const result = await retryFailedCalls(admin);

    // Dispatch succeeded — succeeded counter increments even though the
    // row update failed. The note makes the discrepancy visible.
    expect(result.succeeded).toBe(1);
    expect(result.notes.join(' ')).toMatch(/dispatched but row update failed/);
    expect(state.callsUpdates).toHaveLength(1);
  });
});
