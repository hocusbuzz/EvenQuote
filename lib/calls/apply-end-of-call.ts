// Shared end-of-call application logic.
//
// The Vapi webhook (/api/vapi/webhook) calls this; the dev backfill
// endpoint (/api/dev/backfill-call) also calls this after fetching a
// call's final state from Vapi's REST API. Keeping them on the same
// code path guarantees that a backfilled call is indistinguishable
// from one that came in over the webhook in real time:
//
//   - same calls-row update (status/transcript/cost/…)
//   - same extraction prompt
//   - same quotes insert (including UNIQUE(call_id) idempotency)
//   - same apply_call_end RPC (counters + status advance)
//   - same recompute_business_success_rate refresh
//
// Idempotency: short-circuits on calls.counters_applied_at being stamped.
// (Was previously a status-terminal check, which silently dropped counter
// bumps if the RPC failed after the status UPDATE had already succeeded —
// fixed in migration 0008. The status UPDATE, quote insert, and RPC are
// individually idempotent, so on a retry-repair we re-run the lot; the
// RPC's internal claim UPDATE guarantees counters bump at most once.)

import type { SupabaseClient } from '@supabase/supabase-js';
import { extractQuoteFromCall } from '@/lib/calls/extract-quote';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('apply-end-of-call');

/**
 * Normalized end-of-call payload. The real webhook receives this under
 * `message:` in Vapi's envelope; the backfill endpoint constructs it
 * from `GET /call/{id}` on Vapi's REST API. Keep this shape shallow and
 * independent of Vapi's envelope format.
 */
export type VapiEndOfCallReport = {
  type: 'end-of-call-report';
  call?: { id?: string };
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  cost?: number;
  durationSeconds?: number;
  endedReason?: string;
  analysis?: {
    structuredData?: unknown;
    successEvaluation?: string | null;
  };
  /** Some Vapi configurations put the id here instead of call.id. */
  callId?: string;
};

export type ApplyResult = {
  /** True if we did work. False if we short-circuited (already terminal, or no matching row). */
  applied: boolean;
  /** Final status we wrote (or existing status if short-circuited). */
  status?: string;
  /** True if a quotes row was inserted this run. */
  quoteInserted: boolean;
  /** Human-readable reason we didn't do work, or a note. */
  note?: string;
};

/**
 * Apply an end-of-call report to our DB. Safe to call multiple times
 * for the same vapi_call_id — subsequent calls short-circuit only once
 * counters_applied_at has been stamped. A call that wrote a terminal
 * status but whose RPC failed before stamping the sentinel will
 * correctly re-run on the next webhook retry.
 */
