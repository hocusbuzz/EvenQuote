// Retry worker for dispatch-failed Vapi calls.
//
// Pulled out of app/api/cron/retry-failed-calls/route.ts because Next.js
// 14's App Router only permits HTTP method exports (GET/POST/…) and a
// small allowlist of config consts (dynamic, runtime, preferredRegion,
// …) from a route.ts file. Any other export — like our testable
// `retryFailedCalls` — fails the build with:
//
//   Type error: Route "…/route.ts" does not match the required types
//   of a Next.js Route. "retryFailedCalls" is not a valid Route export
//   field.
//
// Keeping the handler here lets tests (and the eventual in-process
// pg_cron caller if we ever skip HTTP) invoke the core logic directly.
//
// Scope of this retry worker (deliberately narrow):
//   • Only "dispatch failed" rows — `status='failed' AND started_at IS NULL`.
//     If started_at is set, Vapi accepted the call and a mid-call failure
//     happened; retrying could re-annoy the business or double-charge, so
//     those are excluded.
//   • Rows within the last 24 hours. Beyond that the quote request is
//     effectively stale.
//   • retry_count < 3. Hard cap.
//   • Throttled: skip any row whose last_retry_at is within 5 minutes.

import type { SupabaseClient } from '@supabase/supabase-js';
import { startOutboundCall } from '@/lib/calls/vapi';
import { buildSafeVariableValues } from '@/lib/calls/build-safe-variable-values';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/retry-failed-calls');

// ─────────────────────────────────────────────────────────────────────
// Canonical Sentry tag shape for this module:
//
//   { lib: 'cron-retry-failed-calls', reason: CronRetryReason, ... }
//
// Prior to R27 this file had NO Sentry capture. Two genuinely silent
// failure paths:
//
//  • candidate query errors returned `{ ok:false, notes:[...] }` —
//    the route handler did not throw, so the route-level try/catch
//    did not fire. Result: a Postgres permission error would cause
//    the retry worker to silently no-op on every tick.
//
//  • apply_call_end for an exhausted row failed → the row's request
//    stays stuck in status='calling' forever and the send-reports cron
//    never picks it up. This is the exact "stuck-batch bug" the code's
//    own comments call out; the test block below locks the capture.
//
// The reason values are allow-listed and enforced by a regression-
// guard test in lib/cron/retry-failed-calls.test.ts.
// ─────────────────────────────────────────────────────────────────────
export type CronRetryReason = 'candidateQueryFailed' | 'applyCallEndFailed';

// How many rows to process per run. Keeps a hot retry loop bounded and
// lets a 60s-limited serverless invocation finish comfortably.
const MAX_PER_RUN = 25;

// Don't re-try a row that's been retried in the last 5 minutes. Prevents
// a fast cron (e.g. every minute) from hammering Vapi when they're
// having a bad hour.
const THROTTLE_MINUTES = 5;

// Don't dial a contractor whose number was called for ANY request within
// this many minutes. Per-BUSINESS spacing (not per-call) — protects
// against the scenario where two paid customers both fail-dispatched
// the same business minutes apart, and the retry cron then dials it
// twice in quick succession. From the contractor's POV that reads as
// spam (missed call → unrelated callback within minutes) and damages
// supply-side trust over time.
//
// We use businesses.last_called_at (already maintained by the engine
// + retry success path) so this requires no new column. The comparison
// is against business.last_called_at, NOT the call row's last_retry_at.
const PER_BUSINESS_SPACING_MINUTES = 30;

type RetryCandidate = {
  id: string;
  quote_request_id: string;
  business_id: string;
  retry_count: number;
  last_retry_at: string | null;
  created_at: string;
};

// Matches the select below. The joined objects come back as object-
// or-array depending on cardinality — the supabase-js types we hit here
// are loose, so we narrow manually.
//
// businesses.last_called_at is the per-business spacing gate (added
// 2026-05-02). Engine + retry success path both bump it on every
// dispatch; we read it here to skip retries that would dial a
// contractor too soon after their last call.
type BusinessJoin = {
  name: string;
  phone: string;
  last_called_at: string | null;
};
type RequestJoin = { intake_data: Record<string, unknown> | null };

export type RetryRunResult = {
  ok: boolean;
  scanned: number;
  retried: number;
  succeeded: number;
  failed: number;
  throttled: number;
  notes: string[];
};

