// Call engine — turns a paid quote_request into a batch of queued calls.
//
// Called from the Stripe webhook via lib/queue/enqueue-calls.ts. This
// module does the actual work: select businesses, insert calls rows,
// dispatch via Vapi. The webhook idempotency gate (status='paid' AND
// vapi_batch_started_at IS NULL) ensures this runs at most once per
// request even under Stripe retries.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCallBatchSize } from '@/lib/env';
import { selectBusinessesForRequest } from './select-businesses';
import { startOutboundCall } from './vapi';
import { captureException } from '@/lib/observability/sentry';

// How many businesses we try to call per quote request. Configurable
// via env so we can tune without a code change. Default of 5 is
// conservative — most metro moves have plenty of coverage at 5.
// See lib/env.ts for bounds enforcement.

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
  // Captured from Google Place Details when the user picked a
  // prediction at form time. Optional — manual ("use custom")
  // entries lack coords and the radius selector falls back to
  // its in-zip-anchor centroid in that case.
  origin_lat: number | null;
  origin_lng: number | null;
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
  // Use the validated helper so an invalid env var can't silently produce
  // NaN (which compares false in all arithmetic checks downstream).
  const batchSize = getCallBatchSize();

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
    .select('id, category_id, city, state, zip_code, intake_data, vapi_batch_started_at, origin_lat, origin_lng')
    .maybeSingle<QuoteRequestRow>();

  if (claimErr) {
    // Lib-boundary capture. Today the only caller is the stripe webhook,
    // which has its own route-level captureException — Sentry dedupes
    // on stack-trace fingerprint so this doesn't double-count, but it
    // does add a `lib:'enqueue'` tag facet that ops can alert on
    // independently of which route surfaced the error. Future callers
    // (admin retry script, support reprocess button) inherit this for
    // free without copy-pasting the wrap.
    //
    // Tag label `lib: 'enqueue'` reflects the user-facing operation
    // boundary the webhook calls into; `engine` is the implementation
    // detail. Keep `enqueue` so dashboards stay stable if engine.ts
    // ever splits into smaller modules.
    const wrapped = new Error(`runCallBatch claim: ${claimErr.message}`);
    captureException(wrapped, {
      tags: { lib: 'enqueue', reason: 'claimFailed', quoteRequestId },
    });
    throw wrapped;
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
  //    Pass the request's origin coords (when present) so the radius
  //    tier anchors on the actual customer address rather than a
  //    sampled in-zip business — see fetchRadius() in select-businesses.
  const businesses = await selectBusinessesForRequest(admin, {
    categoryId: claimed.category_id,
    zipCode: claimed.zip_code,
    state: claimed.state,
    limit: batchSize,
    originLat: claimed.origin_lat,
    originLng: claimed.origin_lng,
  });

  const notes: string[] = [];
  if (businesses.length === 0) {
    notes.push(`no businesses matched category ${claimed.category_id} in ${claimed.state} / ${claimed.zip_code}`);
    // We flipped to 'calling' already — roll back to 'failed' so ops
    // can see that this request needs attention (coverage gap).
    //
    // Pre-R28 this update had no error check. If it silently failed
    // (RLS drift, table rename, DB outage between claim+fallback), the
    // quote_request would be STRANDED in status='calling' with zero
    // businesses ever dispatched:
    //   • The retry-failed-calls cron only picks up rows with failed
    //     CALLS — there are none, so it's a no-op here.
    //   • send-reports never fires because the row isn't in 'processing'.
    //   • The customer paid $9.99 and nothing ever happens.
    // Medium-low probability (requires double DB failure: claim OK,
    // fallback fail) but high blast radius. Capture mandatory.
    const { error: fallbackErr } = await admin
      .from('quote_requests')
      .update({ status: 'failed' })
      .eq('id', claimed.id);
    if (fallbackErr) {
      const wrapped = new Error(
        `runCallBatch no-businesses fallback: ${fallbackErr.message}`
      );
      captureException(wrapped, {
        tags: {
          lib: 'enqueue',
          reason: 'noBusinessesFallbackFailed',
          quoteRequestId,
        },
      });
    }
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
    // Bulk-insert failure: usually a constraint violation or a Supabase
    // outage. The batch is mid-flight at this point — quote_request was
    // already flipped to 'calling' by the claim — so a silent failure
    // here strands the request in 'calling' forever. Capture at the lib
    // boundary so this never happens without an alert.
    const wrapped = new Error(
      `runCallBatch insert calls: ${insertErr?.message ?? 'unknown'}`
    );
    captureException(wrapped, {
      tags: { lib: 'enqueue', reason: 'insertFailed', quoteRequestId },
    });
    throw wrapped;
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
    // This counter is the denominator apply-end-of-call uses to flip
    // the request into 'processing' / 'complete'. A silent failure
    // here strands the request in 'calling' FOREVER once the last
    // dispatched call completes — the status-flip code reads NULL
    // and short-circuits. Capture so ops sees it even though we
    // continue the batch (the dispatched calls themselves still
    // have a chance to land).
    const wrapped = new Error(
      `runCallBatch planned-count update: ${plannedErr.message}`
    );
    captureException(wrapped, {
      tags: {
        lib: 'enqueue',
        reason: 'plannedCountUpdateFailed',
        quoteRequestId,
      },
    });
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

      // Persist the vapi_call_id correlation key. This MUST succeed
      // for the end-of-call webhook to find the row again — without
      // it, the contractor's call rings, they may pick up, and we
      // silently drop the transcript + quote.
      //
      // R47.4: retry once with a small backoff before giving up. Most
      // transient failures (Supabase connection blip, brief rate
      // limit) resolve within ~250ms. If the second attempt also
      // fails, mark the row `status='failed'` explicitly so:
      //   1. The retry-failed-calls cron picks it up later (it
      //      filters on status='failed' AND started_at IS NULL —
      //      we leave started_at unset by NOT writing it on the
      //      failure path).
      //   2. The total_calls_completed counter math doesn't stall
      //      waiting for an end-of-call event that can't fire.
      // Whatever the contractor heard during that one ringing call
      // is a sunk cost — we don't re-dial because the row is now
      // status='failed' and the retry cron's started_at IS NULL
      // gate keeps us from double-dispatching.
      const updatePayload = {
        vapi_call_id: dispatch.vapiCallId,
        status: 'in_progress' as const,
        started_at: new Date().toISOString(),
      };
      const tryUpdate = () =>
        admin.from('calls').update(updatePayload).eq('id', callRow.id);

      let updateErr = (await tryUpdate()).error;
      if (updateErr) {
        // Quick backoff before second attempt.
        await new Promise((r) => setTimeout(r, 250));
        updateErr = (await tryUpdate()).error;
      }

      if (updateErr) {
        notes.push(
          `call ${callRow.id}: dispatched but failed to persist vapi_call_id (after retry): ${updateErr.message}`
        );
        failed += 1;
        // R47.4b: lock the row out of retry candidacy.
        //
        // The retry cron's candidate filter is:
        //   status='failed' AND started_at IS NULL AND retry_count < 1
        // An earlier version of this code wrote ONLY status='failed'
        // and intentionally left started_at null — reasoning that a
        // single follow-up dial was cheaper than orphaning. That
        // reasoning was wrong: the original Vapi call WAS accepted
        // and IS still ringing the contractor at this moment. A
        // retry would dial the same business a second time while
        // the first call is mid-flight. Codex caught this on
        // re-review.
        //
        // Fix: stamp BOTH started_at AND retry_count=1, so each of
        // the retry filter's three predicates excludes this row
        // (status remains 'failed' but the other two predicates fail
        // independently). The row surfaces in the admin failed-calls
        // view for manual reconcile. The captureException below
        // pages ops; recovery is "look up the Vapi call id from
        // their dashboard via the call's metadata.call_id we sent
        // them, then patch it onto the row by hand or via
        // /api/dev/backfill-call".
        const { error: failMarkErr } = await admin
          .from('calls')
          .update({
            status: 'failed',
            // Honest: the call DID start (Vapi accepted it).
            started_at: new Date().toISOString(),
            // Lock out of retry candidacy.
            retry_count: 1,
          })
          .eq('id', callRow.id);
        if (failMarkErr) {
          notes.push(
            `call ${callRow.id}: also failed to mark orphan-recovery state: ${failMarkErr.message}`
          );
        }
        // Capture stays — orphaned-call risk is the worst silent
        // failure in the outbound path.
        const wrapped = new Error(
          `runCallBatch call-id persist (after retry): ${updateErr.message}`
        );
        captureException(wrapped, {
          tags: {
            lib: 'enqueue',
            reason: 'callIdPersistFailed',
            quoteRequestId,
            callId: callRow.id,
            businessId: business.id,
          },
        });
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

  // Also pass the top-level request location — these live on quote_requests
  // directly (not in intake_data), so the `for-in` above doesn't pick them
  // up. Prompt references {{city}}/{{state}}/{{zip_code}} as the service
  // area for non-moving verticals (cleaning/handyman/lawn-care).
  out.city = qr.city ?? null;
  out.state = qr.state ?? null;
  out.zip_code = qr.zip_code ?? null;

  return out;
}


// ══════════════════════════════════════════════════════════════════════
// runAdditionalBatch — admin "retry unreached" surface.
//
// Dispatches a fresh mini-batch of calls to NEW businesses on an
// already-running-or-done quote request. Meant for the admin request
// detail page when the first batch didn't yield enough quotes and the
// customer would benefit from calling additional contractors.
//
// Key differences from runCallBatch:
//   • No claim gate — doesn't touch quote_request.status or
//     vapi_batch_started_at. The request stays where it is; we're
//     layering more calls on top.
//   • Excludes every business_id already dialed on this request so
//     we never re-call the same business.
//   • Bumps total_businesses_to_call by the new-batch size so the
//     auto-advance-to-processing invariant still holds.
//   • No apply_call_end counter concern — the new calls go through
//     the same webhook path, so they bump counters normally when
//     they complete.
//
// Safe to call on any request in any status except 'pending_payment'.
// We intentionally allow it on 'completed' so ops can pull in a few
// more quotes for a customer who wasn't happy with the initial set.
// ══════════════════════════════════════════════════════════════════════

export type AdditionalBatchInput = {
  quoteRequestId: string;
  /** How many new businesses to try. Capped at batch-size default (10). */
  limit?: number;
};

export async function runAdditionalBatch(
  input: AdditionalBatchInput
): Promise<RunBatchResult> {
  const admin = createAdminClient();
  const quoteRequestId = input.quoteRequestId;
  const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
  const notes: string[] = [];

  // 1. Load the request. Must exist and be past pending_payment.
  const { data: request, error: reqErr } = await admin
    .from('quote_requests')
    .select('id, category_id, city, state, zip_code, intake_data, status, vapi_batch_started_at, total_businesses_to_call, origin_lat, origin_lng')
    .eq('id', quoteRequestId)
    .maybeSingle();
  if (reqErr || !request) {
    return {
      ok: false,
      quoteRequestId,
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: [`request lookup: ${reqErr?.message ?? 'not found'}`],
    };
  }
  if (request.status === 'pending_payment') {
    return {
      ok: false,
      quoteRequestId,
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: ['request is pending_payment; cannot add calls yet'],
    };
  }

  // 2. Find business_ids already dialed on this request so the
  //    selector doesn't re-dial them.
  const { data: existingCalls } = await admin
    .from('calls')
    .select('business_id')
    .eq('quote_request_id', quoteRequestId);
  const excludedBusinessIds = new Set(
    (existingCalls ?? []).map((c) => c.business_id)
  );

  // 3. Select NEW businesses. We fetch an overfetched batch from the
  //    selector then filter exclusions client-side. The selector
  //    doesn't natively support "exclude these ids" — adding that
  //    would mean a selector API change; filter-after is cheap at
  //    our scale.
  const overfetched = await selectBusinessesForRequest(admin, {
    categoryId: request.category_id,
    zipCode: request.zip_code,
    state: request.state,
    limit: limit + excludedBusinessIds.size + 5, // overfetch
    originLat: request.origin_lat ?? null,
    originLng: request.origin_lng ?? null,
  });
  const freshBusinesses = overfetched
    .filter((b) => !excludedBusinessIds.has(b.id))
    .slice(0, limit);

  if (freshBusinesses.length === 0) {
    return {
      ok: true,
      quoteRequestId,
      selected: 0,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: ['no new businesses available in coverage area'],
    };
  }

  // 4. Insert new calls rows.
  const callRows = freshBusinesses.map((b) => ({
    quote_request_id: quoteRequestId,
    business_id: b.id,
    status: 'queued' as const,
  }));
  const { data: insertedCalls, error: insertErr } = await admin
    .from('calls')
    .insert(callRows)
    .select('id, business_id');
  if (insertErr || !insertedCalls) {
    const wrapped = new Error(
      `runAdditionalBatch insert calls: ${insertErr?.message ?? 'unknown'}`
    );
    captureException(wrapped, {
      tags: { lib: 'enqueue', reason: 'additionalInsertFailed', quoteRequestId },
    });
    return {
      ok: false,
      quoteRequestId,
      selected: freshBusinesses.length,
      dispatched: 0,
      failed: 0,
      simulated: false,
      notes: [`insert: ${insertErr?.message ?? 'unknown'}`],
    };
  }

  // 5. Bump total_businesses_to_call. Preserve the status-advance
  //    invariant: apply_call_end compares completed vs this denominator,
  //    so if we don't bump, the request could flip to 'processing'
  //    before our new batch lands.
  const newPlanned = (request.total_businesses_to_call ?? 0) + freshBusinesses.length;
  await admin
    .from('quote_requests')
    .update({ total_businesses_to_call: newPlanned })
    .eq('id', quoteRequestId);

  // 6. Dispatch. Reuse the same pattern as runCallBatch.
  const variableValues = buildVariableValues(request as QuoteRequestRow);
  let dispatched = 0;
  let failed = 0;
  let simulatedCount = 0;

  for (const callRow of insertedCalls) {
    const business = freshBusinesses.find((b) => b.id === callRow.business_id);
    if (!business) continue;

    const dispatch = await startOutboundCall({
      toPhone: business.phone,
      businessName: business.name,
      variableValues,
      metadata: {
        quote_request_id: quoteRequestId,
        call_id: callRow.id,
        business_id: business.id,
        extra_batch: '1',
      },
    });

    if (dispatch.ok) {
      if (dispatch.simulated) simulatedCount += 1;

      // R47.5: mirror the hardened post-dispatch persistence path
      // from runCallBatch. Without this, a Vapi-accepted extra-batch
      // call whose row update fails is orphaned — the call is
      // ringing the contractor but our DB has no vapi_call_id, so
      // the end-of-call webhook can't reattach the transcript +
      // quote. One retry with backoff, then mark the row failed +
      // lock it out of the retry-cron candidate filter.
      const updatePayload = {
        vapi_call_id: dispatch.vapiCallId,
        status: 'in_progress' as const,
        started_at: new Date().toISOString(),
      };
      const tryUpdate = () =>
        admin.from('calls').update(updatePayload).eq('id', callRow.id);

      let updateErr = (await tryUpdate()).error;
      if (updateErr) {
        await new Promise((r) => setTimeout(r, 250));
        updateErr = (await tryUpdate()).error;
      }

      if (updateErr) {
        notes.push(
          `call ${callRow.id}: extra-batch dispatched but vapi_call_id persist failed (after retry): ${updateErr.message}`
        );
        failed += 1;
        // Same orphan-lockout pattern as runCallBatch: stamp
        // started_at + retry_count=1 so the retry-failed-calls
        // cron's candidate filter (status='failed' AND
        // started_at IS NULL AND retry_count < 1) excludes this
        // row on every predicate.
        const { error: failMarkErr } = await admin
          .from('calls')
          .update({
            status: 'failed',
            started_at: new Date().toISOString(),
            retry_count: 1,
          })
          .eq('id', callRow.id);
        if (failMarkErr) {
          notes.push(
            `call ${callRow.id}: also failed to mark orphan-recovery state: ${failMarkErr.message}`
          );
        }
        captureException(
          new Error(
            `runAdditionalBatch call-id persist (after retry): ${updateErr.message}`
          ),
          {
            tags: {
              lib: 'enqueue',
              reason: 'callIdPersistFailed',
              quoteRequestId,
              callId: callRow.id,
              businessId: business.id,
            },
          }
        );
      } else {
        await admin
          .from('businesses')
          .update({ last_called_at: new Date().toISOString() })
          .eq('id', business.id);
        dispatched += 1;
      }
    } else {
      notes.push(`call ${callRow.id}: ${dispatch.error}`);
      failed += 1;
      await admin.from('calls').update({ status: 'failed' }).eq('id', callRow.id);
    }
  }

  return {
    ok: true,
    quoteRequestId,
    selected: freshBusinesses.length,
    dispatched,
    failed,
    simulated: simulatedCount > 0 && dispatched === simulatedCount,
    notes,
  };
}
