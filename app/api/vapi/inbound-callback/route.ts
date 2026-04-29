// Vapi inbound-callback webhook — a contractor called our number back
// after we left them the voicemail recap, talked to the "evenquote-
// callback" Vapi assistant, and left their availability + price.
//
// Flow:
//   1. Verify the shared-secret header (same VAPI_WEBHOOK_SECRET used
//      by the outbound webhook — the callback assistant is configured
//      with the same secret on its server.url).
//   2. Extract the caller's phone + call analysis.
//   3. Match to a quote_request via match-inbound (normalized phone →
//      business → most-recent outbound calls row).
//   4. Insert a new `calls` row representing the inbound leg (status =
//      'completed', vapi_call_id of the inbound call) so we keep a
//      one-call-per-quote audit trail.
//   5. Insert a `quotes` row pointing at the new calls row, carrying
//      the price/availability extracted by the Vapi structured-data
//      plan OR by running our own extractor over the transcript.
//   6. Bump total_quotes_collected on the matching quote_request.
//
// Idempotency: the new calls row's vapi_call_id is UNIQUE; duplicate
// deliveries (Vapi retries) get a 23505 on insert which we swallow.
// The quotes insert uses UNIQUE(call_id) for the same guarantee.
//
// Orphan handling: if match returns null, we log and 200 — we don't
// want Vapi to retry forever for a callback from a number we've never
// called. A future `inbound_orphans` table could capture these for
// manual reconciliation.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyVapiWebhook } from '@/lib/calls/vapi';
import { matchInboundToQuoteRequest } from '@/lib/calls/match-inbound';
import { extractQuoteFromCall } from '@/lib/calls/extract-quote';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('vapi/inbound-callback');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Relaxed shape — mirrors VapiEndOfCallReport from the outbound webhook
// but includes `customer` so we can pull the caller's phone.
type InboundCallReport = {
  type: 'end-of-call-report';
  call?: { id?: string; customer?: { number?: string } };
  callId?: string;
  customer?: { number?: string };
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  cost?: number;
  durationSeconds?: number;
  endedReason?: string;
  analysis?: {
    structuredData?: Record<string, unknown>;
    successEvaluation?: string | null;
  };
};

type VapiEnvelope = {
  message?: InboundCallReport | { type: string };
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
    return new Response('ignored', { status: 200 });
  }

  const report = msg as InboundCallReport;
  const vapiCallId = report.call?.id ?? report.callId;
  if (!vapiCallId) {
    return new Response('missing call.id', { status: 400 });
  }

  const callerPhone =
    report.call?.customer?.number ?? report.customer?.number ?? '';
  if (!callerPhone) {
    log.warn('inbound callback with no caller phone', { vapiCallId });
    return new Response('ok', { status: 200 });
  }

  const admin = createAdminClient();
  try {
    await handleInboundCallback(admin, vapiCallId, callerPhone, report);
  } catch (err) {
    log.error('handler failed', { err, vapiCallId });
    captureException(err, {
      tags: { route: 'vapi/inbound-callback', vapiCallId },
    });
    return new Response('handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}

async function handleInboundCallback(
  admin: SupabaseClient,
  vapiCallId: string,
  callerPhone: string,
  report: InboundCallReport
) {
  // Idempotency: if we've already recorded this inbound call, no-op.
  const { data: existing } = await admin
    .from('calls')
    .select('id, status')
    .eq('vapi_call_id', vapiCallId)
    .maybeSingle();
  if (existing) {
    log.info('inbound already recorded — skipping', { vapiCallId, callId: existing.id });
    return;
  }

  // Find which quote_request this callback belongs to.
  const match = await matchInboundToQuoteRequest(admin, callerPhone);
  if (!match) {
    log.warn('inbound callback: no match', {
      vapiCallId,
      callerPhoneMasked: callerPhone.replace(/\d(?=\d{4})/g, '*'),
    });
    return;
  }

  // Insert the inbound calls row. status='completed' from the jump
  // since we only get here on end-of-call-report.
  const { data: insertedCall, error: callErr } = await admin
    .from('calls')
    .insert({
      quote_request_id: match.quoteRequestId,
      business_id: match.businessId,
      vapi_call_id: vapiCallId,
      status: 'completed',
      started_at: new Date(Date.now() - (report.durationSeconds ?? 0) * 1000).toISOString(),
      ended_at: new Date().toISOString(),
      duration_seconds: report.durationSeconds ?? null,
      transcript: report.transcript ?? null,
      recording_url: report.recordingUrl ?? null,
      summary: report.summary ?? null,
      extracted_data: report.analysis?.structuredData ?? null,
      cost: report.cost ?? null,
    })
    .select('id')
    .single();

  if (callErr) {
    // 23505 → race with a concurrent delivery; we already logged. No-op.
    if ((callErr as { code?: string }).code === '23505') return;
    throw new Error(`inbound calls insert: ${callErr.message}`);
  }

  // Extract a quote — prefer Vapi's structured data (faster, already
  // done), fall back to running our Claude-based extractor on the
  // transcript + summary for vertical-specific fields.
  const extraction = await extractQuoteFromCall({
    transcript: report.transcript ?? null,
    summary: report.summary ?? null,
    vapiAnalysis: report.analysis,
    categoryContext: match.categoryName
      ? {
          displayName: match.categoryName,
          extractionSchema: match.extractionSchema as
            | {
                domain_notes?: string;
                includes_examples?: string[];
                excludes_examples?: string[];
                price_anchors?: string;
                onsite_estimate_common?: boolean;
              }
            | null,
        }
      : undefined,
  });

  if (!extraction.ok) {
    log.info('inbound callback: no quote extracted', {
      callId: insertedCall.id,
      reason: extraction.reason,
    });
    return;
  }

  const { error: quoteErr } = await admin.from('quotes').insert({
    call_id: insertedCall.id,
    quote_request_id: match.quoteRequestId,
    business_id: match.businessId,
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
    if ((quoteErr as { code?: string }).code !== '23505') {
      throw new Error(`inbound quotes insert: ${quoteErr.message}`);
    }
    return; // already recorded
  }

  // Bump quotes_collected counter on the parent request. We do NOT
  // call apply_call_end — that would require a new counters sentinel
  // on this inbound call and would bump total_calls_completed beyond
  // total_businesses_to_call, which the status-advance logic doesn't
  // expect. A simple increment keeps the invariants intact.
  const { error: bumpErr } = await admin.rpc('increment_quotes_collected', {
    p_request_id: match.quoteRequestId,
  });
  if (bumpErr) {
    // RPC may not exist yet — log but don't fail the webhook; the
    // quote is safely persisted and ops can reconcile the counter if
    // the RPC is missing.
    log.warn('increment_quotes_collected failed (RPC may not exist)', {
      err: bumpErr.message,
      requestId: match.quoteRequestId,
    });
  }

  log.info('inbound callback applied', {
    vapiCallId,
    callId: insertedCall.id,
    requestId: match.quoteRequestId,
    businessId: match.businessId,
  });
}