export async function retryFailedCalls(admin: SupabaseClient): Promise<RetryRunResult> {
  const notes: string[] = [];
  const throttleCutoffIso = new Date(
    Date.now() - THROTTLE_MINUTES * 60 * 1000
  ).toISOString();
  const windowStartIso = new Date(
    Date.now() - 24 * 60 * 60 * 1000
  ).toISOString();

  // Candidates: dispatch-failed rows within the last 24h, retry_count<1
  // (cost control — max 2 total attempts per business: the initial
  // dispatch plus one retry), and either never-retried OR retried more
  // than THROTTLE_MINUTES ago. We fetch the joined business phone/name
  // and the request's intake_data in the same round-trip.
  const { data: rows, error } = await admin
    .from('calls')
    .select(`
      id,
      quote_request_id,
      business_id,
      retry_count,
      last_retry_at,
      created_at,
      businesses:business_id ( name, phone, last_called_at ),
      quote_requests:quote_request_id ( intake_data, city, state, zip_code )
    `)
    .eq('status', 'failed')
    .is('started_at', null)
    .lt('retry_count', 1)
    .gte('created_at', windowStartIso)
    .order('last_retry_at', { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  if (error) {
    // Silent-failure guard: prior to R27 this branch returned ok:false
    // with only the .notes array to surface the Postgres error. The
    // route handler does not re-throw on ok:false (it returns JSON),
    // so Sentry never saw it. A 403 from Supabase (RLS drift / role
    // rotation) or a 42P01 (table rename) could no-op the retry worker
    // forever with zero pages.
    log.error('candidate query failed', { err: error });
    captureException(new Error(error.message), {
      tags: {
        lib: 'cron-retry-failed-calls',
        reason: 'candidateQueryFailed',
      },
    });
    return {
      ok: false,
      scanned: 0,
      retried: 0,
      succeeded: 0,
      failed: 0,
      throttled: 0,
      notes: [`candidate query: ${error.message}`],
    };
  }

  const candidates = (rows ?? []) as unknown as Array<
    RetryCandidate & {
      businesses: BusinessJoin | BusinessJoin[] | null;
      quote_requests: RequestJoin | RequestJoin[] | null;
    }
  >;

  // Per-business spacing cutoff (added 2026-05-02). Computed once
  // outside the loop so each candidate compares against the same
  // moment-in-time anchor.
  const perBusinessCutoffIso = new Date(
    Date.now() - PER_BUSINESS_SPACING_MINUTES * 60 * 1000,
  ).toISOString();

  let retried = 0;
  let succeeded = 0;
  let failed = 0;
  let throttled = 0;

  for (const row of candidates) {
    if (row.last_retry_at && row.last_retry_at > throttleCutoffIso) {
      throttled += 1;
      continue;
    }

    const biz = flattenOne(row.businesses);
    const qr = flattenOne(row.quote_requests);
    if (!biz || !qr) {
      notes.push(`call ${row.id}: missing business/request join — skipping`);
      continue;
    }

    // Per-business spacing gate. Skip if this contractor was dialed
    // (for ANY request) within PER_BUSINESS_SPACING_MINUTES. Counts
    // as throttled in the result so ops can see how often this fires.
    // Cron runs every ~10 min, so a skipped row gets re-evaluated soon
    // after the spacing window expires.
    if (biz.last_called_at && biz.last_called_at > perBusinessCutoffIso) {
      throttled += 1;
      notes.push(
        `call ${row.id}: per-business spacing — last dialed ${biz.last_called_at}`,
      );
      continue;
    }

    retried += 1;
    const retryStartedAt = new Date().toISOString();
    const newRetryCount = row.retry_count + 1;

    // R47.4: pre-mark the row BEFORE dialing.
    //
    // Old order (dial → success path → write retry_count) had a hole:
    // if the dial succeeded but the row update failed, the row stayed
    // in `status='failed'` with retry_count unchanged, AND the throttle
    // (last_retry_at) wasn't bumped — so the next cron tick re-dialed
    // the SAME contractor. Vapi already accepted call #1 and was
    // ringing the contractor; we'd start call #2 right behind it.
    //
    // New order: bump retry_count + last_retry_at BEFORE dispatch.
    // This serves two roles:
    //   • Throttle gate: even on a worst-case "dispatch fired but
    //     every subsequent write failed" scenario, the next cron
    //     pass sees last_retry_at within the throttle window and
    //     skips the row.
    //   • Cap enforcement: retry_count is incremented even if the
    //     dispatch crashes mid-flight, so a row can't redial forever
    //     in a stuck-loop where the dial keeps timing out + the
    //     post-write fails.
    //
    // Cost: if the pre-mark write itself fails, we bail without
    // dialing — better than a double-dial. The row stays unchanged
    // and the next tick retries.
    {
      const { error: preMarkErr } = await admin
        .from('calls')
        .update({
          retry_count: newRetryCount,
          last_retry_at: retryStartedAt,
        })
        .eq('id', row.id)
        .eq('retry_count', row.retry_count); // CAS guard against concurrent runs
      if (preMarkErr) {
        notes.push(
          `call ${row.id}: pre-mark write failed, skipping dispatch: ${preMarkErr.message}`
        );
        continue;
      }
    }

    const dispatch = await startOutboundCall({
      toPhone: biz.phone,
      businessName: biz.name,
      variableValues: buildSafeVariableValues(qr),
      metadata: {
        quote_request_id: row.quote_request_id,
        call_id: row.id,
        business_id: row.business_id,
        retry_attempt: String(newRetryCount),
      },
    });

    if (dispatch.ok) {
      succeeded += 1;
      // retry_count + last_retry_at already stamped above; only need
      // to flip status + persist the new vapi_call_id here.
      const { error: updErr } = await admin
        .from('calls')
        .update({
          status: 'in_progress',
          vapi_call_id: dispatch.vapiCallId,
          started_at: retryStartedAt,
        })
        .eq('id', row.id);
      if (updErr) {
        notes.push(
          `call ${row.id}: dispatched but vapi_call_id persist failed: ${updErr.message}`
        );
        // Same orphan risk as engine.ts — the call is mid-flight on
        // Vapi but we can't correlate the webhook back. The
        // throttle gate above prevents a retry-loop double-dial.
      }
    } else {
      failed += 1;
      // Status stays 'failed'; retry_count + last_retry_at were
      // bumped in the pre-mark above, so no further row write is
      // needed for state on this branch.
      notes.push(
        `call ${row.id}: retry #${newRetryCount} failed: ${dispatch.error}`
      );

      // If this retry just exhausted our cap (now at 1 under the 2-
      // total-attempts rule), the row is permanently dead — no
      // vapi_call_id, so the Vapi webhook will never fire for it,
      // which means apply_call_end will never count it toward
      // total_calls_completed. Without this, a single dead phone
      // number strands the whole request in status='calling' forever
      // and the Phase 9 report cron never picks it up.
      //
      // Count the permanent failure here so the request can advance.
      // p_quote_inserted=false since dispatch never succeeded.
      if (newRetryCount >= 1) {
        // p_call_id is the retry-exhausted call row itself. The RPC
        // stamps its counters_applied_at atomically, so if this cron
        // runs twice for the same row (shouldn't, but defense-in-depth)
        // only the first tick bumps counters.
        const { error: applyErr } = await admin.rpc('apply_call_end', {
          p_request_id: row.quote_request_id,
          p_call_id: row.id,
          p_quote_inserted: false,
        });
        if (applyErr) {
          // Loud log — this is the failure mode that re-creates the
          // stuck-batch bug. Ops should investigate.
          log.error('apply_call_end failed for exhausted row', {
            callId: row.id,
            requestId: row.quote_request_id,
            err: applyErr,
          });
          // THE stuck-batch bug: exhausted retry without counter bump
          // leaves the quote_request in status='calling' forever →
          // send-reports never picks it up → customer paid, never got
          // a report. Highest-value capture in this module.
          captureException(new Error(applyErr.message), {
            tags: {
              lib: 'cron-retry-failed-calls',
              reason: 'applyCallEndFailed',
              callId: row.id,
              quoteRequestId: row.quote_request_id,
            },
          });
          notes.push(`call ${row.id}: apply_call_end after exhaustion failed: ${applyErr.message}`);
        } else {
          notes.push(`call ${row.id}: exhausted retries, counted toward total_calls_completed`);
        }
      }
    }
  }

  return {
    ok: true,
    scanned: candidates.length,
    retried,
    succeeded,
    failed,
    throttled,
    notes,
  };
}

// The local `buildVariableValues` was removed in R49 / task #116.
// Use `buildSafeVariableValues` from `@/lib/calls/build-safe-variable-values`
// — allowlist-based, with PII scrubbing on free-text fields.

function flattenOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}
