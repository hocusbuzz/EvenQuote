// Vapi webhook — end-of-call handler.
//
// Vapi POSTs a few event types; we only care about `end-of-call-report`,
// which is fired once the assistant hangs up and includes the transcript,
// summary, and Vapi's post-call analysis. We:
//
//   1. Verify the shared-secret header (VAPI_WEBHOOK_SECRET).
//   2. Locate our calls row via vapi_call_id (unique index).
//   3. Persist transcript/summary/recording/cost/duration.
//   4. Attempt quote extraction (OpenAI or Vapi's structured data).
//   5. Insert a quotes row if extraction succeeded.
//   6. Bump request counters; advance request status if this was the
//      last outstanding call.
//
// Idempotency: if the calls row is already status='completed', we
// short-circuit. Vapi retries are rare but possible — don't want two
// quote rows for one call (the quotes table's unique(call_id) would
// catch that anyway, but better to no-op early).

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyVapiWebhook } from '@/lib/calls/vapi';
import { extractQuoteFromCall } from '@/lib/calls/extract-quote';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type VapiEndOfCallReport = {
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
  // Some Vapi configurations wrap the call id here instead. We accept both.
  callId?: string;
};

type VapiEnvelope = {
  message?: VapiEndOfCallReport | { type: string };
};

export async function POST(req: Request) {
  const verification = verifyVapiWebhook(req);
  if (!verification.ok) {
    return new Response(verification.error, { status: 401 });
  }

  let payload: VapiEnvelope;
  try {
    payload = (await req.json()) as VapiEnvelope;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }

  const msg = payload.message;
  if (!msg || msg.type !== 'end-of-call-report') {
    // We only process end-of-call. Anything else gets a quick 200 so
    // Vapi doesn't retry.
    return new Response('ignored', { status: 200 });
  }

  const report = msg as VapiEndOfCallReport;
  const vapiCallId = report.call?.id ?? report.callId;
  if (!vapiCallId) {
    return new Response('missing call.id', { status: 400 });
  }

  const admin = createAdminClient();
  try {
    await handleEndOfCall(admin, vapiCallId, report);
  } catch (err) {
    console.error('[vapi webhook] handler failed', err);
    // Return 500 so Vapi retries. The handler itself guards against
    // double-processing so retries are safe.
    return new Response('handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}

async function handleEndOfCall(
  admin: SupabaseClient,
  vapiCallId: string,
  report: VapiEndOfCallReport
) {
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
    // Not one of ours — accept and move on. Common in shared accounts
    // where a test call in another app uses the same Vapi number.
    console.log(`[vapi webhook] no calls row for vapi_call_id=${vapiCallId}; ignoring`);
    return;
  }

  if (call.status === 'completed' || call.status === 'failed') {
    console.log(`[vapi webhook] call ${call.id} already in terminal status=${call.status}; skipping`);
    return;
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
    // Pull the category context off the joined select above. Supabase-js
    // returns nested relations as object-or-array depending on cardinality;
    // flattenJoined handles both.
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
        // the expected failure here; swallow it. Anything else logs.
        if ((quoteErr as { code?: string }).code !== '23505') {
          console.error(`[vapi webhook] quotes insert: ${quoteErr.message}`);
        }
      } else {
        quoteInserted = true;
      }
    } else {
      console.log(`[vapi webhook] no quote extracted: ${extraction.reason}`);
    }
  }

  // 5. Bump counters on the quote_request atomically. apply_call_end is
  //    a plpgsql function (migration 0006) that increments in a single
  //    UPDATE ... RETURNING, so two concurrent end-of-call events can't
  //    lose an increment. Also flips status → 'processing' when the
  //    completed count catches up to the planned batch size.
  const { error: rpcErr } = await admin.rpc('apply_call_end', {
    p_request_id: call.quote_request_id,
    p_quote_inserted: quoteInserted,
  });

  if (rpcErr) {
    throw new Error(`apply_call_end: ${rpcErr.message}`);
  }

  // 6. Refresh the business's rolling call_success_rate. This is
  //    best-effort — a failure here shouldn't fail the webhook (Vapi
  //    would just retry for a counter that's already correct). Log and
  //    move on.
  const { error: scoreErr } = await admin.rpc('recompute_business_success_rate', {
    p_business_id: call.business_id,
    p_window: 20,
  });
  if (scoreErr) {
    console.warn(`[vapi webhook] recompute_business_success_rate: ${scoreErr.message}`);
  }
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
 * Map Vapi's endedReason strings onto our call_status enum. The exact
 * set of reasons Vapi emits has changed over time; we match on patterns
 * and default to 'completed' when a transcript is present.
 */
function classifyOutcome(report: VapiEndOfCallReport): Outcome {
  const reason = (report.endedReason ?? '').toLowerCase();

  if (reason.includes('no-answer') || reason.includes('voicemail') || reason.includes('busy')) {
    return { status: 'no_answer' };
  }
  if (reason.includes('failed') || reason.includes('error') || reason.includes('twilio')) {
    return { status: 'failed' };
  }
  // Some assistants emit a "customer-hungup" very early; treat super-short
  // calls as refused.
  if ((report.durationSeconds ?? 0) < 10 && !report.transcript) {
    return { status: 'refused' };
  }
  return { status: 'completed' };
}
