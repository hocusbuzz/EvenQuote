// Tests for applyEndOfCall — the end-of-call finalizer used by BOTH
// the Vapi webhook and the dev backfill endpoint. This is the most
// critical path in the whole call pipeline: wrong behavior here either
// drops a real paid call or double-charges the counter. Two separate
// production surfaces depend on this being idempotent + PII-safe.
//
// We inject a chainable Supabase stub — no network. Extraction is
// mocked at the module level so each test can dictate ok/not-ok.
//
// Patterns worth calling out:
//   • The calls lookup uses a nested select (quote_requests → service_categories).
//     The stub returns shapes matching supabase-js's actual output so
//     flattenJoinedCategory works.
//   • The quotes insert error path has a UNIQUE(call_id) idempotency
//     swallow for code 23505 — tested separately from generic DB errors.
//   • recompute_business_success_rate is best-effort; failure must NOT
//     bubble and must NOT flip `applied` back to false.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const extractSpy = vi.fn();
vi.mock('@/lib/calls/extract-quote', () => ({
  extractQuoteFromCall: (...args: unknown[]) => extractSpy(...args),
}));

// Lib-boundary captureException audit: mirror the engine.test.ts
// pattern. Mock the sentry module so we can assert the canonical
// `{ lib: 'apply-end-of-call', reason, callId, ... }` tag shape at
// both capture sites — `quotesInsertFailed` (non-23505 insert errs)
// and `recomputeFailed` (best-effort success-rate refresh failure).
// Mocked at module level to avoid the real stub emitting log noise
// during the happy-path test runs that assert NO capture.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
}));

// Import after mocks are registered.
import { applyEndOfCall, classifyOutcome, type VapiEndOfCallReport } from './apply-end-of-call';

// ─── Shared stub factory ──────────────────────────────────────────────

type CallRow = {
  id: string;
  quote_request_id: string;
  business_id: string;
  status: string;
  /**
   * Sentinel for "counters have been applied". Gate for the short-
   * circuit. NULL means counters haven't been bumped yet — caller will
   * proceed with the status/extraction/RPC path even if status is
   * already terminal (retry-repair of a crashed prior apply).
   */
  counters_applied_at?: string | null;
  quote_requests?: unknown;
};

type StubState = {
  callRow: CallRow | null;
  callLookupError: { message: string } | null;
  callsUpdateError: { message: string } | null;
  quotesInsertError: { code?: string; message: string } | null;
  applyCallEndError: { message: string } | null;
  recomputeError: { message: string } | null;
  // Captured side effects:
  callsUpdatePayload?: Record<string, unknown>;
  quotesInsertPayload?: Record<string, unknown>;
  rpcCalls: { fn: string; args: unknown }[];
};

