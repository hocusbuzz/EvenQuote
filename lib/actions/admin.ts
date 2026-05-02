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
import { getStripe } from '@/lib/stripe/server';
import { sendEmail } from '@/lib/email/resend';
import {
  renderQuoteReport,
  type QuoteForReport,
  type RefundOutcome,
} from '@/lib/email/templates';
import {
  resolveRecipient,
  buildCoverageSummary,
  buildDashboardUrl,
} from '@/lib/cron/send-reports';
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
  | 'rerunExtractorFailed'
  | 'refundLookupFailed'
  | 'refundCreateFailed'
  | 'refundStatusUpdateFailed'
  | 'markFailedUpdateFailed'
  | 'resendLookupFailed'
  | 'resendQuotesLoadFailed'
  | 'resendSendFailed';

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

// ─────────────────────────────────────────────────────────────────────
// One-click ops actions (Tier 1 backlog #2)
//
// Three operator buttons on /admin/requests/[id] for cutting customer-
// failure recovery time from "20 min of SQL + cron-tick waiting" down
// to "1 min of clicking." Each is idempotent so a double-click can't
// double-act on Stripe / status / email.
// ─────────────────────────────────────────────────────────────────────

/**
 * Refund this request's $9.99 payment immediately, regardless of its
 * status. Useful when:
 *   • Customer asked for a refund directly (pre-empting the cron path).
 *   • The request is parked in 'paid' or 'calling' with no quotes
 *     coming and ops decides to escape the customer rather than wait
 *     for send-reports' refund logic to catch up.
 *   • A test request needs to be refunded by hand.
 *
 * Idempotent on Stripe's side via the same `refund-zero-quotes-<paymentId>`
 * key the cron uses — if a refund was already issued by either path,
 * Stripe returns the existing refund instead of creating a duplicate.
 * Same key means the cron and the admin button cooperate cleanly.
 *
 * Side effects:
 *   • payments.status := 'refunded'
 *   • quote_requests.report_data.refund_outcome := 'issued' (merged
 *     into existing report_data so prior fields stay)
 *   • Sentry capture on Stripe / DB failure (with payment id tag).
 *
 * Does NOT change quote_requests.status or send any emails — the
 * caller decides whether to also markFailed() / resendReportEmail().
 */
