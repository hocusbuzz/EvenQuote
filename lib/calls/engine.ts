// Call engine — turns a paid quote_request into a batch of queued calls.
//
// Called from the Stripe webhook via lib/queue/enqueue-calls.ts. This
// module does the actual work: select businesses, insert calls rows,
// dispatch via Vapi. The webhook idempotency gate (status='paid' AND
// vapi_batch_started_at IS NULL) ensures this runs at most once per
// request even under Stripe retries.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { selectBusinessesForRequest } from './select-businesses';
import { startOutboundCall } from './vapi';

// How many businesses we try to call per quote request. Configurable
// via env so we can tune without a code change. Default of 5 is
// conservative — most metro moves have plenty of coverage at 5.
const DEFAULT_BATCH_SIZE = 5;

export type RunBatchInput = {
  quoteRequestId: string;
};

export type RunBatchResult = {
  ok: boolean;
  quoteRequestId: string;
  selected: number;
  dispatched: number;
  failed: number;
  simulated: boolean;
  /** Per-call notes, for logging / admin. */
  notes: string[];
};

type QuoteRequestRow = {
  id: string;
  category_id: string;
  city: string;
  state: string;
  zip_code: string;
  intake_data: Record<string, unknown> | null;
  vapi_batch_started_at: string | null;
};

export async function runCallBatch(input: RunBatchInput): Promise<RunBatchResult> {
  const admin = createAdminClient();
  return runCallBatchWith(admin, input);
}

/**
 * Same as runCallBatch but with an injectable client for tests.
 */