export async function applyEndOfCall(
  admin: SupabaseClient,
  vapiCallId: string,
  report: VapiEndOfCallReport
): Promise<ApplyResult> {
  // 1. Look up our calls row by vapi_call_id. Fetch the category via
  //    quote_requests so extraction can load the right per-vertical prompt.
  const { data: call, error: lookupErr } = await admin
    .from('calls')
    .select(`
      id,
      quote_request_id,
      business_id,
      status,
      counters_applied_at,
      quote_requests (
        category_id,
        service_categories (
          name,
          slug,
          extraction_schema
        )
      )
    `)
    .eq('vapi_call_id', vapiCallId)
    .maybeSingle();

  if (lookupErr) throw new Error(`calls lookup: ${lookupErr.message}`);
  if (!call) {
    // Not one of ours — accept and move on.
    return {
      applied: false,
      quoteInserted: false,
      note: `no calls row for vapi_call_id=${vapiCallId}`,
    };
  }

  // Short-circuit ONLY when counters were already applied. Terminal
  // status alone is not sufficient — an earlier run may have written
  // the status and then crashed before the RPC bumped counters. The
  // sentinel is stamped atomically inside apply_call_end so retries can
  // correctly repair a partial apply.
  if (call.counters_applied_at) {
    return {
      applied: false,
      status: call.status,
      quoteInserted: false,
      note: `call ${call.id} counters already applied at ${call.counters_applied_at}`,
    };
  }

  // 2. Classify outcome.
  const outcome = classifyOutcome(report);

  // 3. Persist transcript + cost + duration + summary regardless of outcome.
  const { error: updateErr } = await admin
    .from('calls')
    .update({
      status: outcome.status,
      ended_at: new Date().toISOString(),
      duration_seconds: report.durationSeconds ?? null,
      transcript: report.transcript ?? null,
      recording_url: report.recordingUrl ?? null,
      summary: report.summary ?? null,
      extracted_data: report.analysis?.structuredData ?? null,
      cost: report.cost ?? null,
    })
    .eq('id', call.id);

  if (updateErr) throw new Error(`calls update: ${updateErr.message}`);

  // 4. If the call actually completed, try to extract a quote.
  let quoteInserted = false;
  if (outcome.status === 'completed') {
    const sc = flattenJoinedCategory(call);

    const extraction = await extractQuoteFromCall({
      transcript: report.transcript ?? null,
      summary: report.summary ?? null,
      vapiAnalysis: report.analysis,
      categoryContext: sc
        ? {
            displayName: sc.name ?? sc.slug ?? 'service',
            extractionSchema: sc.extraction_schema,
          }
        : undefined,
    });

    if (extraction.ok) {
      const { error: quoteErr } = await admin.from('quotes').insert({
        call_id: call.id,
        quote_request_id: call.quote_request_id,
        business_id: call.business_id,
        price_min: extraction.quote.priceMin,
        price_max: extraction.quote.priceMax,
        price_description: extraction.quote.priceDescription,
        availability: extraction.quote.availability,
        includes: extraction.quote.includes,
        excludes: extraction.quote.excludes,
        notes: extraction.quote.notes,
        contact_name: extraction.quote.contactName,
        contact_phone: extraction.quote.contactPhone,
        contact_email: extraction.quote.contactEmail,
        requires_onsite_estimate: extraction.quote.requiresOnsiteEstimate,
        confidence_score: extraction.quote.confidenceScore,
      });

      if (quoteErr) {
        // quotes.call_id is UNIQUE — duplicate insert from a retry is
        // the expected failure here; swallow it.
        if ((quoteErr as { code?: string }).code !== '23505') {
          log.error('quotes insert failed', { err: quoteErr });
          // Lib-boundary capture for non-23505 quote-insert failures.
          // 23505 (unique_violation) is the expected retry path and is
          // intentionally NOT captured — capturing it would flood Sentry
          // on every Vapi redelivery. Everything else (permission denied,
          // schema drift, FK violations) is a real ops signal.
          //
          // Tag shape mirrors `lib/calls/engine.ts`: `lib` names the
          // caller-visible operation, `reason` disambiguates the failure
          // mode within that lib, and we carry both the internal call id
          // and quote_request_id as opaque UUIDs. No PII: contactName,
          // contactPhone, contactEmail are deliberately NOT in tags.
          const wrapped = new Error(
            `apply-end-of-call quotes insert: ${(quoteErr as { message?: string }).message ?? 'unknown'}`
          );
          captureException(wrapped, {
            tags: {
              lib: 'apply-end-of-call',
              reason: 'quotesInsertFailed',
              callId: call.id,
              quoteRequestId: call.quote_request_id,
            },
          });
        }
      } else {
        quoteInserted = true;
      }
    } else {
      // The reason is intentionally NOT captured to Sentry (would flood
      // on benign cases like empty transcripts), but we need ops
      // visibility to tune the extractor prompt. Bumping from .info to
      // .warn so it stands out in dev-server output, and enriching with
      // enough context (callId, transcript length, summary preview) to
      // diagnose without going back to Supabase. R47.1.
      log.warn('no quote extracted from call', {
        reason: extraction.reason,
        callId: call.id,
        businessId: call.business_id,
        quoteRequestId: call.quote_request_id,
        transcriptLen: (report.transcript ?? '').length,
        summaryPreview: (report.summary ?? '').slice(0, 200),
      });
    }
  }

  // 5. Bump counters on the quote_request atomically. The RPC also
  //    atomically stamps calls.counters_applied_at so a retry of this
  //    function after a post-status-UPDATE crash will re-execute here
  //    (good — we need it to run) but the RPC itself will no-op the
  //    counter bump if it already ran (good — no double-count).
  const { error: rpcErr } = await admin.rpc('apply_call_end', {
    p_request_id: call.quote_request_id,
    p_call_id: call.id,
    p_quote_inserted: quoteInserted,
  });

  if (rpcErr) {
    throw new Error(`apply_call_end: ${rpcErr.message}`);
  }

  // 6. Best-effort success-rate refresh.
  const { error: scoreErr } = await admin.rpc('recompute_business_success_rate', {
    p_business_id: call.business_id,
    p_window: 20,
  });
  if (scoreErr) {
    log.warn('recompute_business_success_rate failed', { err: scoreErr });
    // Best-effort, so we don't throw — but we DO capture. A persistent
    // failure here means business.success_rate goes stale, which feeds
    // directly into the business selector's ranking. Without Sentry we'd
    // silently degrade quote quality.
    //
    // businessId is carried as an opaque UUID (not a business name) to
    // keep tags PII-free.
    const wrapped = new Error(
      `apply-end-of-call recompute_business_success_rate: ${scoreErr.message}`
    );
    captureException(wrapped, {
      tags: {
        lib: 'apply-end-of-call',
        reason: 'recomputeFailed',
        callId: call.id,
        businessId: call.business_id,
      },
    });
  }

  return {
    applied: true,
    status: outcome.status,
    quoteInserted,
  };
}

/**
 * Supabase-js nested selects return a table-shaped object OR a single-
 * element array depending on cardinality. We flatten both shapes down
 * to a plain object so the webhook doesn't have to care.
 */
function flattenJoinedCategory(call: unknown): {
  name?: string;
  slug?: string;
  extraction_schema?: {
    domain_notes?: string;
    includes_examples?: string[];
    excludes_examples?: string[];
    price_anchors?: string;
    onsite_estimate_common?: boolean;
  } | null;
} | undefined {
  if (!call || typeof call !== 'object') return undefined;
  const qrRaw = (call as { quote_requests?: unknown }).quote_requests;
  const qr = Array.isArray(qrRaw) ? qrRaw[0] : qrRaw;
  if (!qr || typeof qr !== 'object') return undefined;
  const scRaw = (qr as { service_categories?: unknown }).service_categories;
  const sc = Array.isArray(scRaw) ? scRaw[0] : scRaw;
  if (!sc || typeof sc !== 'object') return undefined;
  return sc as ReturnType<typeof flattenJoinedCategory>;
}

type Outcome = { status: 'completed' | 'failed' | 'no_answer' | 'refused' };

/**
 * Map Vapi's endedReason strings onto our call_status enum.
 */
export function classifyOutcome(report: VapiEndOfCallReport): Outcome {
  const reason = (report.endedReason ?? '').toLowerCase();

  if (reason.includes('no-answer') || reason.includes('voicemail') || reason.includes('busy')) {
    return { status: 'no_answer' };
  }
  if (reason.includes('failed') || reason.includes('error') || reason.includes('twilio')) {
    return { status: 'failed' };
  }
  if ((report.durationSeconds ?? 0) < 10 && !report.transcript) {
    return { status: 'refused' };
  }
  return { status: 'completed' };
}