export async function refundRequestNow(
  requestId: string
): Promise<AdminActionResult> {
  const adminUser = await requireAdmin();
  if (!requestId) return { ok: false, error: 'missing requestId' };

  const adminDb = createAdminClient();

  // 1. Look up the payments row.
  const { data: pay, error: payErr } = await adminDb
    .from('payments')
    .select('id, stripe_payment_intent_id, status')
    .eq('quote_request_id', requestId)
    .maybeSingle();

  if (payErr) {
    log.error('refundRequestNow: payments lookup failed', {
      requestId,
      err: payErr,
    });
    captureException(new Error('payments lookup failed'), {
      tags: {
        lib: 'admin',
        reason: 'refundLookupFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: payErr.message };
  }
  if (!pay) {
    return {
      ok: false,
      error: 'No payments row for this request — nothing to refund.',
    };
  }

  // Already refunded — idempotent return. Make the operator note
  // explicit so a double-click on the button reads as "yep, done."
  if (pay.status === 'refunded') {
    return { ok: true, note: 'Already refunded — no-op.' };
  }

  if (!pay.stripe_payment_intent_id) {
    return {
      ok: false,
      error:
        'Payments row is missing stripe_payment_intent_id — refund must be issued manually in the Stripe dashboard.',
    };
  }

  // 2. Issue refund. Same idempotency key shape as the cron path so
  // both routes converge on a single Stripe refund object.
  try {
    const stripe = getStripe();
    await stripe.refunds.create(
      {
        payment_intent: pay.stripe_payment_intent_id,
        reason: 'requested_by_customer',
        metadata: {
          quote_request_id: requestId,
          payment_row_id: pay.id,
          // Distinguishes admin-initiated from cron-initiated refunds
          // in Stripe metadata. Stripe preserves whichever metadata
          // came in with the FIRST create call (idempotency); a later
          // run with a different `source` is silently ignored. So if
          // the cron has already refunded, the metadata will say
          // 'cron/send-reports/zero-quotes' and that's correct — the
          // cron actually did the work.
          source: 'admin/refund-button',
          // Audit trail — the admin user id of who clicked the button.
          // Sentry tags don't carry actor (PII boundary), so this is
          // the only place actor lands in the system of record.
          actor_user_id: adminUser.id,
        },
      },
      {
        idempotencyKey: `refund-zero-quotes-${pay.id}`,
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('refundRequestNow: stripe.refunds.create failed', {
      requestId,
      paymentId: pay.id,
      err: msg,
    });
    captureException(err, {
      tags: {
        lib: 'admin',
        reason: 'refundCreateFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: `Stripe refund failed: ${msg}` };
  }

  // 3. Mark payments row. Failure here is a book-keeping issue (Stripe
  // has the money back, our DB doesn't reflect it). Capture so ops can
  // reconcile, but don't return error — the customer-facing outcome
  // (the refund) IS done.
  const { error: updErr } = await adminDb
    .from('payments')
    .update({ status: 'refunded' })
    .eq('id', pay.id);
  if (updErr) {
    log.error('refundRequestNow: payments status update failed AFTER refund', {
      requestId,
      paymentId: pay.id,
      err: updErr,
    });
    captureException(new Error(updErr.message), {
      tags: {
        lib: 'admin',
        reason: 'refundStatusUpdateFailed' satisfies AdminReason,
        requestId,
      },
    });
    // Still report success — refund happened.
  }

  // 4. Stamp report_data.refund_outcome so anyone reading the request
  // later sees the refund recorded. Merge into existing report_data
  // (don't clobber generated_at, payload_snapshot, etc.).
  const { data: qr } = await adminDb
    .from('quote_requests')
    .select('report_data')
    .eq('id', requestId)
    .maybeSingle();
  const existing =
    (qr?.report_data as Record<string, unknown> | null | undefined) ?? {};
  await adminDb
    .from('quote_requests')
    .update({
      report_data: {
        ...existing,
        refund_outcome: 'issued' satisfies RefundOutcome,
        refund_issued_by_admin_at: new Date().toISOString(),
      },
    })
    .eq('id', requestId);

  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath('/admin');

  return {
    ok: true,
    note: `Refund issued for $${pay.id ? '9.99' : '?'} (payment ${pay.id.slice(0, 8)}…).`,
  };
}

/**
 * Force a request to status='failed'. Used when a request is hung
 * mid-pipeline and needs to be handed off to send-reports' refund-and-
 * notify path. The cron's filter (`status in ('processing','completed')`)
 * doesn't pick up 'failed' rows, so the operator should usually pair
 * this with refundRequestNow() — markFailed alone just changes a label.
 *
 * Idempotent — flipping an already-'failed' row to 'failed' is a no-op
 * insert/update with the same value.
 */
export async function markFailed(
  requestId: string
): Promise<AdminActionResult> {
  await requireAdmin();
  if (!requestId) return { ok: false, error: 'missing requestId' };

  const adminDb = createAdminClient();
  const { data, error } = await adminDb
    .from('quote_requests')
    .update({ status: 'failed' })
    .eq('id', requestId)
    .select('id, status')
    .maybeSingle();

  if (error) {
    log.error('markFailed: update failed', { requestId, err: error });
    captureException(new Error(error.message), {
      tags: {
        lib: 'admin',
        reason: 'markFailedUpdateFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: error.message };
  }
  if (!data) {
    return { ok: false, error: 'No quote_request matched that id.' };
  }

  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath('/admin');
  revalidatePath('/admin/requests');

  return { ok: true, note: `Status flipped to 'failed'.` };
}

/**
 * Re-render the quote report email from CURRENT DB state and send it
 * again. Used when a customer says they didn't get the original email
 * (spam folder, deleted, lost).
 *
 * Why "from current DB state" not "from saved report_data": if the
 * operator has since clicked rerun-extractor and new quotes landed,
 * those should be in the resent email. The whole point of resending
 * is to give the customer the latest.
 *
 * Side effects:
 *   • Sends an email via Resend (one extra send to your provider quota).
 *   • Stamps quote_requests.report_data.last_resent_at so we have a
 *     trail of how often this fired.
 *   • Does NOT touch report_sent_at, status, or anything else in row
 *     state — admin-initiated resend is purely additive.
 *
 * Idempotency note: this DOES send each time it's clicked. Click 5
 * times → 5 emails. The button has a confirm dialog as the human
 * guard. We deliberately don't dedupe in the action itself because
 * "send another copy" IS the operator's intent.
 */
export async function resendReportEmail(
  requestId: string
): Promise<AdminActionResult> {
  await requireAdmin();
  if (!requestId) return { ok: false, error: 'missing requestId' };

  const adminDb = createAdminClient();

  // 1. Pull the request + category in one round-trip (mirror what the
  // cron's scan query selects).
  const { data: row, error: lookupErr } = await adminDb
    .from('quote_requests')
    .select(
      `id, user_id, city, state, intake_data, report_data,
       total_businesses_to_call, total_calls_completed, total_quotes_collected,
       service_categories:category_id ( name, slug )`
    )
    .eq('id', requestId)
    .maybeSingle();

  if (lookupErr) {
    log.error('resendReportEmail: request lookup failed', {
      requestId,
      err: lookupErr,
    });
    captureException(new Error(lookupErr.message), {
      tags: {
        lib: 'admin',
        reason: 'resendLookupFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: lookupErr.message };
  }
  if (!row) {
    return { ok: false, error: 'No quote_request matched that id.' };
  }

  const sc = Array.isArray(row.service_categories)
    ? row.service_categories[0]
    : row.service_categories;

  // 2. Resolve recipient. resolveRecipient handles user_id → profile
  // OR intake.contact_email fallback.
  const recipient = await resolveRecipient(adminDb, {
    userId: row.user_id,
    intakeData: row.intake_data as Record<string, unknown> | null,
  });
  if (!recipient) {
    return {
      ok: false,
      error: 'No recipient email available (no profile email, no intake.contact_email).',
    };
  }

  // 3. Pull quotes — same select as send-reports, kept in lockstep.
  const { data: quoteRows, error: qErr } = await adminDb
    .from('quotes')
    .select(
      `id, business_id, price_min, price_max, price_description, availability,
       includes, excludes, notes, requires_onsite_estimate,
       business:businesses!quotes_business_id_fkey(name)`
    )
    .eq('quote_request_id', requestId)
    .order('price_min', { ascending: true, nullsFirst: false });

  if (qErr) {
    log.error('resendReportEmail: quotes load failed', { requestId, err: qErr });
    captureException(new Error(qErr.message), {
      tags: {
        lib: 'admin',
        reason: 'resendQuotesLoadFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: qErr.message };
  }

  const quotes: QuoteForReport[] = (quoteRows ?? []).map((q) => {
    const bizRaw = (q as { business?: unknown }).business;
    const business = Array.isArray(bizRaw) ? bizRaw[0] : bizRaw;
    return {
      businessName: (business as { name?: string } | null)?.name ?? 'Local pro',
      priceMin: q.price_min,
      priceMax: q.price_max,
      priceDescription: q.price_description,
      availability: q.availability,
      includes: q.includes,
      excludes: q.excludes,
      notes: q.notes,
      requiresOnsiteEstimate: q.requires_onsite_estimate,
    };
  });

  // 4. Reuse the prior refund_outcome from saved report_data. If the
  // original send was zero-quotes-with-refund, the resend should
  // continue saying "refund issued" — not silently flip to "your
  // quotes are ready" because a quote landed via rerun-extractor
  // after the refund. Falling back to 'not_applicable' if absent.
  const reportData =
    (row.report_data as Record<string, unknown> | null | undefined) ?? {};
  const priorRefund = reportData['refund_outcome'];
  const refundOutcome: RefundOutcome =
    priorRefund === 'issued' || priorRefund === 'pending_support'
      ? priorRefund
      : 'not_applicable';

  const rendered = renderQuoteReport({
    recipientName: recipient.name,
    categoryName: sc?.name ?? 'service',
    city: row.city,
    state: row.state,
    coverageSummary: buildCoverageSummary({
      totalCallsCompleted: row.total_calls_completed,
      totalBusinessesToCall: row.total_businesses_to_call,
      totalQuotesCollected: row.total_quotes_collected,
    }),
    dashboardUrl: buildDashboardUrl(row.id),
    refundOutcome,
    quotes,
  });

  // 5. Send. Tag distinguishes resends from cron-original sends in
  // Resend's analytics.
  const send = await sendEmail({
    to: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'quote-report-resend',
  });
  if (!send.ok) {
    log.error('resendReportEmail: send failed', { requestId, err: send.error });
    captureException(new Error(send.error), {
      tags: {
        lib: 'admin',
        reason: 'resendSendFailed' satisfies AdminReason,
        requestId,
      },
    });
    return { ok: false, error: `Email send failed: ${send.error}` };
  }

  // 6. Stamp last_resent_at so the row carries the audit. Best-effort —
  // the email already went out so we don't fail the action on this.
  await adminDb
    .from('quote_requests')
    .update({
      report_data: {
        ...reportData,
        last_resent_at: new Date().toISOString(),
      },
    })
    .eq('id', requestId);

  revalidatePath(`/admin/requests/${requestId}`);

  return {
    ok: true,
    note: `Sent to ${recipient.email} (${quotes.length} quote${quotes.length === 1 ? '' : 's'}).`,
  };
}
