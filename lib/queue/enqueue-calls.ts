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
//
// #117 — Business-hours deferral:
//   Before dispatching, we resolve the request's service-area timezone
//   (from `state`) and check whether NOW is inside Mon-Fri 9-16:30 local.
//   If OUT of hours, we DO NOT call runCallBatch — instead we stamp
//   scheduled_dispatch_at = nextBusinessHourStart() and return cleanly.
//   The /api/cron/dispatch-scheduled-requests cron picks these up later
//   and calls runCallBatch directly (bypassing this deferral check).

import { runCallBatch } from '@/lib/calls/engine';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  isBusinessHoursLocal,
  nextBusinessHourStart,
  resolveTimezoneFromState,
} from '@/lib/scheduling/business-hours';
import { createLogger } from '@/lib/logger';

const log = createLogger('queue/enqueue-calls');

type EnqueueInput = {
  quoteRequestId: string;
};

type EnqueueResult =
  | { ok: true; advanced: true; enqueued: number; note?: string }
  | { ok: true; advanced: false; enqueued: 0; reason: string }
  // #117: paid + deferred. advanced=true so the webhook's success path
  // is unchanged (we DID make progress — we just queued for cron pickup
  // rather than dispatching now). enqueued=0 distinguishes from real dispatch.
  | { ok: true; advanced: true; enqueued: 0; scheduledFor: string; note: string };

export async function enqueueQuoteCalls(input: EnqueueInput): Promise<EnqueueResult> {
  const { quoteRequestId } = input;
  if (!quoteRequestId) {
    throw new Error('enqueueQuoteCalls: quoteRequestId required');
  }

  // ── #117 deferral check ──────────────────────────────────────────
  // Read just the `state` column (cheap). We tolerate read failure by
  // falling through to runCallBatch — better to dispatch (and pay $1-2
  // for a 3am call) than to silently drop a paid request because the
  // deferral check choked on a transient DB blip.
  const supabase = createAdminClient();
  const { data: req, error: readErr } = await supabase
    .from('quote_requests')
    .select('id, state, scheduled_dispatch_at')
    .eq('id', quoteRequestId)
    .single();

  if (readErr || !req) {
    log.warn('enqueueQuoteCalls: state read failed, dispatching anyway', {
      quoteRequestId,
      err: readErr?.message,
    });
  } else if (!req.scheduled_dispatch_at) {
    // Only check hours if we haven't already deferred this one (defense
    // in depth: cron calls runCallBatch directly, but if a future caller
    // routes through here on a deferred row we don't want to re-defer).
    const tz = resolveTimezoneFromState(req.state);
    const now = new Date();
    if (!isBusinessHoursLocal(tz, now)) {
      const dispatchAt = nextBusinessHourStart(tz, now);
      const { error: updateErr } = await supabase
        .from('quote_requests')
        .update({ scheduled_dispatch_at: dispatchAt.toISOString() })
        .eq('id', quoteRequestId);

      if (updateErr) {
        // Couldn't write the schedule — fall through to immediate dispatch
        // rather than swallow the request. Worst case we make a call out
        // of hours; best case the customer gets quotes faster.
        log.warn('enqueueQuoteCalls: schedule write failed, dispatching now', {
          quoteRequestId,
          err: updateErr.message,
        });
      } else {
        log.info('enqueueQuoteCalls: deferred to local business hours', {
          quoteRequestId,
          state: req.state,
          tz,
          scheduledFor: dispatchAt.toISOString(),
        });
        return {
          ok: true,
          advanced: true,
          enqueued: 0,
          scheduledFor: dispatchAt.toISOString(),
          note: `deferred — will dispatch at ${dispatchAt.toISOString()} (${tz})`,
        };
      }
    }
  }

  // ── Immediate dispatch path (in-hours, or fall-through on read fail) ──
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
