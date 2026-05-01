// Report generator + email dispatcher.
//
// Pulled out of app/api/cron/send-reports/route.ts because Next.js 14's
// App Router only allows HTTP method exports (GET/POST/…) and a small
// allowlist of config consts (dynamic, runtime, preferredRegion, …)
// from a route.ts file. Any other export — like our testable
// `sendPendingReports` — fails the build with:
//
//   Type error: Route "…/route.ts" does not match the required types
//   of a Next.js Route. "sendPendingReports" is not a valid Route
//   export field.
//
// Keeping the handler here lets tests invoke the core logic without
// going through HTTP.
//
// Flow each run:
//   1. Find quote_requests with status IN ('processing', 'completed')
//      AND report_sent_at IS NULL. Phase 7's apply_call_end() flips
//      a request into 'processing' once total_calls_completed catches
//      the planned batch size — but in some flows (end-of-call webhook
//      shortcut, manual admin transitions) a request can move straight
//      from 'calling' → 'completed' without ever hitting 'processing'.
//      Such rows would be invisible to this cron forever, leaving
//      zero-quote requests un-refunded. Including 'completed' rows
//      (filtered to report_sent_at IS NULL so we never re-process
//      already-reported rows) catches both paths. (#110 fix)
//   2. For each request: load the quotes + join business names.
//   3. If zero quotes landed, automatically refund the $9.99 via
//      Stripe (idempotency key = `refund-zero-quotes-<paymentId>`,
//      so cron retries don't double-refund). The outcome flows into
//      the email template so copy matches reality — "we've refunded
//      your card" only when we actually did.
//   4. Render the report template, send via Resend.
//   5. On successful send: stamp report_generated_at, report_data
//      (including refund_outcome), report_sent_at, flip status
//      → 'completed'.
//   6. On failed send: leave status='processing' so the next run
//      retries. No retry counter here — Resend is reliable enough
//      that sustained failure is an ops issue worth surfacing via
//      logs rather than auto-burying.
//
// Recipient selection:
//   • If quote_request.user_id is set → profiles.email
//   • Else → intake_data.contact_email (guest flow, before claim)

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/resend';
import { trackServer } from '@/lib/analytics/track-server';
import type { AnalyticsEventParams } from '@/lib/analytics/events';
import {
  renderQuoteReport,
  type NoQuoteCause,
  type QuoteForReport,
  type QuoteReportInput,
  type RefundOutcome,
} from '@/lib/email/templates';
import { getStripe } from '@/lib/stripe/server';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/send-reports');

// ─────────────────────────────────────────────────────────────────────
// Canonical Sentry tag shape for this module:
//
//   { lib: 'cron-send-reports', reason: CronSendReportsReason, ... }
//
// Prior to R27 only the ROUTE handler captured (`{route:'cron/send-
// reports', reason:'runFailed'}`) and only on thrown exceptions from
// sendPendingReports itself. The per-request failures below (email
// send failed, final stamp failed, Stripe refund failed, payments
// lookup failed, refund book-keeping failed) do NOT throw — they
// return `{status:'failed', reason:...}` in the per-request detail,
// which never reaches the route's try/catch. That means production
// was silent on every one of these surfaces: a Resend outage dropping
// 50 reports would log but never page.
//
// The `reason` values are allow-listed and enforced by a regression-
// guard test in lib/cron/send-reports.test.ts. Do NOT add catch-alls
// like `sendReportsFailed` or `unknown` — each capture site must
// describe WHICH failure path it is.
// ─────────────────────────────────────────────────────────────────────
export type CronSendReportsReason =
  | 'sendFailedPostClaim'
  | 'outboxClaimFailed'
  | 'finalStampFailed'
  | 'refundLookupFailed'
  | 'refundCreateFailed'
  | 'refundStatusUpdateFailed';

// Keep a single invocation bounded — report rendering is cheap but
// we still want to fit inside a 60s serverless window with headroom.
const MAX_PER_RUN = 25;

type ProcessingRequest = {
  id: string;
  user_id: string | null;
  city: string;
  state: string;
  intake_data: Record<string, unknown> | null;
  total_businesses_to_call: number;
  total_calls_completed: number;
  total_quotes_collected: number;
  category: { name: string; slug: string } | null;
};

type QuoteRow = {
  id: string;
  business_id: string;
  price_min: number | null;
  price_max: number | null;
  price_description: string | null;
  availability: string | null;
  includes: string[] | null;
  excludes: string[] | null;
  notes: string | null;
  requires_onsite_estimate: boolean;
  business: { name: string } | null;
};

