// Admin server actions. Every export here is gated by requireAdmin()
// at the top of the function — these are called from forms on the
// admin pages. Since each action does a permission check AND the
// admin pages themselves are gated in middleware + requireAdmin() at
// render time, unauthorized users can't even reach a form that
// submits to these.

'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { runAdditionalBatch } from '@/lib/calls/engine';
import { extractQuoteFromCall } from '@/lib/calls/extract-quote';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('actions/admin');

// ── Canonical Sentry tag shape for this lib ──
// Shape matches the R19 post-payment.ts / R26 extract-quote.ts / R28
// checkout.ts pattern: `{ lib, reason, requestId? }`. Any new reason
// must be added to this union AND to the regression-guard in
// admin.test.ts that forbids catch-alls.
//
// DO NOT tag `archived` (boolean is fine but low signal value),
// the admin user id (PII), or the raw Supabase error message (may
// contain row-level details that slip past the logger's redactor —
// the Sentry tag boundary is our PII boundary, not just observational).
export type AdminReason =
  | 'archiveUpdateFailed'
  | 'bulkArchiveFailed'
  | 'retryUnreachedFailed'
  | 'rerunExtractorFailed';

export type AdminActionResult =
  | { ok: true; note?: string }
  | { ok: false; error: string };

/**
 * Soft-archive or unarchive a quote_request. Stamps archived_at=now()
 * or clears it. Re-renders the request detail + admin list pages
 * via revalidatePath so the change is reflected immediately.
 */
