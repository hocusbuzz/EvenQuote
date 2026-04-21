// Phase 6: enqueueQuoteCalls delegates to the real call engine.
//
// This file used to be a stub that only advanced status pending_payment
// → paid → calling. Phase 6 promotes it to a thin facade over
// lib/calls/engine.ts, which:
//   • claims the batch (idempotent on status + vapi_batch_started_at)
//   • selects businesses
//   • inserts calls rows
//   • dispatches via Vapi (or simulates if VAPI_* env is missing)
//
// We keep this module's public shape stable — the Stripe webhook
// imports { enqueueQuoteCalls } and expects the same return type as
// before. Changing the signature would require coordinated updates
// across handlers.

import { runCallBatch } from '@/lib/calls/engine';

type EnqueueInput = {
  quoteRequestId: string;
};

type EnqueueResult =
  | { ok: true; advanced: true; enqueued: number; note?: string }
  | { ok: true; advanced: false; enqueued: 0; reason: string };

export async function enqueueQuoteCalls(input: EnqueueInput): Promise<EnqueueResult> {
  const { quoteRequestId } = input;
  if (!quoteRequestId) {
    throw new Error('enqueueQuoteCalls: quoteRequestId required');
  }

  const result = await runCallBatch({ quoteRequestId });

  if (!result.ok) {
    return {
      ok: true,
      advanced: false,
      enqueued: 0,
      reason:
        result.notes[0] ??
        'call engine reported failure without a note — check logs',
    };
  }

  if (result.dispatched === 0 && result.selected === 0) {
    return {
      ok: true,
      advanced: false,
      enqueued: 0,
      reason: 'batch already claimed or no businesses matched — see engine notes',
    };
  }

  return {
    ok: true,
    advanced: true,
    enqueued: result.dispatched,
    note: result.simulated
      ? `simulated ${result.dispatched}/${result.selected} calls (no VAPI_* env)`
      : `dispatched ${result.dispatched}/${result.selected} calls (${result.failed} failed)`,
  };
}