export type SendReportsResult = {
  ok: true;
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
  details: Array<{
    request_id: string;
    status: 'sent' | 'failed' | 'skipped';
    reason?: string;
    email_id?: string;
  }>;
};

/**
 * Exported so tests (or a one-off local script) can invoke the core
 * logic without going through HTTP.
 */
export async function sendPendingReports(
  admin: SupabaseClient
): Promise<SendReportsResult> {
  const result: SendReportsResult = {
    ok: true,
    scanned: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  const { data: rows, error } = await admin
    .from('quote_requests')
    .select(
      `
      id,
      user_id,
      city,
      state,
      intake_data,
      total_businesses_to_call,
      total_calls_completed,
      total_quotes_collected,
      category:service_categories!quote_requests_category_id_fkey(name, slug)
    `
    )
    // #110 fix: include 'completed' rows alongside 'processing' so we
    // pick up requests that transitioned straight from 'calling' →
    // 'completed' (which can happen via the end-of-call webhook flow)
    // without ever hitting 'processing'. Such rows would otherwise be
    // invisible to this cron forever — and if they have 0 quotes, the
    // customer never gets a refund. The `report_sent_at IS NULL` filter
    // below still prevents double-processing of rows we've already
    // reported on (or already refunded), so widening the status set
    // is safe.
    .in('status', ['processing', 'completed'])
    .is('report_sent_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    throw new Error(`quote_requests scan: ${error.message}`);
  }

  const requests: ProcessingRequest[] = (rows ?? []).map((r) => {
    const catRaw = (r as { category?: unknown }).category;
    const category = Array.isArray(catRaw) ? catRaw[0] : catRaw;
    return { ...r, category: category ?? null } as ProcessingRequest;
  });
  result.scanned = requests.length;

  for (const request of requests) {
    const outcome = await processOne(admin, request);
    if (outcome.status === 'sent') result.sent++;
    else if (outcome.status === 'failed') result.failed++;
    else result.skipped++;
    result.details.push({ request_id: request.id, ...outcome });
  }

  return result;
}

// ─── per-request pipeline ───────────────────────────────────────────

async function processOne(
  admin: SupabaseClient,
  request: ProcessingRequest
): Promise<
  | { status: 'sent'; email_id: string }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string }
