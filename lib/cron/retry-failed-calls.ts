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

// How many rows to process per run. Keeps a hot retry loop bounded and
// lets a 60s-limited serverless invocation finish comfortably.
const MAX_PER_RUN = 25;

// Don't re-try a row that's been retried in the last 5 minutes. Prevents
// a fast cron (e.g. every minute) from hammering Vapi when they're
// having a bad hour.
const THROTTLE_MINUTES = 5;

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
type BusinessJoin = { name: string; phone: string };
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

  // Candidates: dispatch-failed rows within the last 24h, retry_count<3,
  // and either never-retried OR retried more than THROTTLE_MINUTES ago.
  // We fetch the joined business phone/name and the request's intake_data
  // in the same round-trip to keep the loop cheap.
  const { data: rows, error } = await admin
    .from('calls')
    .select(`
      id,
      quote_request_id,
      business_id,
      retry_count,
      last_retry_at,
      created_at,
      businesses:business_id ( name, phone ),
      quote_requests:quote_request_id ( intake_data )
    `)
    .eq('status', 'failed')
    .is('started_at', null)
    .lt('retry_count', 3)
    .gte('created_at', windowStartIso)
    .order('last_retry_at', { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  if (error) {
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

    retried += 1;
    const retryStartedAt = new Date().toISOString();

    const dispatch = await startOutboundCall({
      toPhone: biz.phone,
      businessName: biz.name,
      variableValues: buildVariableValues(qr.intake_data ?? {}),
      metadata: {
        quote_request_id: row.quote_request_id,
        call_id: row.id,
        business_id: row.business_id,
        retry_attempt: String(row.retry_count + 1),
      },
    });

    if (dispatch.ok) {
      succeeded += 1;
      const { error: updErr } = await admin
        .from('calls')
        .update({
          status: 'in_progress',
          vapi_call_id: dispatch.vapiCallId,
          started_at: retryStartedAt,
          retry_count: row.retry_count + 1,
          last_retry_at: retryStartedAt,
        })
        .eq('id', row.id);
      if (updErr) {
        notes.push(`call ${row.id}: dispatched but row update failed: ${updErr.message}`);
      }
    } else {
      failed += 1;
      // Keep status=failed; bump retry_count so we eventually cap out
      // and stop re-trying. last_retry_at throttles the next attempt.
      const newRetryCount = row.retry_count + 1;
      const { error: updErr } = await admin
        .from('calls')
        .update({
          retry_count: newRetryCount,
          last_retry_at: retryStartedAt,
        })
        .eq('id', row.id);
      if (updErr) {
        notes.push(`call ${row.id}: retry failed and row update failed: ${updErr.message}`);
      } else {
        notes.push(`call ${row.id}: retry #${newRetryCount} failed: ${dispatch.error}`);
      }

      // If this retry just exhausted our cap (now at 3), the row is
      // permanently dead — no vapi_call_id, so the Vapi webhook will
      // never fire for it, which means apply_call_end will never count
      // it toward total_calls_completed. Without this, a single dead
      // phone number strands the whole request in status='calling'
      // forever and the Phase 9 report cron never picks it up.
      //
      // Count the permanent failure here so the request can advance.
      // p_quote_inserted=false since dispatch never succeeded.
      if (newRetryCount >= 3) {
        const { error: applyErr } = await admin.rpc('apply_call_end', {
          p_request_id: row.quote_request_id,
          p_quote_inserted: false,
        });
        if (applyErr) {
          // Loud log — this is the failure mode that re-creates the
          // stuck-batch bug. Ops should investigate.
          console.error(
            `[cron/retry-failed-calls] apply_call_end failed for exhausted row ${row.id} (request ${row.quote_request_id}): ${applyErr.message}`
          );
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

// The variable-building logic mirrors lib/calls/engine.ts. Kept here as
// a small duplicate because importing from engine would pull in the full
// batch-claim machinery. Any change to BUSINESS_REACHABLE_KEYS should be
// mirrored there (grep for BUSINESS_REACHABLE_KEYS).
const BUSINESS_REACHABLE_KEYS = new Set<string>([
  'contact_phone',
  'contact_email',
  'origin_address',
  'destination_address',
  'address',
]);

function buildVariableValues(
  intake: Record<string, unknown>
): Record<string, string | number | null | undefined> {
  const out: Record<string, string | number | null | undefined> = {};
  for (const [k, v] of Object.entries(intake)) {
    if (BUSINESS_REACHABLE_KEYS.has(k)) continue;
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (Array.isArray(v)) {
      out[k] = v.join(', ');
    } else if (typeof v === 'number') {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

function flattenOne<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}
