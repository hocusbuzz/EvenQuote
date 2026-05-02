// Stripe webhook handler.
//
// Receives events from Stripe (delivered to /api/stripe/webhook). We only
// care about one event for Phase 5: checkout.session.completed. Everything
// else we acknowledge with 200 and ignore — Stripe resends on non-2xx.
//
// ─────────────────────────────────────────────────────────────────────
// Why this file is paranoid:
//
// 1. Signature verification MUST happen on the raw request body. If we
//    JSON.parse first and re-stringify, the signature won't match because
//    whitespace / key ordering differs. We read `await req.text()` and
//    hand the string to stripe.webhooks.constructEvent.
//
// 2. Stripe retries delivery on any non-2xx response, AND can sometimes
//    re-deliver even after a 2xx during their own infrastructure issues.
//    That means every handler MUST be idempotent. We gate on a unique
//    `payments.stripe_event_id` — a second insert with the same id will
//    fail on the unique index, and we catch that as "already processed".
//
// 3. This route runs on Node (not Edge) because the Stripe SDK uses
//    Node crypto. We opt out of route caching and force dynamic.
//
// 4. We use the admin client. The webhook has no user session. The
//    payment row gets written with user_id = NULL on guest flows;
//    /get-quotes/claim will backfill it after magic-link sign-in.
//
// 5. Side-effects after DB writes (magic link, enqueue calls) are
//    best-effort: if they fail we log but still return 200, so Stripe
//    doesn't retry a payment we already recorded. The magic link is
//    resend-safe; the calling job stub is idempotent per-request.
//
// 6. If we ever move to background job processing, a separate
//    reconciler should sweep `status='paid'` quote_requests without
//    enqueued calls. Out of scope for Phase 5 stub.
// ─────────────────────────────────────────────────────────────────────