> {
  // 1. Resolve recipient email. Prefer the authed user's profile, fall
  // back to whatever the guest entered at intake.
  const recipient = await resolveRecipient(admin, request);
  if (!recipient) {
    return { status: 'skipped', reason: 'no recipient email' };
  }

  // 2. Load quotes for this request.
  const { data: qRows, error: qErr } = await admin
    .from('quotes')
    .select(
      `
      id,
      business_id,
      price_min,
      price_max,
      price_description,
      availability,
      includes,
      excludes,
      notes,
      requires_onsite_estimate,
      business:businesses!quotes_business_id_fkey(name)
    `
    )
    .eq('quote_request_id', request.id)
    .order('price_min', { ascending: true, nullsFirst: false });

  if (qErr) {
    return { status: 'failed', reason: `quotes load: ${qErr.message}` };
  }

  const quotes: QuoteRow[] = (qRows ?? []).map((q) => {
    const bizRaw = (q as { business?: unknown }).business;
    const business = Array.isArray(bizRaw) ? bizRaw[0] : bizRaw;
    return { ...q, business: business ?? null } as QuoteRow;
  });

  // 3. If we collected zero quotes, refund the customer BEFORE composing
  // the email — so we only promise a refund that actually happened. If
  // Stripe fails, the template falls back to a "reply to this email" ask.
  // If quotes exist, skip refund entirely.
  const refundOutcome: RefundOutcome =
    quotes.length === 0
      ? await refundForZeroQuotes(admin, request.id)
      : 'not_applicable';

  // 4. Compose the email.
  const categoryName = request.category?.name ?? 'service';
  const coverageSummary = buildCoverageSummary(request);
  const dashboardUrl = buildDashboardUrl(request.id);

  // R47.6: distinguish "no businesses ever called" (coverage gap)
  // from "called pros but no usable quotes" (no_response). The
  // webhook's advanced:false path parks the row with
  // total_businesses_to_call=0; everything else with zero quotes
  // had at least one call placed. This drives the email copy so
  // we don't claim "we called the local pros" when no calls
  // actually happened.
  const noQuoteCause: NoQuoteCause | undefined =
    quotes.length === 0
      ? (request.total_businesses_to_call ?? 0) === 0
        ? 'coverage_gap'
        : 'no_response'
      : undefined;

  const payload: QuoteReportInput = {
    recipientName: recipient.name,
    categoryName,
    city: request.city,
    state: request.state,
    coverageSummary,
    dashboardUrl,
    refundOutcome,
    noQuoteCause,
    quotes: quotes.map<QuoteForReport>((q) => ({
      businessName: q.business?.name ?? 'Local pro',
      priceMin: q.price_min,
      priceMax: q.price_max,
      priceDescription: q.price_description,
      availability: q.availability,
      includes: q.includes,
      excludes: q.excludes,
      notes: q.notes,
      requiresOnsiteEstimate: q.requires_onsite_estimate,
    })),
  };
  const rendered = renderQuoteReport(payload);

  // 5. Persist a snapshot BEFORE sending so we have a durable record
  // of what went out even if the mail provider's response is lost.
  const reportData = {
    generated_at: new Date().toISOString(),
    category_name: categoryName,
    coverage_summary: coverageSummary,
    quote_count: quotes.length,
    refund_outcome: refundOutcome,
    // Store the serialized payload minus PII. dashboardUrl and the
    // rendered HTML are reproducible from this shape.
    payload_snapshot: {
      city: request.city,
      state: request.state,
      quotes: payload.quotes,
    },
  };

  const { error: stampGenErr } = await admin
    .from('quote_requests')
    .update({
      report_generated_at: new Date().toISOString(),
      report_data: reportData,
    })
    .eq('id', request.id);
  if (stampGenErr) {
    return {
      status: 'failed',
      reason: `stamp generated: ${stampGenErr.message}`,
    };
  }

  // 6. Claim the row BEFORE sending — outbox-marker pattern.
  //
  // R47.4: the old order was send-then-stamp. If the email succeeded
  // but the post-send stamp failed (DB blip, deploy mid-write,
  // anything), the next cron tick saw `report_sent_at IS NULL` and
  // re-sent the same report. Customers got duplicate emails on a
  // paid product — exactly the kind of "looks broken" signal we
  // can't afford.
  //
  // New order: stamp `report_sent_at` to "now" with a CAS guard
  // (`AND report_sent_at IS NULL`) BEFORE the send. If 0 rows
  // updated, someone else claimed it — skip. Then send. If send
  // fails, the row is left in a "claimed but undelivered" state
  // (report_sent_at non-null, status still 'processing'). The row
  // shows up in admin queries on `status='processing' AND
  // report_sent_at IS NOT NULL` and ops can decide whether to
  // un-stamp + retry. The trade-off chosen: at-most-once delivery
  // (favoring trust) over at-least-once (favoring throughput).
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await admin
    .from('quote_requests')
    .update({ report_sent_at: claimedAt })
    .eq('id', request.id)
    .is('report_sent_at', null)
    .select('id')
    .maybeSingle();
  if (claimErr) {
    log.error('outbox claim failed', { requestId: request.id, err: claimErr });
    captureException(new Error(`outbox claim: ${claimErr.message}`), {
      tags: {
        lib: 'cron-send-reports',
        reason: 'outboxClaimFailed',
        requestId: request.id,
      },
    });
    return { status: 'failed', reason: `outbox claim: ${claimErr.message}` };
  }
  if (!claimed) {
    // Lost the race to a parallel cron tick. Skip without sending.
    return { status: 'skipped', reason: 'already claimed by another run' };
  }

  // 7. Send. The row is now claimed — even if this throws or the
  // process dies, the row will not be re-claimed by the next tick
  // (its report_sent_at is non-null).
  const send = await sendEmail({
    to: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'quote-report',
  });

  if (!send.ok) {
    // The row is claimed but undelivered. Surface it loudly so ops
    // can reconcile (un-stamp report_sent_at to retry, or accept
    // the loss + refund).
    log.error('send failed AFTER outbox claim — row is in undelivered state', {
      requestId: request.id,
      err: send.error,
    });
    captureException(new Error(send.error), {
      tags: {
        lib: 'cron-send-reports',
        reason: 'sendFailedPostClaim',
        requestId: request.id,
      },
    });
    return { status: 'failed', reason: send.error };
  }

  // 8. Final stamp. The send went out; advance status and record the
  // provider message id. A failure here means status stays
  // 'processing' but report_sent_at is set — same undelivered-state
  // shape as above (no duplicate-send risk because the cron's filter
  // checks report_sent_at IS NULL). Log loudly + capture; ops can
  // manually flip status to 'completed'.
  const { error: finalErr } = await admin
    .from('quote_requests')
    .update({ status: 'completed' })
    .eq('id', request.id);
  if (finalErr) {
    log.error(
      'email sent + outbox claimed but status flip failed — manual reconcile needed',
      {
        requestId: request.id,
        emailId: send.id,
        err: finalErr,
      }
    );
    captureException(new Error(finalErr.message), {
      tags: {
        lib: 'cron-send-reports',
        reason: 'finalStampFailed',
        requestId: request.id,
        emailId: send.id,
      },
    });
    // Email DID go out — return sent so the caller's metrics reflect
    // reality. The status mismatch is an admin-visible follow-up,
    // not a customer-facing failure.
    void fireDeliveredAnalytics(request);
    return { status: 'sent', email_id: send.id };
  }

  void fireDeliveredAnalytics(request);
  return { status: 'sent', email_id: send.id };
}

