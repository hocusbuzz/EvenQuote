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
});
