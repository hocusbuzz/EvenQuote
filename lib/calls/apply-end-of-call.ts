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
// Idempotency: short-circuits on any TERMINAL_STATUS so replay is safe.

import type { SupabaseClient } from '@supabase/supabase-js';
import { extractQuoteFromCall } from '@/lib/calls/extract-quote';
import { createLogger } from '@/lib/logger';

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

const TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed',
  'no_answer',
  'refused',
]);

/**
 * Apply an end-of-call report to our DB. Safe to call multiple times
 * for the same vapi_call_id — subsequent calls short-circuit.
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

  // Short-circuit on ANY terminal status. Replay-safe.
  if (TERMINAL_STATUSES.has(call.status)) {
    return {
      applied: false,
      status: call.status,
      quoteInserted: false,
      note: `call ${call.id} already in terminal status=${call.status}`,
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
          log.error('quotes insert failed', { err: quoteErr.message });
        }
      } else {
        quoteInserted = true;
      }
    } else {
      log.info('no quote extracted', { reason: extraction.reason });
    }
  }

  // 5. Bump counters on the quote_request atomically.
  const { error: rpcErr } = await admin.rpc('apply_call_end', {
    p_request_id: call.quote_request_id,
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
    log.warn('recompute_business_success_rate failed', { err: scoreErr.message });
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