/**
 * Fire `quote_delivered` to GA4 (and any future provider) via the
 * Measurement Protocol. Fire-and-forget — analytics MUST NOT delay
 * the cron return path or break the send pipeline. trackServer
 * already swallows per-provider failures internally; we wrap with a
 * `.catch` belt-and-suspenders so an unexpected throw doesn't bubble.
 *
 * client_id = quote_request.id so the event ties back to the same
 * user-journey as the upstream `quote_request_paid` (which fires
 * with the same request_id from the success page). Imperfect — the
 * paid event uses the user's real GA4 cookie client_id, while this
 * event uses the request UUID — but events with the same request_id
 * param are still joinable in GA4 explorations.
 */
function fireDeliveredAnalytics(request: ProcessingRequest): Promise<void> {
  // Narrow category.slug to the analytics vertical union; unknown
  // slugs drop the param rather than poison the event.
  const KNOWN_VERTICALS: ReadonlySet<NonNullable<AnalyticsEventParams['vertical']>> =
    new Set(['moving', 'cleaning', 'handyman', 'lawn-care', 'junk-removal']);
  const slug = request.category?.slug;
  const vertical =
    slug && KNOWN_VERTICALS.has(slug as NonNullable<AnalyticsEventParams['vertical']>)
      ? (slug as NonNullable<AnalyticsEventParams['vertical']>)
      : undefined;

  return trackServer({
    name: 'quote_delivered',
    clientId: request.id,
    params: { vertical, request_id: request.id },
  })
    .then(() => undefined)
    .catch(() => undefined);
}

// ─── helpers ────────────────────────────────────────────────────────

async function resolveRecipient(
  admin: SupabaseClient,
  request: ProcessingRequest
): Promise<{ email: string; name: string | null } | null> {
  // Prefer authed user's profile email — that's the account they can
  // sign into to release contacts. Covers the normal post-claim path.
  if (request.user_id) {
    const { data: profile } = await admin
      .from('profiles')
      .select('email, full_name')
      .eq('id', request.user_id)
      .maybeSingle();
    if (profile?.email) {
      return { email: profile.email, name: profile.full_name ?? null };
    }
  }

  // Guest fallback. The intake forms store these fields consistently;
  // see lib/forms/*-intake.ts.
  const intake = request.intake_data ?? {};
  const email = stringOrNull(intake['contact_email']);
  if (!email) return null;
  const name = stringOrNull(intake['contact_name']);
  return { email, name };
}

function buildCoverageSummary(r: ProcessingRequest): string {
  const reached = r.total_calls_completed;
  const planned = r.total_businesses_to_call;
  const quoted = r.total_quotes_collected;
  if (planned === 0) return `${quoted} quote${quoted === 1 ? '' : 's'} collected.`;
  return `We reached ${reached} of ${planned} local pros and collected ${quoted} quote${quoted === 1 ? '' : 's'}.`;
}

