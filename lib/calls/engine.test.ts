// Tests for runCallBatch — the engine that turns a paid quote_request
// into a batch of queued calls.
//
// We inject an admin client stub into runCallBatchWith (no top-level
// module mocking needed). vapi is the one dependency we mock at the
// module level so startOutboundCall doesn't try to reach the network.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Vapi mock (module-level) ─────────────────────────────────────────

const startSpy = vi.fn();
vi.mock('@/lib/calls/vapi', () => ({
  startOutboundCall: (...args: unknown[]) => startSpy(...args),
}));

// ─── select-businesses mock ──────────────────────────────────────────
// We're not testing the selector here — that has its own suite. We want
// deterministic business lists per test.
const selectSpy = vi.fn();
vi.mock('@/lib/calls/select-businesses', () => ({
  selectBusinessesForRequest: (...args: unknown[]) => selectSpy(...args),
}));

// ─── env helper mock ──────────────────────────────────────────────────
vi.mock('@/lib/env', () => ({
  getCallBatchSize: () => 5,
}));

// ─── observability mock ──────────────────────────────────────────────
// Engine calls captureException at its lib boundary for claimFailed
// and insertFailed. We mock the module so tests can assert the
// canonical `{ lib: 'enqueue', reason }` tag shape without the real
// stub emitting `log.error` noise.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
}));

// ─── Chainable admin-client stub ─────────────────────────────────────
// Builds whatever chain the caller needs. Each table operation resolves
// to a configurable result via the `table` handlers.

type TableHandlers = {
  updateResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  // Tracks the most recent .update() payload for assertions
  updates: { table: string; row: Record<string, unknown> }[];
  inserts: { table: string; rows: unknown[] }[];
};

