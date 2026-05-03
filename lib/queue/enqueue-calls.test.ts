// Tests for enqueueQuoteCalls — the thin facade over runCallBatch.
//
// enqueueQuoteCalls translates the engine's RunBatchResult shape into
// the EnqueueResult shape the Stripe webhook expects. We stub the
// engine module so we can exercise each translation branch directly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Round 22 lib-boundary capture audit: the facade must NOT emit its own
// captureException. All capture happens inside engine (see
// lib/calls/engine.test.ts for the claimFailed/insertFailed locks).
// Double-capture would re-fingerprint the same error under two lib
// tags and inflate alert volume; no-capture-at-facade is the contract.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

function mockEngine(result: unknown) {
  vi.doMock('@/lib/calls/engine', () => ({
    runCallBatch: vi.fn().mockResolvedValue(result),
  }));
}

function mockEngineThrows(err: Error) {
  vi.doMock('@/lib/calls/engine', () => ({
    runCallBatch: vi.fn().mockRejectedValue(err),
  }));
}

// #117 — enqueueQuoteCalls now reads `quote_requests` for a business-hours
// deferral check before delegating to runCallBatch. We mock the admin
// client to return a row whose state resolves to a tz that's currently
// in-hours, so the facade always falls through to runCallBatch (the
// deferral path has its own dedicated coverage in the cron tests).
function mockAdminAndBusinessHours() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: { id: 'qr-x', state: 'CA', scheduled_dispatch_at: null },
                error: null,
              }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: null }),
        }),
      }),
    }),
  }));
  // Force in-hours so the facade always falls through to runCallBatch.
  vi.doMock('@/lib/scheduling/business-hours', () => ({
    isBusinessHoursLocal: () => true,
    nextBusinessHourStart: () => new Date(),
    resolveTimezoneFromState: () => 'America/Los_Angeles',
  }));
}

describe('enqueueQuoteCalls', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    mockAdminAndBusinessHours();
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

  // ── Round 22 lib-boundary capture audit ──
  //
  // enqueueQuoteCalls is a pass-through translation layer over
  // runCallBatch. Engine captures claimFailed / insertFailed at its
  // own lib boundary (`{ lib: 'enqueue', reason: '…' }`) — see
  // lib/calls/engine.test.ts. The facade must stay silent so that a
  // single logical error fires exactly ONE lib-tagged capture event
  // (the route layer adds its own orthogonal `{ route, … }` facet).
  // Double-capture here would re-fingerprint under two lib tags and
  // inflate alert volume on every engine failure.

  it('does NOT capture on the happy path (no double-capture at facade)', async () => {
    mockEngine({
      ok: true,
      quoteRequestId: 'qr-nocap-happy',
      selected: 5,
      dispatched: 5,
      failed: 0,
      simulated: false,
      notes: [],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    await enqueueQuoteCalls({ quoteRequestId: 'qr-nocap-happy' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT capture when engine returns ok:false (soft failure, not an exception)', async () => {
    // ok:false is a soft-failure reason string (e.g. "no businesses
    // matched") — the engine already decided this isn't capture-worthy.
    // Facade must not retroactively upgrade it to a capture.
    mockEngine({
      ok: false,
      quoteRequestId: 'qr-nocap-soft',
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: ['no businesses matched'],
    });
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    await enqueueQuoteCalls({ quoteRequestId: 'qr-nocap-soft' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT capture when engine throws — exception propagates, engine already captured', async () => {
    // When engine throws (claimFailed / insertFailed path), engine.ts
    // has already fired captureException with its canonical tags. The
    // facade just lets the error bubble — no try/catch, no second
    // capture. This lock ensures a future maintainer doesn't add a
    // "defensive" catch-and-capture here.
    mockEngineThrows(new Error('runCallBatch claim: db connection reset'));
    const { enqueueQuoteCalls } = await import('./enqueue-calls');
    await expect(
      enqueueQuoteCalls({ quoteRequestId: 'qr-nocap-throw' })
    ).rejects.toThrow(/runCallBatch claim/);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