import { NextResponse, type NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';
import type Stripe from 'stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendPaymentMagicLink } from '@/lib/actions/post-payment';
import { enqueueQuoteCalls } from '@/lib/queue/enqueue-calls';
import { seedBusinessesForRequest } from '@/lib/ingest/seed-on-demand';
import { createLogger } from '@/lib/logger';
import { verifyStripeWebhook } from '@/lib/security/stripe-auth';
import { captureException, captureMessage } from '@/lib/observability/sentry';
import { sendEmail } from '@/lib/email/resend';
import { trackServer } from '@/lib/analytics/track-server';
import type { AnalyticsEventParams } from '@/lib/analytics/events';
import {
  renderCallsScheduled,
  renderNewPaymentAlert,
} from '@/lib/email/templates';
import { resolveTimezoneFromState } from '@/lib/scheduling/business-hours';

const log = createLogger('stripe/webhook');

// Webhook route must not be statically optimized. Force per-request.
export const dynamic = 'force-dynamic';
// Node runtime required: Stripe SDK uses Node's crypto.
export const runtime = 'nodejs';

type OkResponse = { received: true; eventId: string; note?: string };
type ErrResponse = { error: string };

export async function POST(
  req: NextRequest
): Promise<NextResponse<OkResponse | ErrResponse>> {
  // Must be the raw body. Do NOT parse before verification. The helper
  // delegates HMAC verification to the Stripe SDK's constructEvent,
  // which runs constant-time comparison internally.
  const raw = await req.text();
  const auth = await verifyStripeWebhook(req, raw);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { event } = auth;

  // ── Route on event type ────────────────────────────────────────────
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const note = await handleCheckoutCompleted(
          event,
          event.data.object as Stripe.Checkout.Session
        );
        return NextResponse.json({ received: true, eventId: event.id, note });
      }

      // Chargeback alert. Customer disputed the $9.99 with their bank. We
      // can't auto-respond programmatically (Stripe requires manual evidence
      // submission via dashboard), but we MUST surface this immediately:
      //   • Sentry warning so it lands on the on-call dashboard
      //   • Email to ops inbox so the operator sees it without checking Stripe
      //   • Best-effort: tag the related quote_request in the log so the
      //     operator has all the context for reviewing the dispute
      // No DB write — disputes need human judgment, not auto-action.
      case 'charge.dispute.created': {
        const note = await handleDisputeCreated(
          event,
          event.data.object as Stripe.Dispute
        );
        return NextResponse.json({ received: true, eventId: event.id, note });
      }

      // Acknowledge but no-op. We handle success on checkout.session.completed,
      // not on payment_intent.succeeded, because Checkout Sessions emit both
      // and we only want to process once.
      case 'payment_intent.succeeded':
      case 'payment_intent.created':
      case 'payment_intent.payment_failed':
      case 'checkout.session.expired':
      case 'charge.succeeded':
      case 'charge.updated':
        return NextResponse.json({
          received: true,
          eventId: event.id,
          note: `Ignored event type: ${event.type}`,
        });

      default:
        // Unknown but well-formed event. 200 so Stripe doesn't retry.
        log.info('unhandled event type', { eventType: event.type, eventId: event.id });
        return NextResponse.json({
          received: true,
          eventId: event.id,
          note: `Unhandled event type: ${event.type}`,
        });
    }
  } catch (err) {
    // Anything unexpected: 500 so Stripe retries. We logged it below in
    // the handler, so this is a hook for correlation.
    log.error('handler threw', { err });
    // Route to the error tracker as well as the structured log. No-op
    // when Sentry isn't wired — additive until the DSN lands.
    captureException(err, {
      tags: { route: 'stripe/webhook', eventType: event.type, eventId: event.id },
    });
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────
// checkout.session.completed handler
// ─────────────────────────────────────────────────────────────────────
async function handleCheckoutCompleted(
  event: Stripe.Event,
  session: Stripe.Checkout.Session
): Promise<string> {
  // 1. Extract the quote_request id. We set BOTH client_reference_id and
  //    metadata.quote_request_id during session creation. Prefer the
  //    canonical slot but fall back to metadata.
  const requestId =
    session.client_reference_id ??
    (typeof session.metadata?.quote_request_id === 'string'
      ? session.metadata.quote_request_id
      : null);

  if (!requestId) {
    // This means we got a checkout.session.completed we didn't originate.
    // Someone else's integration on the same Stripe account? Unlikely but
    // possible. Log and ack.
    log.warn('session.completed with no quote_request id', {
      sessionId: session.id,
      eventId: event.id,
    });
    return 'No quote_request id on session — ignored';
  }

  if (session.payment_status !== 'paid') {
    // e.g. 'unpaid' on manual invoices. Our flow is all upfront card so
    // this should not happen, but we don't want to mark paid on a 'unpaid'
    // session by accident.
    log.warn('session.completed but payment_status not paid', {
      sessionId: session.id,
      paymentStatus: session.payment_status,
    });
    return `Ignored: payment_status=${session.payment_status}`;
  }

  const admin = createAdminClient();

  // 2. Idempotency: try to insert the payments row first. If stripe_event_id
  //    is already present, the unique index blocks the insert. That is our
  //    "already processed" signal.
  //
  //    We write user_id=NULL for guest flow. The claim route will backfill.
  //    Amount and currency are taken from the session (authoritative). We
  //    do NOT trust QUOTE_REQUEST_PRICE here — if someone ever creates a
  //    session with a different amount via Stripe dashboard, the DB should
  //    record what actually got charged.
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);

  const amountTotal = session.amount_total ?? 0;

  // `payment_status` enum is ('pending', 'completed', 'failed', 'refunded')
  // — NO 'paid' value. Earlier code used 'paid' here and every insert
  // silently failed with Postgres 22P02 (invalid enum). This is why live
  // payments rows never landed despite Stripe firing the webhook. The
  // semantic is "the card was charged", which maps to 'completed'; we
  // reserve 'refunded' for the zero-quotes refund path in cron/send-reports.
  const { error: insertErr } = await admin
    .from('payments')
    .insert({
      user_id: null,
      quote_request_id: requestId,
      stripe_session_id: session.id,
      stripe_payment_intent_id: paymentIntentId,
      stripe_event_id: event.id,
      amount: amountTotal,
      currency: (session.currency ?? 'usd').toLowerCase(),
      status: 'completed',
    });

  if (insertErr) {
    // Postgres unique violation code is 23505. supabase-js surfaces
    // .code on the returned error object.
    // Either:
    //  (a) this event was already processed (stripe_event_id collides), or
    //  (b) the session_id is already on a row (shouldn't happen, but the
    //      unique index would catch it too).
    // Both are effectively "already done" — ack and move on.
    if (insertErr.code === '23505') {
      log.info('duplicate event, already processed', {
        eventId: event.id,
        sessionId: session.id,
      });
      return 'Duplicate event — already processed';
    }

    log.error('payments insert failed', { err: insertErr });
    // Throw to bubble up to the outer handler, which returns 500 and
    // triggers Stripe to retry. We WANT the retry here.
    throw new Error(`payments insert failed: ${insertErr.message}`);
  }

  // 3. Flip the quote_request to 'paid'. Only do this if the current row
  //    is still pending_payment — avoids clobbering a later status
  //    (e.g. if some other flow advanced it to 'calling' already).
  //    Joins service_categories so the post-payment side effects can tag
  //    analytics events with the vertical without a second round-trip.
  const { data: updated, error: updateErr } = await admin
    .from('quote_requests')
    .update({ status: 'paid' })
    .eq('id', requestId)
    .eq('status', 'pending_payment')
    .select(
      'id, status, intake_data, city, state, service_categories ( slug, name )'
    )
    .maybeSingle();

  if (updateErr) {
    log.error('quote_requests update failed', { err: updateErr, requestId });
    // Don't throw — we already recorded the payment. A later reconcile
    // can promote the status. Returning 200 prevents retry storms.
    return 'Payment recorded; status update failed (will reconcile)';
  }

  if (!updated) {
    // Row was not in pending_payment. Could be already paid (webhook
    // re-entry caught by the insert idempotency above) or advanced.
    log.info('quote_request not in pending_payment, skipping status flip', {
      requestId,
    });
    return 'Payment recorded; status was already advanced';
  }

  // 4. Compute contact email + name NOW (sync) — we have the intake_data
  //    in hand and the async function shouldn't have to re-read it.
  type IntakeShape = { contact_email?: string; contact_name?: string };
  const intake = (updated.intake_data ?? {}) as IntakeShape;
  const contactEmail =
    intake.contact_email?.trim().toLowerCase() ??
    session.customer_details?.email?.trim().toLowerCase() ??
    null;
  const contactName = intake.contact_name?.trim() || null;

  // Pull the category slug + display name off the joined row.
  // Supabase-js returns a nested-object OR an array depending on the
  // FK shape; normalize either way.
  type CategoryRel = { slug?: string; name?: string } | null;
  const catRaw = (updated as { service_categories?: CategoryRel | CategoryRel[] })
    .service_categories;
  const categoryRel = Array.isArray(catRaw) ? (catRaw[0] ?? null) : (catRaw ?? null);
  const categorySlug = categoryRel?.slug ?? null;
  const categoryName = categoryRel?.name ?? null;

  // 5. Schedule post-payment side effects async via waitUntil. This is
  //    the #121 fix: the webhook used to do magic link + Places seed +
  //    Vapi dispatch synchronously before returning, which can take 12+
  //    seconds (Stripe's median was 1.9s, max 11.9s in the first week
  //    of prod). Stripe times out at 30s but pays cost retries on
  //    anything over 5s. Now the webhook returns within ~200ms after
  //    the DB writes, and the slow work continues in the background.
  //
  //    Idempotency story (no regression):
  //      • payments insert idempotency stays on the sync path (above).
  //        A Stripe retry hits the unique index and short-circuits.
  //      • sendPaymentMagicLink: duplicate magic links are harmless —
  //        Supabase Auth treats each as a fresh OTP.
  //      • seedBusinessesForRequest: idempotent via the
  //        businesses_seeded_at sentinel.
  //      • enqueueQuoteCalls → runCallBatch: idempotent via
  //        vapi_batch_started_at + status check (claim-once semantics).
  //
  //    Failure visibility: the async function logs + captureException's
  //    every error path. We don't lose ops signal when work moves
  //    off-thread; we lose only the ability to fail the webhook
  //    response on errors there. That's correct — Stripe shouldn't
  //    retry magic-link or seeding hiccups.
  waitUntil(
    runPostPaymentSideEffects({
      requestId,
      contactEmail,
      contactName,
      categorySlug,
      categoryName,
      // amount_total is in cents; convert to dollars for the analytics
      // event value (Meta + GA4 both expect a decimal currency amount).
      amountUsd: amountTotal / 100,
    })
  );

  return 'Processed (side effects async)';
}

