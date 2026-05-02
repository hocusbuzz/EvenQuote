// Vapi call-state reconciler.
//
// WHY THIS EXISTS
// ───────────────
// Our entire post-call pipeline (transcript persist → quote extraction
// → counter bumps → status advance → report send) hangs off Vapi's
// `end-of-call-report` webhook arriving at /api/vapi/webhook. When that
// webhook drops — and it has dropped, more than once — the calls row is
// stuck `in_progress` forever, no quote is extracted, the parent
// quote_request never advances out of `calling`, and send-reports never
// fires for that customer.
//
// Failure modes we've actually seen:
//   • `ca630790` (2026-04-29): 10 calls stranded mid-flight during the
//     auth-bug deploy window — webhook hit a 401 we'd just shipped, Vapi
//     gave up after a few retries, and the data sat dead in Vapi's API.
//   • Local dev with a cloudflared trycloudflare tunnel: tunnel rotates
//     or the laptop sleeps, Vapi POSTs 500/timeout, the call ends but
//     we never know.
//   • Vapi's own webhook delivery has had outages.
//
// The fix: every 30 minutes, find calls that should have ended by now
// and pull fresh state straight from `GET /call/{id}` on Vapi's REST
// API. Hand the result to the same `applyEndOfCall` function the live
// webhook uses, so a reconciled row is byte-for-byte indistinguishable
// from one that arrived in real time (same status, same quotes insert,
// same `apply_call_end` RPC, same success-rate refresh).
//
// IDEMPOTENCY / NO DOUBLE-PROCESSING
// ──────────────────────────────────
// `applyEndOfCall` short-circuits on `calls.counters_applied_at` being
// stamped. If the webhook arrives mid-reconcile (race), whichever path
// hits first wins; the loser becomes a no-op. Both paths converge on
// the same row state, so no divergence is possible.
//
// SCOPE (what this finds)
// ───────────────────────
// Stuck = `vapi_call_id IS NOT NULL` (Vapi accepted dispatch — the row
// has something to reconcile against), AND the call should have ended
// by now: `started_at < NOW() - 30 min`, `ended_at IS NULL`, status in
// ('queued','in_progress'). Missing started_at means the dispatch never
// got past Vapi's queue, which is the retry-failed-calls cron's job,
// not ours.
//
// Bound the batch at 50 rows per tick — Vapi has a per-key rate limit
// and we'd rather process 50 fast than 500 slow. A backlog of >50
// stuck calls is a separate problem (page ops via Sentry capture).
//
// VAPI RATE-LIMIT HANDLING
// ────────────────────────
// On a 429 response, honor the Retry-After header by stopping the
// batch early. Next tick (30 min later) will resume. We don't sleep
// inside the cron — burning a 60s function timeout on `await sleep(45)`
// is wasted budget; the next tick is cheaper.
//
// SENTRY TAGGING
// ──────────────
// Canonical lib-boundary tags: `{ lib: 'cron-reconcile-calls', reason }`.
// Reasons:
//   • candidateQueryFailed — Postgres can't read calls (RLS / permission)
//   • applyEndOfCallFailed — the inner apply threw (extraction crash etc)
// Vapi GET failures (404/transport/httpError) are noted in the run
// result but NOT captured — they're per-row data quality issues, not
// systemic. A run with 50 candidates and 50 failures would otherwise
// flood Sentry; the route handler's own try/catch catches the
// catastrophic case.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyEndOfCall,
  type VapiEndOfCallReport,
} from '@/lib/calls/apply-end-of-call';
import {
  getVapiCall,
  vapiCallDurationSeconds,
} from '@/lib/calls/vapi';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/reconcile-calls');

// Row must be older than this before we consider it stuck. Anything
// younger is "still in flight" — Vapi's own retry policy gives the
// webhook ~5-10 min before giving up, so 30 min is comfortably past
// "the webhook should have fired by now if it was going to."
const STUCK_AGE_MINUTES = 30;

// Cap per tick. See file header for rationale.
const MAX_PER_RUN = 50;

// Allow-listed reasons for Sentry facets / dashboards.
export type CronReconcileReason =
  | 'candidateQueryFailed'
  | 'applyEndOfCallFailed';

export type ReconcileRunResult = {
  ok: boolean;
  scanned: number;
  /** Vapi confirmed call ended → applyEndOfCall ran (or short-circuited). */
  reconciled: number;
  /** Vapi says the call is still active — no DB write, just observed. */
  stillActive: number;
  /** Vapi 404'd the call id — likely a sim_* id or a deleted call. */
  notFound: number;
  /** Vapi 429'd — we stopped the batch early. */
  rateLimited: boolean;
  /** Per-row apply or fetch errors that did not crash the run. */
  failed: number;
  notes: string[];
};

type StuckCandidate = {
  id: string;
  vapi_call_id: string;
  status: string;
  started_at: string | null;
  created_at: string;
};