export async function setRequestArchived(
  requestId: string,
  archived: boolean
): Promise<AdminActionResult> {
  await requireAdmin();
  if (!requestId) return { ok: false, error: 'missing requestId' };

  const admin = createAdminClient();
  const { error } = await admin
    .from('quote_requests')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', requestId);

  if (error) {
    // Pre-R32 this was log-only. Admin-only surface, so blast radius is
    // bounded — but a silent RLS regression or permission-denied here
    // leaves operators staring at a toast with zero Sentry visibility.
    // Wrap before capture so Sentry fingerprints on a message we
    // control (Supabase error strings include column/relation names
    // that look like PII to Sentry's scrubber).
    log.error('setRequestArchived failed', { err: error, requestId, archived });
    const wrapped = new Error('quote_requests.update(archived_at) failed');
    captureException(wrapped, {
      tags: {
        lib: 'admin',
        reason: 'archiveUpdateFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: error.message };
  }

  // Refresh the pages that surface this row.
  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath('/admin/requests');
  revalidatePath('/admin');

  return {
    ok: true,
    note: archived ? 'Request archived.' : 'Request unarchived.',
  };
}


/**
 * Bulk archive (or unarchive) — flip archived_at on many requests at
 * once. Hard-capped at 200 rows per call so a runaway click can't
 * accidentally archive the whole table. The cap also protects the
 * Supabase REST endpoint from a long-payload edge case.
 *
 * R47.2: surfaced by the new admin requests-list checkbox UI. The
 * single-row setRequestArchived path stays — this is purely the
 * batched variant for the bulk-action bar.
 */
export async function bulkArchive(
  requestIds: string[],
  archived: boolean
): Promise<AdminActionResult> {
  await requireAdmin();
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    return { ok: false, error: 'no requestIds passed' };
  }
  if (requestIds.length > 200) {
    return { ok: false, error: 'too many ids (cap is 200)' };
  }

  const adminDb = createAdminClient();
  const { error, count } = await adminDb
    .from('quote_requests')
    .update(
      { archived_at: archived ? new Date().toISOString() : null },
      { count: 'exact' }
    )
    .in('id', requestIds);

  if (error) {
    log.error('bulkArchive failed', {
      err: error,
      n: requestIds.length,
      archived,
    });
    const wrapped = new Error('quote_requests.update(bulk archived_at) failed');
    captureException(wrapped, {
      tags: {
        lib: 'admin',
        reason: 'bulkArchiveFailed' satisfies AdminReason,
      },
    });
    return { ok: false, error: error.message };
  }

  revalidatePath('/admin/requests');
  revalidatePath('/admin');

  return {
    ok: true,
    note: `${count ?? requestIds.length} request(s) ${archived ? 'archived' : 'unarchived'}.`,
  };
}


/**
 * Retry unreached — dispatch a small batch of NEW calls to businesses
 * we haven't dialed yet on this request. Useful when the original
 * batch had too many voicemails / refusals and the customer needs
 * more coverage.
 *
 * Bounded: caps at 5 new calls per click (even if the user passes a
 * higher value) — prevents a double-click from burning 20 calls of
 * spend. The underlying runAdditionalBatch also caps at 10.
 */
export async function retryUnreachedBusinesses(
  requestId: string
): Promise<AdminActionResult> {
  await requireAdmin();
  if (!requestId) return { ok: false, error: 'missing requestId' };

  try {
    const result = await runAdditionalBatch({ quoteRequestId: requestId, limit: 5 });
    if (!result.ok) {
      return {
        ok: false,
        error: result.notes[0] ?? 'additional batch failed',
      };
    }

    revalidatePath(`/admin/requests/${requestId}`);
    revalidatePath('/admin');

    const note =
      result.selected === 0
        ? 'No new businesses available in coverage area.'
        : `Dispatched ${result.dispatched} new call(s) (${result.failed} failed, ${result.selected} selected).`;
    return { ok: true, note };
  } catch (err) {
    log.error('retryUnreachedBusinesses failed', { err, requestId });
    const wrapped = new Error('runAdditionalBatch threw');
    captureException(wrapped, {
      tags: { lib: 'admin', reason: 'retryUnreachedFailed', requestId },
    });
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Re-run the quote extractor against every completed call on a
 * request that doesn't already have a quotes row. Useful when:
 *   • The first extraction returned ok:false because of a
 *     prompt/schema issue we've since fixed.
 *   • ANTHROPIC_API_KEY was unset during the original run.
 *   • A transcript happens to extract better with a tweaked prompt
 *     in service_categories.extraction_schema.
 *
 * Idempotent on the quotes.call_id unique index — double-clicking
 * the button cannot duplicate quote rows. The underlying extractor
 * is also stateless, so a re-run is just paying for another
 * Anthropic call's worth of cost (~cents per call).
 *
 * Does NOT bump quote_requests counters or flip status — those
 * already advanced when the original webhook landed. The only DB
 * change here is new rows in `quotes`.
 */
export async function rerunExtractor(
  requestId: string
): Promise<AdminActionResult> {
  await requireAdmin();
  if (!requestId) return { ok: false, error: 'missing requestId' };

  const adminDb = createAdminClient();

  // 1. Find every completed call WITHOUT a quote row. Left-join via a
  //    NOT IN subquery — small N (≤ batch size), no perf concern.
  const { data: completedCalls, error: callsErr } = await adminDb
    .from('calls')
    .select(
      `id, quote_request_id, business_id, status, transcript, summary, extracted_data,
       quote_request:quote_request_id(category_id,
         service_categories:category_id(name, slug, extraction_schema))`
    )
    .eq('quote_request_id', requestId)
    .eq('status', 'completed');

  if (callsErr) {
    log.error('rerunExtractor calls lookup failed', { err: callsErr, requestId });
    captureException(new Error(`rerunExtractor lookup: ${callsErr.message}`), {
      tags: { lib: 'admin', reason: 'rerunExtractorFailed', requestId },
    });
    return { ok: false, error: callsErr.message };
  }

  // 2. Filter out calls that already have a quote.
  const callIds = (completedCalls ?? []).map((c) => c.id);
  if (callIds.length === 0) {
    return { ok: true, note: 'No completed calls on this request.' };
  }

  const { data: existingQuotes } = await adminDb
    .from('quotes')
    .select('call_id')
    .in('call_id', callIds);
  const haveQuote = new Set((existingQuotes ?? []).map((q) => q.call_id));
  const candidates = (completedCalls ?? []).filter((c) => !haveQuote.has(c.id));

  if (candidates.length === 0) {
    return {
      ok: true,
      note: `All ${callIds.length} completed call(s) already have quotes.`,
    };
  }

  // 3. Re-run the extractor against each candidate. Sequential (not
  //    parallel) so we don't burst Anthropic's rate limit on a noisy
  //    request, and so the per-call log lines stay readable in order.
  let landed = 0;
  let stillFailed = 0;
  const reasons: string[] = [];

  for (const c of candidates) {
    const qrJoin = (c as { quote_request?: unknown }).quote_request;
    const qr = Array.isArray(qrJoin) ? qrJoin[0] : qrJoin;
    const scJoin = (qr as { service_categories?: unknown } | null | undefined)
      ?.service_categories;
    const sc = Array.isArray(scJoin) ? scJoin[0] : scJoin;

    const extraction = await extractQuoteFromCall({
      transcript: c.transcript,
      summary: c.summary,
      vapiAnalysis: { structuredData: c.extracted_data },
      categoryContext: sc
        ? {
            displayName:
              (sc as { name?: string; slug?: string }).name ??
              (sc as { slug?: string }).slug ??
              'service',
            extractionSchema: (sc as { extraction_schema?: unknown })
              .extraction_schema as never,
          }
        : undefined,
    });

    if (!extraction.ok) {
      stillFailed += 1;
      reasons.push(`${c.id.slice(0, 8)}: ${extraction.reason}`);
      continue;
    }

    const { error: insertErr } = await adminDb.from('quotes').insert({
      call_id: c.id,
      quote_request_id: c.quote_request_id,
      business_id: c.business_id,
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

    if (insertErr) {
      // 23505 = unique violation on call_id. Belt-and-braces — we
      // already filtered out call_ids with quotes, but a concurrent
      // webhook redelivery could race us here.
      if ((insertErr as { code?: string }).code === '23505') {
        // Treat as already-landed — count it.
        landed += 1;
        continue;
      }
      log.error('rerunExtractor insert failed', {
        err: insertErr,
        callId: c.id,
        requestId,
      });
      captureException(new Error(`rerunExtractor insert: ${insertErr.message}`), {
        tags: {
          lib: 'admin',
          reason: 'rerunExtractorFailed',
          requestId,
        },
      });
      stillFailed += 1;
      continue;
    }
    landed += 1;

    // Bump total_quotes_collected so the dashboard counter reflects
    // reality. The webhook path uses apply_call_end RPC which both
    // bumps counters and stamps an idempotency sentinel on the call
    // row — but that RPC is gated on counters_applied_at IS NULL, so
    // calling it here for an already-stamped call is a no-op. We do
    // a simple atomic increment instead.
    const { error: bumpErr } = await adminDb.rpc('increment_quotes_collected', {
      p_request_id: requestId,
    });
    if (bumpErr) {
      log.warn('rerunExtractor counter bump failed (non-fatal)', {
        err: bumpErr,
        requestId,
      });
    }
  }

  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath(`/dashboard/requests/${requestId}`);

  const noteParts: string[] = [];
  noteParts.push(
    `${landed} new quote(s) extracted from ${candidates.length} candidate call(s).`
  );
  if (stillFailed > 0) {
    noteParts.push(`${stillFailed} still failed.`);
    // Surface the first reason so prompt-tuners have something concrete
    // to look at without grepping the log stream.
    if (reasons[0]) noteParts.push(`First reason: ${reasons[0]}`);
  }
  return { ok: true, note: noteParts.join(' ') };
}