function makeAdmin(initial: Partial<StubState> = {}): {
  admin: SupabaseClient;
  state: StubState;
} {
  const state: StubState = {
    callRow: null,
    callLookupError: null,
    callsUpdateError: null,
    quotesInsertError: null,
    applyCallEndError: null,
    recomputeError: null,
    rpcCalls: [],
    ...initial,
  };

  const admin = {
    from: (table: string) => {
      if (table === 'calls') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.callRow,
                  error: state.callLookupError,
                }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            state.callsUpdatePayload = row;
            return {
              eq: () =>
                Promise.resolve({
                  data: null,
                  error: state.callsUpdateError,
                }),
            };
          },
        };
      }
      if (table === 'quotes') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.quotesInsertPayload = row;
            return Promise.resolve({
              data: null,
              error: state.quotesInsertError,
            });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      if (fn === 'apply_call_end') {
        return Promise.resolve({
          data: null,
          error: state.applyCallEndError,
        });
      }
      if (fn === 'recompute_business_success_rate') {
        return Promise.resolve({
          data: null,
          error: state.recomputeError,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;

  return { admin, state };
}

const VAPI_CALL_ID = 'vapi_call_abc';

function baseCallRow(overrides: Partial<CallRow> = {}): CallRow {
  return {
    id: 'call_internal_1',
    quote_request_id: 'qr_1',
    business_id: 'biz_1',
    status: 'in_progress',
    counters_applied_at: null,
    quote_requests: {
      category_id: 'cat_1',
      service_categories: {
        name: 'Moving',
        slug: 'moving',
        extraction_schema: null,
      },
    },
    ...overrides,
  };
}

function baseReport(overrides: Partial<VapiEndOfCallReport> = {}): VapiEndOfCallReport {
  return {
    type: 'end-of-call-report',
    call: { id: VAPI_CALL_ID },
    transcript: 'Hello, yes we can do that move for $800.',
    summary: 'Customer quoted $800 flat.',
    recordingUrl: 'https://storage.vapi.ai/recordings/abc',
    cost: 0.42,
    durationSeconds: 180,
    endedReason: 'customer-hang-up',
    analysis: { structuredData: null, successEvaluation: 'yes' },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('applyEndOfCall', () => {
  beforeEach(() => {
    extractSpy.mockReset();
    captureExceptionMock.mockReset();
    // Default: extraction returns a valid quote.
    extractSpy.mockResolvedValue({
      ok: true,
      quote: {
        priceMin: 800,
        priceMax: 800,
        priceDescription: '$800 flat',
        availability: 'next week',
        includes: ['2 movers', '1 truck'],
        excludes: ['packing supplies'],
        notes: null,
        contactName: 'Alex',
        contactPhone: null,
        contactEmail: null,
        requiresOnsiteEstimate: false,
        confidenceScore: 0.9,
      },
    });
  });

  it('returns applied=false with note when the calls row does not exist', async () => {
    const { admin, state } = makeAdmin({ callRow: null });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(false);
    expect(result.quoteInserted).toBe(false);
    expect(result.note).toContain('no calls row');
    // Nothing else should have fired.
    expect(state.callsUpdatePayload).toBeUndefined();
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('short-circuits when counters_applied_at is stamped (fully-applied replay)', async () => {
    // Classic replay: an earlier successful run stamped counters_applied_at.
    // No matter what the status says, we skip — counters were already bumped.
    const { admin, state } = makeAdmin({
      callRow: baseCallRow({
        status: 'completed',
        counters_applied_at: '2026-04-22T12:00:00Z',
      }),
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.note).toContain('counters already applied');
    // No update, no extraction, no rpc.
    expect(state.callsUpdatePayload).toBeUndefined();
    expect(extractSpy).not.toHaveBeenCalled();
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('short-circuits regardless of status when counters_applied_at is set', async () => {
    // The short-circuit gate is the sentinel, not the status. Any
    // status paired with a stamped sentinel is a no-op.
    for (const term of ['completed', 'failed', 'no_answer', 'refused', 'in_progress']) {
      const { admin } = makeAdmin({
        callRow: baseCallRow({
          status: term,
          counters_applied_at: '2026-04-22T12:00:00Z',
        }),
      });
      const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
      expect(result.applied).toBe(false);
      expect(result.status).toBe(term);
    }
  });

  it('retry-repair: terminal status + counters_applied_at=null RE-RUNS end-of-call', async () => {
    // This is the regression test for the webhook-retry bug (GPT Codex
    // P1-1). Prior behavior short-circuited on terminal status alone,
    // so if an earlier run wrote status='completed' and then the RPC
    // threw (deadlock, connection reset), counters were never bumped
    // and the next Vapi retry silently dropped the work.
    //
    // Correct behavior: see counters_applied_at=null → re-run the full
    // sequence. Status UPDATE is idempotent, quotes insert is idempotent
    // (UNIQUE(call_id) swallowed on 23505), the RPC's internal claim
    // guarantees counters bump at most once server-side.
    const { admin, state } = makeAdmin({
      callRow: baseCallRow({
        status: 'completed',
        counters_applied_at: null,
      }),
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());

    expect(result.applied).toBe(true);
    // Status UPDATE fired (idempotent re-write of terminal status).
    expect(state.callsUpdatePayload).toBeDefined();
    // Extraction ran (idempotent — quotes UNIQUE(call_id) catches dupes).
    expect(extractSpy).toHaveBeenCalledTimes(1);
    // Counter RPC fired with p_call_id so the server-side claim can
    // atomically no-op if it was somehow already applied.
    expect(state.rpcCalls[0].fn).toBe('apply_call_end');
    expect(state.rpcCalls[0].args).toMatchObject({
      p_request_id: 'qr_1',
      p_call_id: 'call_internal_1',
    });
  });

  it('on success: updates calls row, inserts quote, fires both RPCs', async () => {
    const { admin, state } = makeAdmin({
      callRow: baseCallRow(),
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.quoteInserted).toBe(true);

    // calls row updated with transcript/cost/etc.
    expect(state.callsUpdatePayload).toBeDefined();
    expect(state.callsUpdatePayload?.status).toBe('completed');
    expect(state.callsUpdatePayload?.transcript).toBe(baseReport().transcript);
    expect(state.callsUpdatePayload?.cost).toBe(0.42);
    expect(state.callsUpdatePayload?.duration_seconds).toBe(180);

    // quotes row inserted.
    expect(state.quotesInsertPayload).toBeDefined();
    expect(state.quotesInsertPayload?.call_id).toBe('call_internal_1');
    expect(state.quotesInsertPayload?.price_min).toBe(800);

    // Both RPCs fired, in the right order.
    expect(state.rpcCalls.map((c) => c.fn)).toEqual([
      'apply_call_end',
      'recompute_business_success_rate',
    ]);
    expect(state.rpcCalls[0].args).toMatchObject({
      p_request_id: 'qr_1',
      p_call_id: 'call_internal_1',
      p_quote_inserted: true,
    });
  });

  it('passes category context to the extractor when present', async () => {
    const { admin } = makeAdmin({ callRow: baseCallRow() });
    await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(extractSpy).toHaveBeenCalledTimes(1);
    const callArg = extractSpy.mock.calls[0][0] as {
      categoryContext?: { displayName?: string };
    };
    expect(callArg.categoryContext?.displayName).toBe('Moving');
  });

  it('quote insert unique-violation is swallowed silently and still fires RPC', async () => {
    const { admin, state } = makeAdmin({
      callRow: baseCallRow(),
      quotesInsertError: { code: '23505', message: 'duplicate key' },
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    // Duplicate = already-processed; applied still true, but quoteInserted false.
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(false);
    expect(state.rpcCalls[0].args).toMatchObject({ p_quote_inserted: false });
  });

  it('quote insert generic error does NOT throw; call still applied', async () => {
    const { admin, state } = makeAdmin({
      callRow: baseCallRow(),
      quotesInsertError: { code: '42703', message: 'some other DB error' },
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    // applied is still true — we persisted the calls row and advanced counters.
    // quoteInserted is false — no quote row was written.
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(false);
    expect(state.rpcCalls[0].args).toMatchObject({ p_quote_inserted: false });
  });

  it('extraction ok:false: applied=true, no quote insert, no quote rpc flag', async () => {
    extractSpy.mockResolvedValueOnce({ ok: false, reason: 'no usable transcript' });
    const { admin, state } = makeAdmin({ callRow: baseCallRow() });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(false);
    expect(state.quotesInsertPayload).toBeUndefined();
    expect(state.rpcCalls[0].args).toMatchObject({ p_quote_inserted: false });
  });

  it('non-completed outcome (refused) skips extraction entirely', async () => {
    // endedReason blank + short duration + no transcript → refused.
    const { admin, state } = makeAdmin({ callRow: baseCallRow() });
    const result = await applyEndOfCall(
      admin,
      VAPI_CALL_ID,
      baseReport({ transcript: undefined, durationSeconds: 3, endedReason: '' })
    );
    expect(result.applied).toBe(true);
    expect(result.status).toBe('refused');
    expect(result.quoteInserted).toBe(false);
    expect(extractSpy).not.toHaveBeenCalled();
    expect(state.quotesInsertPayload).toBeUndefined();
  });

  it('recompute_business_success_rate failure does NOT bubble', async () => {
    const { admin, state } = makeAdmin({
      callRow: baseCallRow(),
      recomputeError: { message: 'connection reset' },
    });
    // Must not throw.
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(true);
    // Counter RPC still fired.
    expect(state.rpcCalls.map((c) => c.fn)).toContain('apply_call_end');
  });

  it('apply_call_end RPC failure DOES bubble (counters matter)', async () => {
    const { admin } = makeAdmin({
      callRow: baseCallRow(),
      applyCallEndError: { message: 'deadlock' },
    });
    await expect(applyEndOfCall(admin, VAPI_CALL_ID, baseReport())).rejects.toThrow(
      /apply_call_end/
    );
  });

  it('calls lookup error bubbles as a thrown Error', async () => {
    const { admin } = makeAdmin({
      callLookupError: { message: 'permission denied' },
    });
    await expect(applyEndOfCall(admin, VAPI_CALL_ID, baseReport())).rejects.toThrow(
      /calls lookup/
    );
  });

  it('calls update error bubbles as a thrown Error', async () => {
    const { admin } = makeAdmin({
      callRow: baseCallRow(),
      callsUpdateError: { message: 'bad column' },
    });
    await expect(applyEndOfCall(admin, VAPI_CALL_ID, baseReport())).rejects.toThrow(
      /calls update/
    );
  });

  it('accepts report with callId (instead of call.id)', async () => {
    // Some Vapi configurations put the id on the envelope top-level.
    const { admin } = makeAdmin({ callRow: baseCallRow() });
    const report = baseReport({ call: undefined, callId: VAPI_CALL_ID });
    // The handler ultimately relies on the vapiCallId argument passed in,
    // so this also confirms that looking up via that arg works end-to-end.
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, report);
    expect(result.applied).toBe(true);
  });

  // ── lib-boundary captureException tests ──────────────────────────
  // Two capture sites in applyEndOfCall:
  //   1. non-23505 quotes insert failure  (lib, reason: 'quotesInsertFailed')
  //   2. recompute_business_success_rate failure (lib, reason: 'recomputeFailed')
  // Both must carry canonical tag shapes and NO PII. We also assert
  // that expected non-failure paths (UNIQUE-violation swallow, happy
  // path) do NOT fire a capture — dashboards would drown in noise
  // otherwise, since unique-violation is the default Vapi-retry state.

  it('captures quotesInsertFailed with canonical tags on non-23505 insert error', async () => {
    const { admin } = makeAdmin({
      callRow: baseCallRow(),
      quotesInsertError: { code: '42703', message: 'column "foo" does not exist' },
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    // Same behavior as before — applied still flips true; generic insert
    // errors don't bubble. But we now emit a capture event.
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(false);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/column "foo" does not exist/);
    expect(ctx).toEqual({
      tags: {
        lib: 'apply-end-of-call',
        reason: 'quotesInsertFailed',
        callId: 'call_internal_1',
        quoteRequestId: 'qr_1',
      },
    });
    // Strict key-set — new keys require updating dashboards / alerts.
    const tagKeys = Object.keys(
      (ctx as { tags: Record<string, string> }).tags
    );
    expect(tagKeys.sort()).toEqual(
      ['callId', 'lib', 'quoteRequestId', 'reason'].sort()
    );
    // PII negative-assertion. contactName/contactPhone/contactEmail
    // must NEVER show up in tag values.
    const tagValues = Object.values(
      (ctx as { tags: Record<string, string> }).tags
    );
    for (const v of tagValues) {
      expect(v).not.toMatch(/@/); // email guard
      expect(v).not.toMatch(/\+?\d{10,}/); // phone guard
    }
  });

  it('does NOT capture on 23505 UNIQUE-violation (expected retry path)', async () => {
    // This is the common case — Vapi redelivers an end-of-call report
    // and the calls.counters_applied_at sentinel hasn't been stamped
    // yet. We re-attempt the quote insert and the UNIQUE constraint
    // rejects the dupe. Capturing here would flood Sentry with noise on
    // every retry storm — make sure we explicitly skip.
    const { admin } = makeAdmin({
      callRow: baseCallRow(),
      quotesInsertError: { code: '23505', message: 'duplicate key value' },
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures recomputeFailed with canonical tags and still returns applied=true', async () => {
    // recompute is best-effort — it must NOT bubble an error, but it
    // MUST emit a capture so ops can see a degrading success-rate
    // pipeline. Regression test: if someone removes the capture because
    // "it's best-effort anyway", we want this to fail loudly.
    const { admin } = makeAdmin({
      callRow: baseCallRow(),
      recomputeError: { message: 'connection reset by peer' },
    });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(true);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/connection reset by peer/);
    expect(ctx).toEqual({
      tags: {
        lib: 'apply-end-of-call',
        reason: 'recomputeFailed',
        callId: 'call_internal_1',
        businessId: 'biz_1',
      },
    });
    // Strict key-set.
    const tagKeys = Object.keys(
      (ctx as { tags: Record<string, string> }).tags
    );
    expect(tagKeys.sort()).toEqual(
      ['businessId', 'callId', 'lib', 'reason'].sort()
    );
  });

  it('captures BOTH sites when quotes insert AND recompute both fail', async () => {
    // Belt-and-braces: if we somehow regress to a state where both
    // downstream steps fail, each site should emit its own tagged
    // capture — Sentry dedupes on fingerprint but the tag facets are
    // what make dashboards useful.
    const { admin } = makeAdmin({
      callRow: baseCallRow(),
      quotesInsertError: { code: '42501', message: 'permission denied for table quotes' },
      recomputeError: { message: 'deadlock detected' },
    });
    await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    const reasons = captureExceptionMock.mock.calls.map(
      (c) => (c[1] as { tags: { reason: string } }).tags.reason
    );
    expect(reasons.sort()).toEqual(['quotesInsertFailed', 'recomputeFailed'].sort());
  });

  it('does NOT capture on the happy path', async () => {
    // Sanity: a clean end-of-call with no errors should never emit
    // captureException. A regression here (capturing on success) would
    // wash out the entire dashboard with noise.
    const { admin } = makeAdmin({ callRow: baseCallRow() });
    const result = await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(result.applied).toBe(true);
    expect(result.quoteInserted).toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT capture on short-circuit (counters_applied_at stamped)', async () => {
    // Replay-style short-circuit must be completely silent — this is
    // the default Vapi retry path and fires constantly in production.
    const { admin } = makeAdmin({
      callRow: baseCallRow({
        status: 'completed',
        counters_applied_at: '2026-04-22T12:00:00Z',
      }),
    });
    await applyEndOfCall(admin, VAPI_CALL_ID, baseReport());
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe('classifyOutcome', () => {
  it('maps no-answer/voicemail/busy to no_answer', () => {
    expect(classifyOutcome({ type: 'end-of-call-report', endedReason: 'no-answer' }).status).toBe(
      'no_answer'
    );
    expect(
      classifyOutcome({ type: 'end-of-call-report', endedReason: 'voicemail-detected' }).status
    ).toBe('no_answer');
    expect(classifyOutcome({ type: 'end-of-call-report', endedReason: 'busy' }).status).toBe(
      'no_answer'
    );
  });

  it('maps failed/error/twilio to failed', () => {
    expect(classifyOutcome({ type: 'end-of-call-report', endedReason: 'failed' }).status).toBe(
      'failed'
    );
    expect(
      classifyOutcome({ type: 'end-of-call-report', endedReason: 'twilio-error' }).status
    ).toBe('failed');
  });

  it('maps short call with no transcript to refused', () => {
    expect(
      classifyOutcome({
        type: 'end-of-call-report',
        durationSeconds: 3,
        endedReason: 'customer-did-not-give-microphone-permission',
      }).status
    ).toBe('refused');
  });

  it('defaults to completed for everything else', () => {
    expect(
      classifyOutcome({
        type: 'end-of-call-report',
        durationSeconds: 45,
        transcript: 'full conversation here',
        endedReason: 'customer-hang-up',
      }).status
    ).toBe('completed');
  });
});