export async function runCallBatchWith(
  admin: SupabaseClient,
  input: RunBatchInput
): Promise<RunBatchResult> {
  const { quoteRequestId } = input;
  const batchSize = Number(process.env.CALL_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);

  // 1. Claim the batch. Two layered idempotency checks:
  //    - status must be 'paid' (webhook set it)
  //    - vapi_batch_started_at must be NULL (we haven't already run)
  //    We flip both to their "started" states in one update. If zero
  //    rows update, someone beat us to it.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from('quote_requests')
    .update({
      status: 'calling',
      vapi_batch_started_at: claimedAt,
    })
    .eq('id', quoteRequestId)
    .eq('status', 'paid')
    .is('vapi_batch_started_at', null)
    .select('id, category_id, city, state, zip_code, intake_data, vapi_batch_started_at')
    .maybeSingle<QuoteRequestRow>();

  if (claimErr) {
    throw new Error(`runCallBatch claim: ${claimErr.message}`);
  }

  if (!claimed) {
    return {
      ok: true,
      quoteRequestId,
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: ['request not in status=paid with null vapi_batch_started_at — skipping'],
    };
  }

  // 2. Pick businesses.
  const businesses = await selectBusinessesForRequest(admin, {
    categoryId: claimed.category_id,
    zipCode: claimed.zip_code,
    state: claimed.state,
    limit: batchSize,
  });

  const notes: string[] = [];
  if (businesses.length === 0) {
    notes.push(`no businesses matched category ${claimed.category_id} in ${claimed.state} / ${claimed.zip_code}`);
    // We flipped to 'calling' already — roll back to 'failed' so ops
    // can see that this request needs attention (coverage gap).
    await admin
      .from('quote_requests')
      .update({ status: 'failed' })
      .eq('id', claimed.id);
    return {
      ok: false,
      quoteRequestId,
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes,
    };
  }

  // 3. Insert one calls row per selected business (queued). We insert
  //    in bulk so the batch is atomic at the DB level — either all
  //    show up or none do.
  const callRows = businesses.map((b) => ({
    quote_request_id: claimed.id,
    business_id: b.id,
    status: 'queued' as const,
  }));

  const { data: insertedCalls, error: insertErr } = await admin
    .from('calls')
    .insert(callRows)
    .select('id, business_id');

  if (insertErr || !insertedCalls) {
    throw new Error(`runCallBatch insert calls: ${insertErr?.message ?? 'unknown'}`);
  }

  // Set total_businesses_to_call NOW — before we start dispatching. If
  // the process crashes mid-dispatch, apply_call_end still has the
  // correct denominator to flip the request into 'processing' once the
  // surviving calls (plus any retry-exhausted dispatch failures) catch
  // up. Counter-part: if we left this for the end of the function, a
  // mid-function crash would strand the request with planned=0 and the
  // status flip could never fire.
  const { error: plannedErr } = await admin
    .from('quote_requests')
    .update({ total_businesses_to_call: businesses.length })
    .eq('id', claimed.id);
  if (plannedErr) {
    notes.push(`total_businesses_to_call update failed: ${plannedErr.message}`);
  }

  // 4. Kick Vapi for each. We dispatch sequentially for simplicity;
  //    Phase 7 parallelizes with a concurrency cap. Vapi bills per
  //    concurrent call anyway so batching ~5 sequentially is fine.
  let dispatched = 0;
  let failed = 0;
  let simulatedCount = 0;

  const variableValues = buildVariableValues(claimed);

  for (let i = 0; i < insertedCalls.length; i += 1) {
    const callRow = insertedCalls[i];
    const business = businesses.find((b) => b.id === callRow.business_id);
    if (!business) continue;

    const dispatch = await startOutboundCall({
      toPhone: business.phone,
      businessName: business.name,
      variableValues,
      metadata: {
        quote_request_id: claimed.id,
        call_id: callRow.id,
        business_id: business.id,
      },
    });

    if (dispatch.ok) {
      if (dispatch.simulated) simulatedCount += 1;

      const { error: updateErr } = await admin
        .from('calls')
        .update({
          vapi_call_id: dispatch.vapiCallId,
          status: 'in_progress',
          started_at: new Date().toISOString(),
        })
        .eq('id', callRow.id);

      if (updateErr) {
        notes.push(`call ${callRow.id}: dispatched but failed to persist vapi_call_id: ${updateErr.message}`);
        failed += 1;
      } else {
        dispatched += 1;
      }

      // Bump last_called_at on the business even in simulation so our
      // selector doesn't keep picking the same few records in dev.
      await admin
        .from('businesses')
        .update({ last_called_at: new Date().toISOString() })
        .eq('id', business.id);
    } else {
      notes.push(`call ${callRow.id}: ${dispatch.error}`);
      failed += 1;
      await admin
        .from('calls')
        .update({ status: 'failed' })
        .eq('id', callRow.id);
    }
  }

  // 5. Update the batch counters on quote_requests.
  await admin
    .from('quote_requests')
    .update({
      total_businesses_to_call: businesses.length,
      total_calls_made: dispatched,
    })
    .eq('id', claimed.id);

  return {
    ok: true,
    quoteRequestId,
    selected: businesses.length,
    dispatched,
    failed,
    simulated: simulatedCount > 0 && dispatched === simulatedCount,
    notes,
  };
}

/**
 * Flatten quote_request + intake_data into the `{{variables}}` the Vapi
 * assistant prompt expects. Generic across categories — whatever keys
 * the intake form stored, we pass them through. Assistant prompts for
 * each category reference their own keys via call_script_template.
 *
 * Privacy guardrails (enforced here regardless of category):
 *   - Strip contact_phone, contact_email. The AI is the caller — the
 *     business gets contact_name and city only. Phase 8 adds an
 *     opt-in callback handoff.
 *   - Strip full street addresses. City/state/zip is enough to quote.
 */
const BUSINESS_REACHABLE_KEYS = new Set<string>([
  'contact_phone',
  'contact_email',
  'origin_address',
  'destination_address',
  'address', // single-address verticals (cleaning, handyman, lawn-care)
]);

function buildVariableValues(qr: QuoteRequestRow): Record<string, string | number | null | undefined> {
  const d = (qr.intake_data ?? {}) as Record<string, unknown>;
  const out: Record<string, string | number | null | undefined> = {};

  for (const [k, v] of Object.entries(d)) {
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