function buildDashboardUrl(requestId: string): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ??
    'https://evenquote.com';
  return `${base}/dashboard/requests/${requestId}`;
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// ─── refund wire-up ─────────────────────────────────────────────────
//
// When a quote_request lands in 'processing' with zero quotes, the
// customer paid $9.99 and got nothing actionable. The customer-facing
// template used to say "we're refunding your request" regardless of
// whether we actually did — that was a truthfulness bug.
//
// This helper does the real thing: looks up the payments row, calls
// Stripe's refund API with an idempotency key derived from the payment
// row id, and marks payments.status='refunded' on success.
//
// Idempotency:
//   • A cron retry of the same quote_request will pass the same
//     `refund-zero-quotes-<paymentId>` idempotency key to Stripe, which
//     returns the existing refund instead of creating a second.
//   • If payments.status is already 'refunded' we short-circuit with
//     'issued' (the refund exists from a prior run — that's what the
//     user should hear).
//
// Failure modes and what the user hears:
//   • Stripe down / auth error  → 'pending_support'  → template asks
//                                   user to reply, ops refunds manually.
//   • payments row missing      → 'pending_support' with loud log.
//   • payment_intent missing    → 'pending_support' with loud log.
//   • Everything works          → 'issued'           → template tells
//                                   them the refund is on the way.

async function refundForZeroQuotes(
  admin: SupabaseClient,
  requestId: string
): Promise<RefundOutcome> {
  const { data: pay, error: payErr } = await admin
    .from('payments')
    .select('id, stripe_payment_intent_id, status')
    .eq('quote_request_id', requestId)
    .maybeSingle();

  if (payErr) {
    log.error('refund: payments lookup failed', {
      requestId,
      err: payErr,
    });
    // Refund path is blocked on a DB error — customer is told "reply
    // to this email" instead of getting the promised refund. Signal
    // is genuine (infra / permissions) not invariant-violation.
    captureException(new Error(payErr.message), {
      tags: {
        lib: 'cron-send-reports',
        reason: 'refundLookupFailed',
        requestId,
      },
    });
    return 'pending_support';
  }

  if (!pay) {
    // Shouldn't happen — a processing quote_request implies a paid
    // session. If it does, ops needs to reconcile; don't lie to the user.
    log.warn('refund: no payments row for request', { requestId });
    return 'pending_support';
  }

  if (pay.status === 'refunded') {
    // Already refunded on a previous run (cron retry, or ops did it
    // manually and updated the row). Tell the user the refund is done.
    return 'issued';
  }

  if (!pay.stripe_payment_intent_id) {
    // Webhook should have populated this. If it didn't, we can't refund
    // via the API — escalate to support.
    log.warn('refund: payments row has no payment_intent_id', {
      paymentId: pay.id,
      requestId,
    });
    return 'pending_support';
  }

  try {
    const stripe = getStripe();
    await stripe.refunds.create(
      {
        payment_intent: pay.stripe_payment_intent_id,
        reason: 'requested_by_customer',
        metadata: {
          quote_request_id: requestId,
          payment_row_id: pay.id,
          source: 'cron/send-reports/zero-quotes',
        },
      },
      {
        // Stripe will return the existing refund (not create a new one)
        // if the same key comes in twice, which is exactly what we want
        // for cron retry safety.
        idempotencyKey: `refund-zero-quotes-${pay.id}`,
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('refund: stripe.refunds.create failed', {
      requestId,
      paymentId: pay.id,
      err: msg,
    });
    // Stripe side unreachable/errored → customer was told "zero quotes,
    // refund on the way" (template) but the refund did NOT happen. The
    // template falls back to "reply to this email" when we return
    // 'pending_support' here — but it's worth an active page so ops
    // can do the refund manually before the user replies.
    captureException(err, {
      tags: {
        lib: 'cron-send-reports',
        reason: 'refundCreateFailed',
        requestId,
        paymentId: pay.id,
      },
    });
    return 'pending_support';
  }

  // Stripe succeeded. Mark the payments row. A failure here is merely
  // a book-keeping issue — the customer has their money back, and the
  // next run's idempotency key will no-op on Stripe's side. Log + tell
  // the user the refund is issued.
  const { error: updErr } = await admin
    .from('payments')
    .update({ status: 'refunded' })
    .eq('id', pay.id);
  if (updErr) {
    log.error('refund: payments status update failed after successful Stripe refund', {
      paymentId: pay.id,
      requestId,
      err: updErr,
    });
    // Book-keeping drift: Stripe has issued the refund, our DB still
    // says 'completed'. A next run's idempotency key would no-op on
    // Stripe's side (safe), but the payments table doesn't reflect
    // the refund. Medium signal — data drift, not customer-facing.
    captureException(new Error(updErr.message), {
      tags: {
        lib: 'cron-send-reports',
        reason: 'refundStatusUpdateFailed',
        requestId,
        paymentId: pay.id,
      },
    });
  }

  return 'issued';
}
