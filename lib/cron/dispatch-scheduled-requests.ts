// dispatch-scheduled-requests cron — picks up quote_requests that were
// deferred by enqueueQuoteCalls during after-hours payment and dispatches
// them now that local business hours have opened. (#117)
//
// Lifecycle of a deferred request:
//
//   1. Stripe webhook fires → enqueueQuoteCalls reads request.state →
//      resolves IANA tz → isBusinessHoursLocal(tz, now) returns false →
//      writes scheduled_dispatch_at = nextBusinessHourStart().
//      Status stays at 'paid'. total_calls_made = 0.
//   2. This cron polls every ~5 min. SELECT WHERE
//        status = 'paid'
//        AND scheduled_dispatch_at IS NOT NULL
//        AND scheduled_dispatch_at <= now()
//        AND total_calls_made = 0
//      (Partial index quote_requests_scheduled_dispatch_idx covers it.)
//   3. For each due row, call runCallBatch DIRECTLY (not enqueueQuoteCalls
//      — we don't want the deferral check to re-fire if cron runs at
//      9:01 with a row scheduled for 9:00; runCallBatch handles the
//      claim atomically and advances status to 'calling').
//
// Why direct runCallBatch and not enqueueQuoteCalls?
//   • Avoids re-checking business hours (we know we're past the window).
//   • Avoids the deferral writeback path — runCallBatch's own claim
//     logic is idempotent and is the canonical dispatch entry point
//     for both this cron and the original webhook hot path.
//
// Concurrency safety:
//   • runCallBatch is already idempotent on (status, vapi_batch_started_at)
//     so two concurrent cron runs will both attempt but only one will
//     claim the batch. The loser sees selected=0, dispatched=0 and we
//     report it as "skipped — already claimed".
//
// PII / log safety:
//   • We log the request id and scheduled timestamp only. No customer
//     contact info touches the logger.
//
// Failure handling:
//   • Per-row exceptions are caught and converted to a structured
//     `failed[]` entry. The cron itself returns 200 with a summary so
//     Vercel cron history doesn't page on a single bad row. Top-level
//     exceptions (e.g. DB unreachable) propagate to the route handler
//     which returns 500 + Sentry capture.

import type { SupabaseClient } from '@supabase/supabase-js';
import { runCallBatch } from '@/lib/calls/engine';
import { createLogger } from '@/lib/logger';

const log = createLogger('cron/dispatch-scheduled-requests');

// Cap the per-run dispatch count to keep one cron tick bounded. With
// 5-minute scheduling and a typical morning rush, even 50 is plenty —
// we'd be dispatching $50-100 of Vapi work in one tick which is the
// upper end of what we want serial. If a backlog builds up, the next
// tick handles the rest.
const MAX_DISPATCH_PER_RUN = 50;

export type DispatchResult = {
  ok: true;
  scanned: number;
  dispatched: number;
  skipped: number;
  failed: { quoteRequestId: string; reason: string }[];
};

export async function dispatchScheduledRequests(
  admin: SupabaseClient
): Promise<DispatchResult> {
  // Pull the due rows. Order by scheduled_dispatch_at ASC so the longest
  // waiters go first (fairness — a 3am payer scheduled for 9:00 gets
  // dispatched before an 8:59am payer scheduled for 9:00.0001).
  const { data: dueRows, error } = await admin
    .from('quote_requests')
    .select('id, scheduled_dispatch_at')
    .eq('status', 'paid')
    .not('scheduled_dispatch_at', 'is', null)
    .lte('scheduled_dispatch_at', new Date().toISOString())
    .eq('total_calls_made', 0)
    .order('scheduled_dispatch_at', { ascending: true })
    .limit(MAX_DISPATCH_PER_RUN);

  if (error) {
    // Re-throw — let the route handler convert to 500 + Sentry.
    throw new Error(`dispatch-scheduled-requests query failed: ${error.message}`);
  }

  const rows = dueRows ?? [];
  log.info('scan complete', { dueCount: rows.length });

  let dispatched = 0;
  let skipped = 0;
  const failed: DispatchResult['failed'] = [];

  for (const row of rows) {
    try {
      const result = await runCallBatch({ quoteRequestId: row.id });

      if (!result.ok) {
        failed.push({
          quoteRequestId: row.id,
          reason: result.notes[0] ?? 'engine returned ok:false without note',
        });
        log.warn('row dispatch failed', {
          quoteRequestId: row.id,
          notes: result.notes,
        });
        continue;
      }

      if (result.dispatched === 0 && result.selected === 0) {
        // Two cases land here:
        //   (a) Concurrent cron tick or webhook claimed it first — fine,
        //       the other path will handle it.
        //   (b) No businesses matched any tier (zip → radius → state) —
        //       same shape as the webhook's "stranded → refund" path.
        //       Without parity, the row sits in 'paid' forever, never
        //       refunded, and ops only finds out from a customer support
        //       ticket. Real example: handyman in San Marcos 92078 on
        //       2026-05-01 — zero businesses seeded for the vertical in
        //       that zip, dispatch threw nothing useful, row stranded.
        //
        // We mirror the webhook's parking: park the row in 'processing'
        // with zero call counts so send-reports' next tick (≤5 min)
        // picks it up via the existing zero-quote refund path. Stripe
        // refund + apology email — no new code path.
        //
        // False-positive risk for case (a): if a CONCURRENT runCallBatch
        // is mid-dispatch when we park, the parked status overwrites
        // its later 'calling' update. Mitigation is light: send-reports'
        // refund-zero path checks `total_calls_made = 0` before issuing.
        // If the concurrent call has already incremented total_calls_made,
        // send-reports will see >0 calls and skip the refund path.
        const parkAdmin = await import('@/lib/supabase/admin').then((m) =>
          m.createAdminClient(),
        );
        const { error: parkErr } = await parkAdmin
          .from('quote_requests')
          .update({
            status: 'processing',
            total_businesses_to_call: 0,
            total_calls_completed: 0,
          })
          .eq('id', row.id)
          .eq('status', 'paid'); // CAS guard — don't clobber a concurrently-advanced row
        if (parkErr) {
          failed.push({
            quoteRequestId: row.id,
            reason: `park-for-refund failed: ${parkErr.message}`,
          });
          log.error('park-for-refund failed', {
            quoteRequestId: row.id,
            err: parkErr.message,
          });
          continue;
        }
        skipped += 1;
        log.warn('no businesses (or already claimed); parked for refund', {
          quoteRequestId: row.id,
        });
        continue;
      }

      dispatched += 1;
      log.info('row dispatched', {
        quoteRequestId: row.id,
        dispatched: result.dispatched,
        selected: result.selected,
        failed: result.failed,
      });
    } catch (err) {
      // Per-row failure — record and move on. Don't let one bad row
      // poison the rest of the batch.
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ quoteRequestId: row.id, reason });
      log.error('row dispatch threw', { quoteRequestId: row.id, err });
    }
  }

  return {
    ok: true,
    scanned: rows.length,
    dispatched,
    skipped,
    failed,
  };
}