export async function reconcileStuckCalls(
  admin: SupabaseClient,
): Promise<ReconcileRunResult> {
  const notes: string[] = [];

  // The "stuck" window is anchored on `started_at` — Vapi accepted the
  // call and started ringing it. If that field is null, dispatch never
  // succeeded; that's the retry-failed-calls cron's territory, not ours.
  const stuckCutoffIso = new Date(
    Date.now() - STUCK_AGE_MINUTES * 60 * 1000,
  ).toISOString();

  const { data: rows, error } = await admin
    .from('calls')
    .select('id, vapi_call_id, status, started_at, created_at')
    .not('vapi_call_id', 'is', null)
    .is('ended_at', null)
    .in('status', ['queued', 'in_progress'])
    .lt('started_at', stuckCutoffIso)
    .order('started_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    // Same silent-failure logic as retry-failed-calls: ok:false from
    // here is invisible to the route's try/catch, so capture explicitly.
    log.error('candidate query failed', { err: error });
    captureException(new Error(error.message), {
      tags: {
        lib: 'cron-reconcile-calls',
        reason: 'candidateQueryFailed',
      },
    });
    return {
      ok: false,
      scanned: 0,
      reconciled: 0,
      stillActive: 0,
      notFound: 0,
      rateLimited: false,
      failed: 0,
      notes: [`candidate query: ${error.message}`],
    };
  }

  const candidates = (rows ?? []) as StuckCandidate[];

  let reconciled = 0;
  let stillActive = 0;
  let notFound = 0;
  let failed = 0;
  let rateLimited = false;

  for (const row of candidates) {
    const fetchResult = await getVapiCall(row.vapi_call_id);

    if (!fetchResult.ok) {
      switch (fetchResult.reason) {
        case 'noApiKey':
          // Should never hit prod — validateServerEnv requires VAPI_API_KEY.
          // In local/test, this is the correct answer: skip the row,
          // don't pretend we know the call's state.
          notes.push(
            `call ${row.id}: VAPI_API_KEY not set — cannot reconcile`,
          );
          failed += 1;
          continue;
        case 'notFound':
          // Vapi has no record. Most likely cause: the row's
          // vapi_call_id is a `sim_*` simulation id from local dev that
          // somehow leaked. Less likely: the call was manually deleted
          // in the Vapi dashboard. Either way, leave it alone — we
          // can't reconstruct outcome from nothing.
          notes.push(
            `call ${row.id}: vapi 404 for ${row.vapi_call_id} — left alone`,
          );
          notFound += 1;
          continue;
        case 'rateLimited':
          // Stop early. Next tick resumes. Don't sleep inside the cron.
          rateLimited = true;
          notes.push(
            `vapi 429 — stopping batch early${
              fetchResult.retryAfterSec
                ? ` (retry-after ${fetchResult.retryAfterSec}s)`
                : ''
            }`,
          );
          return {
            ok: true,
            scanned: candidates.length,
            reconciled,
            stillActive,
            notFound,
            rateLimited,
            failed,
            notes,
          };
        case 'httpError':
          notes.push(
            `call ${row.id}: vapi GET ${fetchResult.status}: ${fetchResult.body}`,
          );
          failed += 1;
          continue;
        case 'transport':
          notes.push(
            `call ${row.id}: vapi GET transport error: ${fetchResult.message}`,
          );
          failed += 1;
          continue;
      }
    }

    const rec = fetchResult.record;

    // If Vapi itself says the call hasn't ended, don't write. We'd be
    // synthesizing a "completed" with empty transcript. The next tick
    // will pick this row up again — at >60 min old, that's actually
    // diagnostic ("Vapi thinks this call is still active 60 min in"
    // is a separate alert worth surfacing, but we don't fire it from
    // here).
    if (rec.status && rec.status !== 'ended') {
      notes.push(
        `call ${row.id}: vapi status=${rec.status} — not ended, leaving`,
      );
      stillActive += 1;
      continue;
    }

    // Shape into the same VapiEndOfCallReport the webhook receives.
    // Mirrors lib/calls/apply-end-of-call's expected shape.
    const report: VapiEndOfCallReport = {
      type: 'end-of-call-report',
      call: { id: row.vapi_call_id },
      callId: row.vapi_call_id,
      transcript: rec.transcript,
      summary: rec.summary ?? rec.analysis?.summary,
      recordingUrl: rec.recordingUrl,
      cost: rec.cost,
      durationSeconds: vapiCallDurationSeconds(rec),
      endedReason: rec.endedReason,
      analysis: rec.analysis
        ? {
            structuredData: rec.analysis.structuredData,
            successEvaluation: rec.analysis.successEvaluation ?? null,
          }
        : undefined,
    };

    try {
      const apply = await applyEndOfCall(admin, row.vapi_call_id, report);
      reconciled += 1;
      if (apply.note) {
        notes.push(`call ${row.id}: ${apply.note}`);
      } else if (apply.applied) {
        notes.push(
          `call ${row.id}: reconciled → status=${apply.status}${
            apply.quoteInserted ? ' (quote inserted)' : ''
          }`,
        );
      }
    } catch (err) {
      // applyEndOfCall throws on Postgres update / RPC failures. Don't
      // let one bad row kill the batch — log + capture + continue.
      // counter is `failed` for ops visibility; the row stays stuck and
      // the next tick will retry.
      const wrapped = err instanceof Error ? err : new Error(String(err));
      log.error('applyEndOfCall failed during reconcile', {
        callId: row.id,
        vapiCallId: row.vapi_call_id,
        err: wrapped.message,
      });
      captureException(wrapped, {
        tags: {
          lib: 'cron-reconcile-calls',
          reason: 'applyEndOfCallFailed',
          callId: row.id,
        },
      });
      notes.push(`call ${row.id}: apply failed: ${wrapped.message}`);
      failed += 1;
    }
  }

  return {
    ok: true,
    scanned: candidates.length,
    reconciled,
    stillActive,
    notFound,
    rateLimited,
    failed,
    notes,
  };
}
