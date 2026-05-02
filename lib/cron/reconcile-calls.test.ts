// Tests for reconcileStuckCalls — the cron that reconciles calls
// stranded by dropped end-of-call webhooks.
//
// Boundaries we mock:
//   • @/lib/calls/vapi             → getVapiCall (controls Vapi response)
//   • @/lib/calls/apply-end-of-call → applyEndOfCall (assert payload shape)
//   • @/lib/observability/sentry    → captureException (assert tag shape)
//
// Supabase admin is stubbed inline. The reconciler only reads the
// `calls` table — applyEndOfCall handles all writes through its own
// (mocked) path — so the stub only needs the SELECT chain.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const getVapiCallSpy = vi.fn();
const vapiCallDurationSecondsSpy = vi.fn(
  (rec: { durationSeconds?: number; duration?: number }) =>
    rec.durationSeconds ?? rec.duration,
);
vi.mock('@/lib/calls/vapi', () => ({
  getVapiCall: (...args: unknown[]) => getVapiCallSpy(...args),
  vapiCallDurationSeconds: (...args: unknown[]) =>
    vapiCallDurationSecondsSpy(...(args as [Parameters<typeof vapiCallDurationSecondsSpy>[0]])),
}));

const applyEndOfCallSpy = vi.fn();
vi.mock('@/lib/calls/apply-end-of-call', () => ({
  applyEndOfCall: (...args: unknown[]) => applyEndOfCallSpy(...args),
}));

const captureExceptionSpy = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionSpy(...args),
  captureMessage: vi.fn(),
}));

// Import under test AFTER all mocks are registered.
import { reconcileStuckCalls } from './reconcile-calls';

// ─── Stub factory ─────────────────────────────────────────────────────

type StuckRow = {
  id: string;
  vapi_call_id: string;
  status: string;
  started_at: string | null;
  created_at: string;
};

type StubState = {
  candidates: StuckRow[];
  candidatesError: { message: string } | null;
  capturedQuery: {
    /** column args passed to .not(col, 'is', null) */
    notNullCols: string[];
    /** column args passed to .is(col, null) */
    isNullCols: string[];
    /** {col: values} from .in(col, vals) */
    inFilters: Record<string, unknown>;
    /** {col: val} from .lt(col, val) */
    ltFilters: Record<string, unknown>;
    ordering: Array<{ col: string; ascending?: boolean }>;
    limit?: number;
    selectCols?: string;
  };
};

function makeAdmin(initial: Partial<StubState> = {}): {
  admin: SupabaseClient;
  state: StubState;
} {
  const state: StubState = {
    candidates: [],
    candidatesError: null,
    capturedQuery: {
      notNullCols: [],
      isNullCols: [],
      inFilters: {},
      ltFilters: {},
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
        select: (cols: string) => {
          state.capturedQuery.selectCols = cols;
          const api: Record<string, unknown> = {};
          api.not = (col: string, op: string, val: unknown) => {
            // We only use .not(col, 'is', null) — record the column.
            if (op === 'is' && val === null) {
              state.capturedQuery.notNullCols.push(col);
            }
            return api;
          };
          api.is = (col: string, val: unknown) => {
            if (val === null) state.capturedQuery.isNullCols.push(col);
            return api;
          };
          api.in = (col: string, vals: unknown) => {
            state.capturedQuery.inFilters[col] = vals;
            return api;
          };
          api.lt = (col: string, val: unknown) => {
            state.capturedQuery.ltFilters[col] = val;
            return api;
          };
          api.order = (col: string, opts?: { ascending?: boolean }) => {
            state.capturedQuery.ordering.push({
              col,
              ascending: opts?.ascending,
            });
            return api;
          };
          api.limit = (n: number) => {
            state.capturedQuery.limit = n;
            return Promise.resolve({
              data: state.candidatesError ? null : state.candidates,
              error: state.candidatesError,
            });
          };
          return api;
        },
      };
    },
  } as unknown as SupabaseClient;

  return { admin, state };
}

