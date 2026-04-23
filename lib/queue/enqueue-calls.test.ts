// Tests for enqueueQuoteCalls — the thin facade over runCallBatch.
//
// enqueueQuoteCalls translates the engine's RunBatchResult shape into
// the EnqueueResult shape the Stripe webhook expects. We stub the
// engine module so we can exercise each translation branch directly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

function mockEngine(result: unknown) {
  vi.doMock('@/lib/calls/engine', () => ({
    runCallBatch: vi.fn().mockResolvedValue(result),
  }));
}

describe('enqueueQuoteCalls', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws when quoteRequestId is missing', async () => {
    mockEngine({ ok: true, selected: 0, dispatched: 0, failed: 0, simulated: false, notes: [] });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    await expect(enqueueQuoteCalls({ quoteRequestId: '' })).rejects.toThrow(
      /quoteRequestId required/
    );
  });

  it('returns advanced=true with dispatched count when engine succeeds', async () => {
    mockEngine({
      ok: true,
      quoteRequestId: 'qr-1',
      selected: 5,
      dispatched: 5,
      failed: 0,
      simulated: false,
      notes: [],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    const res = await enqueueQuoteCalls({ quoteRequestId: 'qr-1' });
    expect(res.ok).toBe(true);
    if (res.ok && res.advanced) {
      expect(res.enqueued).toBe(5);
      expect(res.note).toMatch(/dispatched 5\/5 calls \(0 failed\)/);
    } else {
      expect.fail('expected advanced=true');
    }
  });

  it('marks simulation in the note when engine reports simulated=true', async () => {
    mockEngine({
      ok: true,
      quoteRequestId: 'qr-2',
      selected: 3,
      dispatched: 3,
      failed: 0,
      simulated: true,
      notes: [],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    const res = await enqueueQuoteCalls({ quoteRequestId: 'qr-2' });
    expect(res.ok).toBe(true);
    if (res.ok && res.advanced) {
      expect(res.note).toMatch(/simulated 3\/3 calls/);
    } else {
      expect.fail('expected advanced=true');
    }
  });

  it('returns advanced=false when engine says ok:false (e.g. no coverage)', async () => {
    mockEngine({
      ok: false,
      quoteRequestId: 'qr-3',
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: ['no businesses matched category X in Y / 12345'],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    const res = await enqueueQuoteCalls({ quoteRequestId: 'qr-3' });
    expect(res.ok).toBe(true);
    if (res.ok && !res.advanced) {
      expect(res.enqueued).toBe(0);
      expect(res.reason).toMatch(/no businesses matched/);
    } else {
      expect.fail('expected advanced=false');
    }
  });

  it('returns advanced=false with clear reason when ok=false and notes empty', async () => {
    mockEngine({
      ok: false,
      quoteRequestId: 'qr-4',
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: [],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    const res = await enqueueQuoteCalls({ quoteRequestId: 'qr-4' });
    expect(res.ok).toBe(true);
    if (res.ok && !res.advanced) {
      expect(res.reason).toMatch(/check logs/);
    } else {
      expect.fail('expected advanced=false');
    }
  });

  it('treats an already-claimed batch (selected=0, dispatched=0, ok=true) as advanced=false', async () => {
    // runCallBatch returns ok:true, selected:0, dispatched:0 in two cases:
    // (a) the batch was already claimed by an earlier webhook retry
    // (b) zero businesses exist (falls through with an `ok:false` in engine
    //     today, but the facade must cope either way).
    mockEngine({
      ok: true,
      quoteRequestId: 'qr-5',
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: ['request not in status=paid with null vapi_batch_started_at — skipping'],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    const res = await enqueueQuoteCalls({ quoteRequestId: 'qr-5' });
    expect(res.ok).toBe(true);
    if (res.ok && !res.advanced) {
      expect(res.enqueued).toBe(0);
      expect(res.reason).toMatch(/already claimed|no businesses/);
    } else {
      expect.fail('expected advanced=false');
    }
  });

  it('preserves failed count in the success note', async () => {
    mockEngine({
      ok: true,
      quoteRequestId: 'qr-6',
      selected: 5,
      dispatched: 3,
      failed: 2,
      simulated: false,
      notes: ['call X: timeout', 'call Y: bad number'],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    const res = await enqueueQuoteCalls({ quoteRequestId: 'qr-6' });
    expect(res.ok).toBe(true);
    if (res.ok && res.advanced) {
      expect(res.enqueued).toBe(3);
      expect(res.note).toMatch(/3\/5 calls \(2 failed\)/);
    } else {
      expect.fail('expected advanced=true');
    }
  });
});