function makeAdmin(
  quoteRequestRow: Record<string, unknown> | null,
  handlers: Partial<TableHandlers> = {}
): { client: SupabaseClient; state: TableHandlers } {
  const state: TableHandlers = {
    updates: [],
    inserts: [],
    ...handlers,
  };

  const client = {
    from: (table: string) => {
      if (table === 'quote_requests') {
        return {
          // update chain: update().eq().eq().is().select().maybeSingle()
          update: (row: Record<string, unknown>) => {
            state.updates.push({ table, row });
            const chain: Record<string, unknown> = {
              eq: () => chain,
              is: () => chain,
              select: () => chain,
              maybeSingle: () =>
                Promise.resolve({ data: quoteRequestRow, error: null }),
              // the final "counter update" skips select/maybeSingle —
              // it terminates at .eq()
              then: undefined,
            };
            return chain;
          },
        };
      }
      if (table === 'calls') {
        return {
          insert: (rows: unknown[]) => {
            state.inserts.push({ table, rows });
            if (state.insertResult) {
              return {
                select: () => Promise.resolve(state.insertResult),
              };
            }
            const inserted = (rows as Array<{ business_id: string }>).map(
              (r, i) => ({ id: `call-${i}`, business_id: r.business_id })
            );
            return {
              select: () => Promise.resolve({ data: inserted, error: null }),
            };
          },
          update: (row: Record<string, unknown>) => {
            state.updates.push({ table: 'calls', row });
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      if (table === 'businesses') {
        return {
          update: (row: Record<string, unknown>) => {
            state.updates.push({ table: 'businesses', row });
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, state };
}

const BASE_QR = {
  id: 'qr-1',
  category_id: 'cat-moving',
  city: 'Denver',
  state: 'CO',
  zip_code: '80202',
  intake_data: { home_size: '2 bedroom', contact_phone: '555-555-0100', contact_email: 'x@y.com' },
  vapi_batch_started_at: '2026-04-22T00:00:00Z',
};

describe('runCallBatchWith', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureExceptionMock.mockReset();
  });

  it('returns the no-op note when the claim update matches zero rows', async () => {
    const { client } = makeAdmin(null);
    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, { quoteRequestId: 'qr-missing' });
    expect(result.ok).toBe(true);
    expect(result.selected).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(result.notes[0]).toMatch(/not in status=paid/);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('rolls back to status=failed when no businesses match', async () => {
    selectSpy.mockResolvedValueOnce([]);
    const { client, state } = makeAdmin(BASE_QR);
    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, { quoteRequestId: 'qr-1' });
    expect(result.ok).toBe(false);
    expect(result.selected).toBe(0);
    expect(result.notes[0]).toMatch(/no businesses matched/);
    // The "failed" rollback update is the second quote_requests.update call
    const qrUpdates = state.updates.filter((u) => u.table === 'quote_requests');
    expect(qrUpdates.at(-1)?.row.status).toBe('failed');
  });

  it('dispatches calls and advances counters on the happy path', async () => {
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A Movers', phone: '+14155550100' },
      { id: 'biz-2', name: 'B Movers', phone: '+14155550101' },
    ]);
    startSpy
      .mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-1', simulated: false })
      .mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-2', simulated: false });
    const { client, state } = makeAdmin(BASE_QR);
    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, { quoteRequestId: 'qr-1' });
    expect(result.ok).toBe(true);
    expect(result.selected).toBe(2);
    expect(result.dispatched).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.simulated).toBe(false);

    // One insert on calls
    expect(state.inserts.find((i) => i.table === 'calls')?.rows).toHaveLength(2);
    // vapi_call_id persisted via calls.update
    const callUpdates = state.updates.filter((u) => u.table === 'calls');
    const vapiIds = callUpdates.map((u) => u.row.vapi_call_id).filter(Boolean);
    expect(vapiIds).toContain('vc-1');
    expect(vapiIds).toContain('vc-2');
    // Final counter update sets total_calls_made=2
    const qrFinal = state.updates.filter((u) => u.table === 'quote_requests').at(-1);
    expect(qrFinal?.row.total_businesses_to_call).toBe(2);
    expect(qrFinal?.row.total_calls_made).toBe(2);
  });

  it('marks failed calls in state.updates and includes them in counts', async () => {
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A Movers', phone: '+14155550100' },
      { id: 'biz-2', name: 'B Movers', phone: '+14155550101' },
    ]);
    startSpy
      .mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-1', simulated: false })
      .mockResolvedValueOnce({ ok: false, simulated: false, error: 'vapi timeout' });
    const { client, state } = makeAdmin(BASE_QR);
    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, { quoteRequestId: 'qr-1' });
    expect(result.ok).toBe(true);
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(1);
    // The failed call should have been marked status=failed
    const callUpdates = state.updates.filter((u) => u.table === 'calls');
    expect(callUpdates.some((u) => u.row.status === 'failed')).toBe(true);
    // Error note surfaces
    expect(result.notes.join('\n')).toMatch(/vapi timeout/);
  });

  it('flags simulated=true when all dispatches were simulated', async () => {
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    startSpy.mockResolvedValueOnce({
      ok: true,
      vapiCallId: 'sim_abc',
      simulated: true,
      reason: 'no VAPI_* env',
    });
    const { client } = makeAdmin(BASE_QR);
    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, { quoteRequestId: 'qr-1' });
    expect(result.simulated).toBe(true);
    expect(result.dispatched).toBe(1);
  });

  it('strips PII and full addresses from variableValues', async () => {
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    startSpy.mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-1', simulated: false });
    const { client } = makeAdmin({
      ...BASE_QR,
      intake_data: {
        contact_phone: '555-555-0100',   // must be stripped
        contact_email: 'x@y.com',        // must be stripped
        origin_address: '123 Main St',   // must be stripped
        destination_address: '456 Oak',  // must be stripped
        address: '789 Pine',             // must be stripped (cleaning)
        home_size: '2 bedroom',          // OK
        special_items: ['Piano', 'Safe'], // array → joined
      },
    });
    const { runCallBatchWith } = await import('./engine');
    await runCallBatchWith(client, { quoteRequestId: 'qr-1' });
    expect(startSpy).toHaveBeenCalledOnce();
    const vv = startSpy.mock.calls[0][0].variableValues as Record<string, unknown>;
    expect(vv.contact_phone).toBeUndefined();
    expect(vv.contact_email).toBeUndefined();
    expect(vv.origin_address).toBeUndefined();
    expect(vv.destination_address).toBeUndefined();
    expect(vv.address).toBeUndefined();
    // allowed values passed through, array joined
    expect(vv.home_size).toBe('2 bedroom');
    expect(vv.special_items).toBe('Piano, Safe');
  });

  // ── lib-boundary captureException tests ──────────────────────────
  // runCallBatch is invoked from the stripe webhook today, which has
  // its own route-level captureException. But library-boundary capture
  // means future callers (admin retry, support reprocess) inherit
  // observability without wrapping each call site. Sentry dedupes on
  // stack-trace fingerprint so the webhook + lib tags coexist without
  // double-counting — these tests lock the tag shape so dashboards
  // don't drift if engine.ts is refactored.

  it('captures claimFailed with canonical tags and no PII', async () => {
    // Custom client that returns an error from the claim update.
    const client = {
      from: (table: string) => {
        if (table === 'quote_requests') {
          return {
            update: () => {
              const chain: Record<string, unknown> = {
                eq: () => chain,
                is: () => chain,
                select: () => chain,
                maybeSingle: () =>
                  Promise.resolve({
                    data: null,
                    error: { message: 'db connection reset' },
                  }),
              };
              return chain;
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const { runCallBatchWith } = await import('./engine');
    await expect(
      runCallBatchWith(client, { quoteRequestId: 'qr-claim-fail' })
    ).rejects.toThrow(/runCallBatch claim/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/db connection reset/);
    expect(ctx).toEqual({
      tags: {
        lib: 'enqueue',
        reason: 'claimFailed',
        quoteRequestId: 'qr-claim-fail',
      },
    });
    // Negative-assertion: no field should leak user-identifying data
    // (email, phone, name) into Sentry tags. The capture context must
    // stay strictly opaque-UUID + lib-identifier.
    const tagValues = Object.values(
      (ctx as { tags: Record<string, string> }).tags
    );
    for (const v of tagValues) {
      expect(v).not.toMatch(/@/); // email guard
      expect(v).not.toMatch(/\+?\d{10,}/); // phone guard
    }
  });

  it('captures insertFailed with canonical tags when calls insert errors', async () => {
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    const { client } = makeAdmin(BASE_QR, {
      insertResult: {
        data: null,
        error: { message: 'calls_quote_request_id_fk violation' },
      },
    });
    const { runCallBatchWith } = await import('./engine');
    await expect(
      runCallBatchWith(client, { quoteRequestId: 'qr-insert-fail' })
    ).rejects.toThrow(/runCallBatch insert calls/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/calls_quote_request_id_fk/);
    expect(ctx).toEqual({
      tags: {
        lib: 'enqueue',
        reason: 'insertFailed',
        quoteRequestId: 'qr-insert-fail',
      },
    });
  });

  it('does NOT capture on the happy path', async () => {
    // Sanity: happy-path dispatches should never emit a capture event.
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    startSpy.mockResolvedValueOnce({
      ok: true,
      vapiCallId: 'vc-1',
      simulated: false,
    });
    const { client } = makeAdmin(BASE_QR);
    const { runCallBatchWith } = await import('./engine');
    await runCallBatchWith(client, { quoteRequestId: 'qr-happy' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures plannedCountUpdateFailed when the denominator update errors', async () => {
    // Silent-strand scenario: claim + insert succeed, planned-count
    // update fails. Without capture, the request stays in 'calling'
    // forever — apply-end-of-call reads NULL for
    // total_businesses_to_call and the status flip short-circuits.
    // Lock the tag shape so Sentry alerts can fire on this invariant.
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    startSpy.mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-1', simulated: false });

    // Custom client: first quote_requests.update() is the claim and
    // must succeed (returns quoteRequestRow via .maybeSingle()). The
    // second quote_requests.update() is the planned-count update and
    // terminates on .eq() — return an error there.
    let qrUpdateCount = 0;
    const client = {
      from: (table: string) => {
        if (table === 'quote_requests') {
          return {
            update: () => {
              qrUpdateCount += 1;
              if (qrUpdateCount === 1) {
                // Claim chain — resolves with BASE_QR
                const chain: Record<string, unknown> = {
                  eq: () => chain,
                  is: () => chain,
                  select: () => chain,
                  maybeSingle: () =>
                    Promise.resolve({ data: BASE_QR, error: null }),
                };
                return chain;
              }
              // Planned-count update — resolves on .eq() with an error
              return {
                eq: () =>
                  Promise.resolve({
                    error: { message: 'conn reset' },
                  }),
              };
            },
          };
        }
        if (table === 'calls') {
          return {
            insert: () => ({
              select: () =>
                Promise.resolve({
                  data: [{ id: 'call-0', business_id: 'biz-1' }],
                  error: null,
                }),
            }),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        if (table === 'businesses') {
          return {
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, {
      quoteRequestId: 'qr-planned-fail',
    });
    // The batch still completes — we don't abort on this failure.
    expect(result.ok).toBe(true);
    expect(result.dispatched).toBe(1);

    // Exactly one capture, with the canonical tag shape.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/planned-count update/);
    expect(ctx).toEqual({
      tags: {
        lib: 'enqueue',
        reason: 'plannedCountUpdateFailed',
        quoteRequestId: 'qr-planned-fail',
      },
    });
    // PII guard — nothing user-identifying in the tags.
    const tagValues = Object.values(
      (ctx as { tags: Record<string, string> }).tags
    );
    for (const v of tagValues) {
      expect(v).not.toMatch(/@/);
      expect(v).not.toMatch(/\+?\d{10,}/);
    }
  });

  it('captures callIdPersistFailed when vapi_call_id write fails', async () => {
    // Skip-business observability lock: Vapi accepted the call
    // (dispatch.ok=true) but writing the vapi_call_id back to the
    // calls row failed. The contractor may pick up; the end-of-call
    // callback won't be able to match the row. Worst silent failure
    // in the outbound path. Canonical tags carry callId + businessId
    // because we KNOW them here (unlike earlier-stage failures).
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    startSpy.mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-1', simulated: false });

    // Custom client: all quote_requests updates + calls.insert +
    // businesses.update succeed; only calls.update returns an error.
    const client = {
      from: (table: string) => {
        if (table === 'quote_requests') {
          return {
            update: () => {
              const chain: Record<string, unknown> = {
                eq: () => chain,
                is: () => chain,
                select: () => chain,
                maybeSingle: () =>
                  Promise.resolve({ data: BASE_QR, error: null }),
              };
              return chain;
            },
          };
        }
        if (table === 'calls') {
          return {
            insert: () => ({
              select: () =>
                Promise.resolve({
                  data: [{ id: 'call-0', business_id: 'biz-1' }],
                  error: null,
                }),
            }),
            // This is the vapi_call_id persist — fail it.
            update: () => ({
              eq: () =>
                Promise.resolve({ error: { message: 'calls_pkey violation' } }),
            }),
          };
        }
        if (table === 'businesses') {
          return {
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, {
      quoteRequestId: 'qr-persist-fail',
    });
    expect(result.ok).toBe(true);
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.notes.join('\n')).toMatch(/failed to persist vapi_call_id/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/call-id persist/);
    expect(ctx).toEqual({
      tags: {
        lib: 'enqueue',
        reason: 'callIdPersistFailed',
        quoteRequestId: 'qr-persist-fail',
        callId: 'call-0',
        businessId: 'biz-1',
      },
    });
    // PII guard — quoteRequestId, callId, businessId are opaque UUIDs
    // in prod; tags must never contain caller phone or business name.
    const tagValues = Object.values(
      (ctx as { tags: Record<string, string> }).tags
    );
    for (const v of tagValues) {
      expect(v).not.toMatch(/@/);
      expect(v).not.toMatch(/\+?\d{10,}/);
    }
  });

  // ── R28 observability contract ──
  //
  // Silent-strand path added in Round 28: when `selectBusinessesForRequest`
  // returns an empty list AND our fallback `update({status:'failed'})`
  // fails, the quote_request is stranded in 'calling' with zero calls:
  //   • retry-failed-calls cron looks for `calls.status='failed'` — zero.
  //   • send-reports only triggers on `status='processing'` — never fires.
  //   • Customer paid and nothing ever happens.
  // Low probability (double DB failure: claim OK, fallback fail), high
  // blast radius. Capture mandatory so ops catches the silent strand.

  it('captures noBusinessesFallbackFailed when the fallback update errors', async () => {
    selectSpy.mockResolvedValueOnce([]);

    // Custom client: first quote_requests.update is the claim (chain-
    // resolves with BASE_QR), the second is the fallback 'failed'
    // update which terminates on .eq() — return an error there.
    let qrUpdateCount = 0;
    const client = {
      from: (table: string) => {
        if (table === 'quote_requests') {
          return {
            update: () => {
              qrUpdateCount += 1;
              if (qrUpdateCount === 1) {
                const chain: Record<string, unknown> = {
                  eq: () => chain,
                  is: () => chain,
                  select: () => chain,
                  maybeSingle: () =>
                    Promise.resolve({ data: BASE_QR, error: null }),
                };
                return chain;
              }
              return {
                eq: () =>
                  Promise.resolve({
                    error: { message: 'connection lost mid-rollback' },
                  }),
              };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, {
      quoteRequestId: 'qr-fallback-fail',
    });
    // Function returns ok:false with a note; the batch is not
    // swallowed even though capture fired.
    expect(result.ok).toBe(false);
    expect(result.notes[0]).toMatch(/no businesses matched/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no-businesses fallback/);
    expect(ctx).toEqual({
      tags: {
        lib: 'enqueue',
        reason: 'noBusinessesFallbackFailed',
        quoteRequestId: 'qr-fallback-fail',
      },
    });
    // PII guard
    const tagValues = Object.values(
      (ctx as { tags: Record<string, string> }).tags
    );
    for (const v of tagValues) {
      expect(v).not.toMatch(/@/);
      expect(v).not.toMatch(/\+?\d{10,}/);
    }
  });

  it('does NOT capture on the no-businesses path when the fallback update succeeds', async () => {
    // False-positive guard: when coverage is legitimately zero and the
    // fallback status-flip succeeds, this is a business-level outcome,
    // not a system failure. Zero Sentry events expected.
    selectSpy.mockResolvedValueOnce([]);
    const { client } = makeAdmin(BASE_QR);
    const { runCallBatchWith } = await import('./engine');
    const result = await runCallBatchWith(client, { quoteRequestId: 'qr-zero-cov' });
    expect(result.ok).toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('regression guard: engine never emits the old catch-all reasons', async () => {
    // Earlier rounds used a single `reason: 'updateFailed'` or
    // untagged capture for any batch-level write error. Round 25
    // locked the three discrete reasons; Round 28 adds the no-
    // businesses fallback site. If a future refactor accidentally
    // reverts to a catch-all, this test fails.
    const LOCKED_REASONS = new Set([
      'claimFailed',
      'insertFailed',
      'plannedCountUpdateFailed',
      'callIdPersistFailed',
      'noBusinessesFallbackFailed',
    ]);
    // Trigger plannedCountUpdateFailed to get at least one capture.
    selectSpy.mockResolvedValueOnce([
      { id: 'biz-1', name: 'A', phone: '+14155550100' },
    ]);
    startSpy.mockResolvedValueOnce({ ok: true, vapiCallId: 'vc-1', simulated: false });

    let qrUpdateCount = 0;
    const client = {
      from: (table: string) => {
        if (table === 'quote_requests') {
          return {
            update: () => {
              qrUpdateCount += 1;
              if (qrUpdateCount === 1) {
                const chain: Record<string, unknown> = {
                  eq: () => chain,
                  is: () => chain,
                  select: () => chain,
                  maybeSingle: () =>
                    Promise.resolve({ data: BASE_QR, error: null }),
                };
                return chain;
              }
              return {
                eq: () =>
                  Promise.resolve({ error: { message: 'any' } }),
              };
            },
          };
        }
        if (table === 'calls') {
          return {
            insert: () => ({
              select: () =>
                Promise.resolve({
                  data: [{ id: 'call-0', business_id: 'biz-1' }],
                  error: null,
                }),
            }),
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        if (table === 'businesses') {
          return {
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as SupabaseClient;

    const { runCallBatchWith } = await import('./engine');
    await runCallBatchWith(client, { quoteRequestId: 'qr-regress' });

    for (const call of captureExceptionMock.mock.calls) {
      const ctx = call[1] as { tags: { reason: string; lib: string } };
      expect(ctx.tags.lib).toBe('enqueue');
      expect(LOCKED_REASONS.has(ctx.tags.reason)).toBe(true);
      // Explicitly guard against the catch-alls we've had in prior rounds.
      expect(ctx.tags.reason).not.toBe('updateFailed');
      expect(ctx.tags.reason).not.toBe('dispatchFailed');
      expect(ctx.tags.reason).not.toBe('runBatch');
    }
  });
});