// ─────────────────────────────────────────────────────────────────────
// Post-payment side effects (#121 — async via waitUntil)
// ─────────────────────────────────────────────────────────────────────
//
// All steps are best-effort with their own error envelopes. None
// blocks the Stripe 200 response; all log + Sentry-capture on failure.
//
//   A.  sendPaymentMagicLink     — passwordless sign-in for guest claim
//   B.  seedBusinessesForRequest — Google Places searchText for cold zips
//   C.  enqueueQuoteCalls        — kick off Vapi dispatch (or defer per #117)
//                                   (with advanced:false → park-for-refund)
//   C2. renderCallsScheduled     — when C deferred, email "calls scheduled
//                                   for X" so customer doesn't read the
//                                   silence as broken
//   D.  trackServer paid event   — server-side analytics backstop for
//                                   close-the-tab conversions GA4/Pixel miss
//   E.  renderNewPaymentAlert    — founder "new paid request" ping during
//                                   launch window. Env-gated; opt-out via
//                                   EVENQUOTE_NEW_PAYMENT_ALERTS=false
//
// Order matters: seed before enqueue because the engine's selector reads
// the freshly seeded rows. Magic-link is independent; we kick it off
// first so the user has the email by the time they visit /success.
async function runPostPaymentSideEffects(args: {
  requestId: string;
  contactEmail: string | null;
  contactName: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  amountUsd: number;
}): Promise<void> {
  const { requestId, contactEmail, contactName, categorySlug, categoryName, amountUsd } = args;

  // ── A. Magic link ───────────────────────────────────────────────
  if (contactEmail) {
    try {
      await sendPaymentMagicLink({
        email: contactEmail,
        requestId,
        recipientName: contactName,
        categoryName,
      });
    } catch (err) {
      log.error('magic link send failed', { err, requestId });
      captureException(err, {
        tags: { route: 'stripe/webhook', site: 'magic-link', requestId },
      });
    }
  } else {
    log.warn('no contact email found for magic link', { requestId });
  }

  // ── B. On-demand seed ───────────────────────────────────────────
  // Fires Google Places searchText biased to the request's origin
  // coords so the call engine has a fresh, geo-relevant pool to pick
  // from. Best-effort: Places rate-limit / outage / zero-result is
  // not fatal — the engine falls back to whatever's already in the
  // businesses table (manual ingest, prior seeds). Idempotent via
  // quote_requests.businesses_seeded_at sentinel.
  try {
    const seed = await seedBusinessesForRequest({ quoteRequestId: requestId });
    if (seed.ok) {
      log.info('on-demand seed result', { requestId, seed });
    } else {
      log.warn('on-demand seed soft-failed', { requestId, reason: seed.reason });
    }
  } catch (err) {
    log.error('seedBusinessesForRequest threw', { err, requestId });
    captureException(err, {
      tags: { route: 'stripe/webhook', site: 'seed-on-demand', requestId },
    });
  }

  // ── C. Enqueue Vapi calls ───────────────────────────────────────
  // Tracks the result so the deferred-confirmation email step (D)
  // below knows whether enqueue deferred + when. Initialized to null
  // so a thrown enqueue (caught below) leaves the deferred-email
  // step a clean no-op.
  let enqResult: Awaited<ReturnType<typeof enqueueQuoteCalls>> | null = null;
  try {
    const enq = await enqueueQuoteCalls({ quoteRequestId: requestId });
    enqResult = enq;

    // R47.5: handle the {ok:true, advanced:false} soft-failure case.
    //
    // enqueueQuoteCalls returns this when:
    //   • runCallBatch flipped status='failed' because no businesses
    //     matched any tier (zip → radius → state)
    //   • batch was already claimed by another tick
    //   • selectBusinesses returned 0 + dispatched 0 for any other
    //     non-throwing reason
    //
    // Pre-fix: the webhook logged success and returned. The customer's
    // payment was recorded; the request sat in `status='failed'`; the
    // send-reports cron only scans `status='processing'`, so the row
    // never auto-refunded and ops only learned about it from a
    // support ticket. Codex caught this on re-review.
    //
    // Fix: convert the row into the exact same shape that send-reports'
    // zero-quote refund path already handles — `status='processing'`
    // with zero quotes collected and zero calls planned. The cron's
    // next tick (≤5 min) processes it through the existing refund
    // logic: Stripe refund + apology email with refundOutcome='issued'.
    // No new code path, no duplicate refund logic, leverages the
    // tested pipeline. Capture for ops visibility regardless.
    if (enq.ok && !enq.advanced) {
      log.error('enqueue advanced:false — paid request stranded; routing to refund', {
        requestId,
        reason: enq.reason,
      });
      captureException(
        new Error(`enqueue advanced:false: ${enq.reason ?? 'unknown'}`),
        {
          tags: {
            route: 'stripe/webhook',
            site: 'enqueue-calls',
            requestId,
          },
        }
      );

      // Park the row in 'processing' so send-reports picks it up
      // and runs the zero-quote refund path. We deliberately set
      // total_businesses_to_call=0 + total_calls_completed=0 so the
      // status-advance invariant in apply_call_end RPC stays
      // consistent: report_data will record refund_outcome='issued'
      // and the customer gets a clear "we couldn't reach anyone +
      // here's your refund" email instead of silence.
      const admin2 = createAdminClient();
      const { error: parkErr } = await admin2
        .from('quote_requests')
        .update({
          status: 'processing',
          total_businesses_to_call: 0,
          total_calls_completed: 0,
          total_quotes_collected: 0,
        })
        .eq('id', requestId);
      if (parkErr) {
        log.error('failed to park request for refund', {
          requestId,
          err: parkErr,
        });
        captureException(
          new Error(`park-for-refund: ${parkErr.message}`),
          {
            tags: {
              route: 'stripe/webhook',
              site: 'enqueue-calls',
              requestId,
            },
          }
        );
      }
    }
  } catch (err) {
    log.error('enqueue calls failed', { err, requestId });
    // Paid user ends up with no calls placed — the exact failure mode
    // that destroys trust. Ship to error tracker.
    captureException(err, {
      tags: { route: 'stripe/webhook', site: 'enqueue-calls', requestId },
    });
  }

  // ── C2. Deferred-dispatch confirmation email (#117 + 2026-05-01) ──
  // When enqueueQuoteCalls deferred to local business hours, the
  // customer paid but won't see calls happening for hours. Without a
  // proactive email they're left with just the Stripe receipt + the
  // magic-link email — neither of which says "your calls are
  // scheduled for X." A real customer (San Marcos handyman,
  // 2026-05-01) read the magic-link email as "your quotes are ready"
  // because nothing else explained the gap.
  //
  // We send this AFTER the enqueue try/catch so a thrown enqueue
  // doesn't trigger the email (no scheduled time to communicate).
  // Detection: the deferred branch returns shape
  //   { ok:true, advanced:true, enqueued:0, scheduledFor:string, note }
  // — `scheduledFor` is the discriminator (the immediate-dispatch
  // branch doesn't have it).
  if (
    contactEmail &&
    enqResult &&
    enqResult.ok &&
    'scheduledFor' in enqResult &&
    typeof enqResult.scheduledFor === 'string'
  ) {
    try {
      const adminForName = createAdminClient();
      // Pull the recipient name + service-area state for the template.
      // The state for tz lookup is on quote_requests already; we
      // re-read intake_data for contact_name (could thread it from
      // the outer scope, but the row is small and this keeps the
      // dependency local).
      const { data: row } = await adminForName
        .from('quote_requests')
        .select(
          'city, state, intake_data, service_categories ( name )'
        )
        .eq('id', requestId)
        .maybeSingle();

      type IntakeShape = { contact_name?: string };
      const intakeShape = (row?.intake_data ?? {}) as IntakeShape;
      type CategoryRel = { name?: string } | null;
      const catRow = (row as { service_categories?: CategoryRel | CategoryRel[] } | null)
        ?.service_categories;
      const categoryName = Array.isArray(catRow)
        ? (catRow[0]?.name ?? 'Service')
        : (catRow?.name ?? 'Service');

      const tz = row?.state
        ? resolveTimezoneFromState(row.state)
        : 'America/Los_Angeles';

      const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://evenquote.com'}/get-quotes/success?request=${encodeURIComponent(requestId)}`;

      const rendered = renderCallsScheduled({
        recipientName: intakeShape.contact_name ?? null,
        city: row?.city ?? '',
        state: row?.state ?? '',
        categoryName,
        scheduledForIso: enqResult.scheduledFor,
        serviceAreaTz: tz,
        dashboardUrl,
      });

      const send = await sendEmail({
        to: contactEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tag: 'calls-scheduled',
      });

      if (!send.ok) {
        log.error('calls-scheduled email send failed', {
          requestId,
          err: send.error,
        });
        captureException(new Error(`calls-scheduled email: ${send.error}`), {
          tags: {
            route: 'stripe/webhook',
            site: 'calls-scheduled-email',
            requestId,
          },
        });
      } else {
        log.info('calls-scheduled email sent', {
          requestId,
          scheduledFor: enqResult.scheduledFor,
        });
      }
    } catch (err) {
      log.error('calls-scheduled email step threw', { err, requestId });
      captureException(err, {
        tags: {
          route: 'stripe/webhook',
          site: 'calls-scheduled-email',
          requestId,
        },
      });
    }
  }

  // ── D. Analytics: quote_request_paid (server-side backstop) ─────
  // The success page also fires `quote_request_paid` client-side via
  // the Pixel. This is the BACKSTOP for the close-the-tab case where
  // the customer pays but never lands on /get-quotes/success — the
  // client-side fire never runs and the conversion goes uncounted,
  // which under-reports paid-traffic ROAS.
  //
  // Dedupe: trackServer's Meta CAPI path uses event_id =
  // `quote_request_paid:<requestId>`. The client-side Pixel fire (in
  // components/get-quotes/track-paid-on-mount.tsx) uses the matching
  // eventID. Meta dedupes by event_id so the conversion is counted
  // exactly once even when both sides fire. GA4's Measurement
  // Protocol doesn't dedupe automatically, but server-fired events
  // arrive in a different `engagement_time_msec` window so they
  // generally don't conflate with the client fire in funnel reports.
  //
  // Fire-and-forget: trackServer swallows per-provider failures
  // internally; we wrap in a separate try so an unexpected throw
  // doesn't bubble out of the async post-payment work.
  try {
    const KNOWN_VERTICALS: ReadonlySet<NonNullable<AnalyticsEventParams['vertical']>> =
      new Set(['moving', 'cleaning', 'handyman', 'lawn-care', 'junk-removal']);
    const vertical =
      categorySlug &&
      KNOWN_VERTICALS.has(categorySlug as NonNullable<AnalyticsEventParams['vertical']>)
        ? (categorySlug as NonNullable<AnalyticsEventParams['vertical']>)
        : undefined;

    await trackServer({
      name: 'quote_request_paid',
      clientId: requestId,
      params: {
        vertical,
        value: amountUsd,
        currency: 'USD',
        request_id: requestId,
      },
    });
  } catch (err) {
    // Already swallowed inside trackServer per-provider; this catch
    // is belt-and-suspenders. Log only — analytics MUST NOT break
    // the post-payment flow.
    log.warn('analytics quote_request_paid fire threw', { err, requestId });
  }

  // ── E. Founder "new payment" alert ───────────────────────────────
  // Tells the founder a real customer paid — useful during the launch
  // window when paid traffic is invisible without watching /admin.
  // Two gates:
  //   • EVENQUOTE_SUPPORT_EMAIL must be set (no recipient otherwise)
  //   • EVENQUOTE_NEW_PAYMENT_ALERTS must NOT equal 'false' (explicit
  //     opt-out for when volume turns this into noise — set to 'false'
  //     in Vercel and the alert silently no-ops)
  // Best-effort: a send failure logs + captures but does not bubble.
  const supportEmail = process.env.EVENQUOTE_SUPPORT_EMAIL?.trim();
  const alertsDisabled =
    process.env.EVENQUOTE_NEW_PAYMENT_ALERTS?.toLowerCase() === 'false';
  if (supportEmail && !alertsDisabled) {
    try {
      const adminForLoc = createAdminClient();
      const { data: locRow } = await adminForLoc
        .from('quote_requests')
        .select('city, state, zip_code')
        .eq('id', requestId)
        .maybeSingle();
      const location = locRow
        ? `${locRow.city ?? ''}, ${locRow.state ?? ''} ${locRow.zip_code ?? ''}`.trim()
        : '(unknown)';
      const adminUrl = process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/admin/requests/${requestId}`
        : '';
      const rendered = renderNewPaymentAlert({
        requestId,
        amountUsd,
        categoryName,
        location,
        contactName,
        contactEmail,
        adminUrl,
      });
      const send = await sendEmail({
        to: supportEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tag: 'new-payment-alert',
      });
      if (!send.ok) {
        log.warn('new-payment alert send failed', {
          requestId,
          err: send.error,
        });
        captureException(new Error(`new-payment alert: ${send.error}`), {
          tags: {
            route: 'stripe/webhook',
            site: 'new-payment-alert',
            requestId,
          },
        });
      }
    } catch (err) {
      log.warn('new-payment alert step threw', { err, requestId });
      captureException(err, {
        tags: {
          route: 'stripe/webhook',
          site: 'new-payment-alert',
          requestId,
        },
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// charge.dispute.created handler
// ─────────────────────────────────────────────────────────────────────
//
// Customer disputed a charge with their bank (chargeback). Stripe gives
// us ~7-21 days to submit evidence via their dashboard. There's no
// "auto-respond" — every dispute needs human judgment about whether to
// accept the loss or fight with documentation.
//
// What we do here:
//   1. captureMessage to Sentry (warning level) — lands on the on-call
//      dashboard so the operator sees the count rising even if email
//      delivery is degraded.
//   2. Email the ops inbox (EVENQUOTE_SUPPORT_EMAIL) with the dispute
//      amount + reason + Stripe dashboard link, so the operator doesn't
//      have to be watching Stripe to find out.
//   3. Best-effort: try to find the related quote_request id via the
//      payments table (charge_id → payment row → quote_request_id) and
//      include it in the alert. If the lookup fails we still email,
//      just without the request context.
//
// What we DON'T do:
//   • No DB writes. Disputes are a separate concern from quote_request
//     status; we don't want to mark a request as "refunded" when the
//     dispute could still be won.
//   • No 5xx — we always return ack so Stripe doesn't retry. Dispute
//     events are informational; missing one would just mean the operator
//     finds out via Stripe's email instead.
async function handleDisputeCreated(
  event: Stripe.Event,
  dispute: Stripe.Dispute
): Promise<string> {
  // Stripe gives us amount in the smallest currency unit (cents for USD).
  const amountUsd = (dispute.amount / 100).toFixed(2);
  const reason = dispute.reason ?? 'unspecified';
  const status = dispute.status;
  const chargeId =
    typeof dispute.charge === 'string'
      ? dispute.charge
      : (dispute.charge?.id ?? null);

  // Best-effort: link the dispute back to a quote_request so the operator
  // knows which customer/request to investigate. If the join fails, we
  // still alert — just with less context.
  let requestId: string | null = null;
  if (chargeId) {
    try {
      const admin = createAdminClient();
      const { data: pay } = await admin
        .from('payments')
        .select('quote_request_id')
        .eq('stripe_charge_id', chargeId)
        .maybeSingle();
      requestId = pay?.quote_request_id ?? null;
    } catch (err) {
      log.warn('dispute: payment lookup failed (continuing with alert)', {
        chargeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.warn('charge dispute created', {
    eventId: event.id,
    disputeId: dispute.id,
    amountUsd,
    reason,
    status,
    chargeId,
    requestId,
  });

  // Sentry warning so disputes show up in alert rollups even when email
  // isn't configured (e.g. a staging env without RESEND_API_KEY).
  captureMessage(
    `Stripe dispute created: $${amountUsd} (reason=${reason}, dispute=${dispute.id})`,
    'warning',
    {
      tags: {
        route: 'stripe/webhook',
        eventType: 'charge.dispute.created',
        reason,
        status,
      },
      extra: { disputeId: dispute.id, chargeId, requestId, eventId: event.id },
    }
  );

  // Email the ops inbox. Best-effort — email failure does NOT 500 the
  // webhook (we already captured to Sentry, and Stripe will email the
  // account email anyway as a backup channel).
  const supportEmail = process.env.EVENQUOTE_SUPPORT_EMAIL;
  if (!supportEmail) {
    log.warn('dispute alert: EVENQUOTE_SUPPORT_EMAIL not set — skipped email', {
      disputeId: dispute.id,
    });
    return `Dispute logged (no email — set EVENQUOTE_SUPPORT_EMAIL)`;
  }

  const dashboardLink = `https://dashboard.stripe.com/disputes/${dispute.id}`;
  const html = `
    <h2>Stripe dispute created — $${amountUsd}</h2>
    <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
    <p><strong>Status:</strong> ${escapeHtml(status)}</p>
    <p><strong>Dispute ID:</strong> <code>${escapeHtml(dispute.id)}</code></p>
    ${chargeId ? `<p><strong>Charge ID:</strong> <code>${escapeHtml(chargeId)}</code></p>` : ''}
    ${requestId ? `<p><strong>Quote request:</strong> <code>${escapeHtml(requestId)}</code></p>` : '<p><em>Could not link to a quote_request — check payments table manually.</em></p>'}
    <p><a href="${dashboardLink}">Review in Stripe →</a></p>
    <hr/>
    <p style="color:#666;font-size:12px;">You have ~7-21 days to submit evidence. After that, the dispute auto-resolves in the customer's favor.</p>
  `.trim();

  const sendResult = await sendEmail({
    to: supportEmail,
    subject: `🚨 Stripe dispute: $${amountUsd} (${reason})`,
    html,
    text:
      `Stripe dispute created\n\n` +
      `Amount: $${amountUsd}\n` +
      `Reason: ${reason}\n` +
      `Status: ${status}\n` +
      `Dispute ID: ${dispute.id}\n` +
      (chargeId ? `Charge ID: ${chargeId}\n` : '') +
      (requestId ? `Quote request: ${requestId}\n` : 'Could not link to quote_request\n') +
      `\nReview: ${dashboardLink}\n`,
    tag: 'stripe-dispute',
  });

  if (!sendResult.ok) {
    log.error('dispute alert email failed', {
      disputeId: dispute.id,
      error: sendResult.error,
    });
    // Don't 500 — Sentry already has it.
  }

  return `Dispute alert sent to ${supportEmail} (dispute=${dispute.id}, amount=$${amountUsd})`;
}

// Tiny HTML escaper — used in the dispute alert template. We don't
// pull in a full library because the dispute payload is Stripe-controlled
// and contains a small fixed set of fields.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