function row(overrides: Partial<StuckRow> = {}): StuckRow {
  return {
    id: 'call_int_1',
    vapi_call_id: 'vapi_abc',
    status: 'in_progress',
    started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('reconcileStuckCalls', () => {
  beforeEach(() => {
    getVapiCallSpy.mockReset();
    applyEndOfCallSpy.mockReset();
    captureExceptionSpy.mockReset();
  });

  it('returns zero counts when no stuck candidates exist', async () => {
    const { admin } = makeAdmin({ candidates: [] });
    const result = await reconcileStuckCalls(admin);
    expect(result).toMatchObject({
      ok: true,
      scanned: 0,
      reconciled: 0,
      stillActive: 0,
      notFound: 0,
      failed: 0,
      rateLimited: false,
    });
    expect(getVapiCallSpy).not.toHaveBeenCalled();
    expect(applyEndOfCallSpy).not.toHaveBeenCalled();
  });

  it('applies the correct candidate query: vapi_call_id NOT NULL, ended_at IS NULL, status in (queued|in_progress), started_at older than 30 min', async () => {
    const { admin, state } = makeAdmin({ candidates: [] });
    await reconcileStuckCalls(admin);

    expect(state.capturedQuery.notNullCols).toContain('vapi_call_id');
    expect(state.capturedQuery.isNullCols).toContain('ended_at');
    expect(state.capturedQuery.inFilters['status']).toEqual([
      'queued',
      'in_progress',
    ]);

    const cutoff = state.capturedQuery.ltFilters['started_at'] as string;
    expect(typeof cutoff).toBe('string');
    const diffMs = Date.now() - new Date(cutoff).getTime();
    // Should be ~30 min ago (allow ±2 min slop for test scheduling).
    expect(diffMs).toBeGreaterThanOrEqual(28 * 60 * 1000);
    expect(diffMs).toBeLessThanOrEqual(32 * 60 * 1000);

    // Oldest-first so a backlog is processed FIFO, not LIFO. Avoids
    // permanent starvation of an old row when newer ones keep arriving.
    expect(state.capturedQuery.ordering[0]).toMatchObject({
      col: 'started_at',
      ascending: true,
    });
    // Hard cap to stay inside Vapi's per-key rate limit + the
    // serverless function timeout.
    expect(state.capturedQuery.limit).toBe(50);
  });

  it('returns ok:false and captures to Sentry when candidate query errors', async () => {
    const { admin } = makeAdmin({
      candidatesError: { message: 'permission denied for table calls' },
    });

    const result = await reconcileStuckCalls(admin);

    expect(result.ok).toBe(false);
    expect(result.notes[0]).toMatch(/candidate query/);
    expect(result.notes[0]).toMatch(/permission denied/);
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionSpy.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(ctx.tags).toMatchObject({
      lib: 'cron-reconcile-calls',
      reason: 'candidateQueryFailed',
    });
  });

  it('reconciles an ended call by handing it to applyEndOfCall with the shaped report', async () => {
    getVapiCallSpy.mockResolvedValue({
      ok: true,
      record: {
        id: 'vapi_abc',
        status: 'ended',
        endedReason: 'customer-ended-call',
        transcript: 'Hello, this is a test',
        summary: 'Customer wants quote for moving',
        recordingUrl: 'https://storage.vapi.ai/r/abc',
        cost: 0.42,
        durationSeconds: 87.3,
        analysis: {
          structuredData: { price: 250 },
          successEvaluation: 'PASS',
        },
      },
    });
    applyEndOfCallSpy.mockResolvedValue({
      applied: true,
      status: 'completed',
      quoteInserted: true,
    });
    const { admin } = makeAdmin({ candidates: [row()] });

    const result = await reconcileStuckCalls(admin);

    expect(result).toMatchObject({
      ok: true,
      scanned: 1,
      reconciled: 1,
      stillActive: 0,
      notFound: 0,
      failed: 0,
      rateLimited: false,
    });
    expect(getVapiCallSpy).toHaveBeenCalledWith('vapi_abc');
    expect(applyEndOfCallSpy).toHaveBeenCalledTimes(1);
    const [, vapiId, report] = applyEndOfCallSpy.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(vapiId).toBe('vapi_abc');
    expect(report).toMatchObject({
      type: 'end-of-call-report',
      callId: 'vapi_abc',
      transcript: 'Hello, this is a test',
      summary: 'Customer wants quote for moving',
      recordingUrl: 'https://storage.vapi.ai/r/abc',
      cost: 0.42,
      endedReason: 'customer-ended-call',
      analysis: {
        structuredData: { price: 250 },
        successEvaluation: 'PASS',
      },
    });
  });

  it('falls back to analysis.summary when top-level summary is absent', async () => {
    // Vapi has used both shapes over time. The webhook handler accepts
    // either, so the reconciler must too — otherwise reconciled rows
    // would have empty summaries that webhook-delivered rows would have.
    getVapiCallSpy.mockResolvedValue({
      ok: true,
      record: {
        status: 'ended',
        endedReason: 'customer-ended-call',
        analysis: { summary: 'fallback summary text' },
      },
    });
    applyEndOfCallSpy.mockResolvedValue({
      applied: true,
      status: 'completed',
      quoteInserted: false,
    });
    const { admin } = makeAdmin({ candidates: [row()] });

    await reconcileStuckCalls(admin);

    const [, , report] = applyEndOfCallSpy.mock.calls[0] as [
      unknown,
      string,
      { summary?: string },
    ];
    expect(report.summary).toBe('fallback summary text');
  });

  it('counts a still-active call as stillActive and skips applyEndOfCall (do NOT synthesize a completed status)', async () => {
    getVapiCallSpy.mockResolvedValue({
      ok: true,
      record: { id: 'vapi_abc', status: 'in-progress' },
    });
    const { admin } = makeAdmin({ candidates: [row()] });

    const result = await reconcileStuckCalls(admin);

    expect(result.stillActive).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(applyEndOfCallSpy).not.toHaveBeenCalled();
  });

  it('counts a 404 from Vapi as notFound (likely sim_* leak) and leaves the row alone', async () => {
    getVapiCallSpy.mockResolvedValue({ ok: false, reason: 'notFound' });
    const { admin } = makeAdmin({ candidates: [row()] });

    const result = await reconcileStuckCalls(admin);

    expect(result.notFound).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(result.failed).toBe(0);
    expect(applyEndOfCallSpy).not.toHaveBeenCalled();
  });

  it('stops the batch early on Vapi 429 and reports rateLimited=true', async () => {
    // Three candidates: first returns success, second triggers 429,
    // third should NEVER be touched.
    getVapiCallSpy
      .mockResolvedValueOnce({
        ok: true,
        record: { status: 'ended', endedReason: 'customer-ended-call' },
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'rateLimited',
        retryAfterSec: 45,
      })
      .mockResolvedValueOnce({
        ok: true,
        record: { status: 'ended' },
      });
    applyEndOfCallSpy.mockResolvedValue({
      applied: true,
      status: 'completed',
      quoteInserted: false,
    });

    const { admin } = makeAdmin({
      candidates: [
        row({ id: 'a', vapi_call_id: 'va' }),
        row({ id: 'b', vapi_call_id: 'vb' }),
        row({ id: 'c', vapi_call_id: 'vc' }),
      ],
    });

    const result = await reconcileStuckCalls(admin);

    expect(result.rateLimited).toBe(true);
    expect(result.reconciled).toBe(1); // only the first
    expect(getVapiCallSpy).toHaveBeenCalledTimes(2); // never called for 'c'
    expect(applyEndOfCallSpy).toHaveBeenCalledTimes(1);
    expect(result.notes.some((n) => /retry-after 45s/.test(n))).toBe(true);
  });

  it('counts httpError and transport failures as failed without aborting the batch', async () => {
    getVapiCallSpy
      .mockResolvedValueOnce({
        ok: false,
        reason: 'httpError',
        status: 500,
        body: 'oh no',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'transport',
        message: 'ECONNRESET',
      })
      .mockResolvedValueOnce({
        ok: true,
        record: { status: 'ended', endedReason: 'customer-ended-call' },
      });
    applyEndOfCallSpy.mockResolvedValue({
      applied: true,
      status: 'completed',
      quoteInserted: false,
    });

    const { admin } = makeAdmin({
      candidates: [
        row({ id: 'a', vapi_call_id: 'va' }),
        row({ id: 'b', vapi_call_id: 'vb' }),
        row({ id: 'c', vapi_call_id: 'vc' }),
      ],
    });

    const result = await reconcileStuckCalls(admin);

    expect(result.failed).toBe(2);
    expect(result.reconciled).toBe(1);
    expect(result.rateLimited).toBe(false);
  });

  it('counts noApiKey as failed (cannot reconcile without a way to call Vapi) and skips the row', async () => {
    getVapiCallSpy.mockResolvedValue({ ok: false, reason: 'noApiKey' });
    const { admin } = makeAdmin({ candidates: [row()] });

    const result = await reconcileStuckCalls(admin);

    expect(result.failed).toBe(1);
    expect(applyEndOfCallSpy).not.toHaveBeenCalled();
  });

  it('captures applyEndOfCall throws to Sentry and continues with the batch', async () => {
    getVapiCallSpy.mockResolvedValue({
      ok: true,
      record: { status: 'ended', endedReason: 'customer-ended-call' },
    });
    applyEndOfCallSpy
      .mockRejectedValueOnce(new Error('apply_call_end RPC failed'))
      .mockResolvedValueOnce({
        applied: true,
        status: 'completed',
        quoteInserted: false,
      });

    const { admin } = makeAdmin({
      candidates: [
        row({ id: 'a', vapi_call_id: 'va' }),
        row({ id: 'b', vapi_call_id: 'vb' }),
      ],
    });

    const result = await reconcileStuckCalls(admin);

    expect(result.failed).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionSpy.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(err.message).toBe('apply_call_end RPC failed');
    expect(ctx.tags).toMatchObject({
      lib: 'cron-reconcile-calls',
      reason: 'applyEndOfCallFailed',
      callId: 'a',
    });
  });
});
