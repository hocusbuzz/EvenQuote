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
import type Stripe from 'stripe';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendPaymentMagicLink } from '@/lib/actions/post-payment';
import { enqueueQuoteCalls } from '@/lib/queue/enqueue-calls';
import { seedBusinessesForRequest } from '@/lib/ingest/seed-on-demand';
import { createLogger } from '@/lib/logger';
import { verifyStripeWebhook } from '@/lib/security/stripe-auth';
import { captureException } from '@/lib/observability/sentry';

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
  const { data: updated, error: updateErr } = await admin
    .from('quote_requests')
    .update({ status: 'paid' })
    .eq('id', requestId)
    .eq('status', 'pending_payment')
    .select('id, status, intake_data, city, state')
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

  // 4. Post-payment side effects. Best-effort — if either fails we log but
  //    still return success so Stripe doesn't retry. The payment row is
  //    already written, so a reconciler/support can re-trigger these.
  type IntakeShape = { contact_email?: string; contact_name?: string };
  const intake = (updated.intake_data ?? {}) as IntakeShape;
  const contactEmail =
    intake.contact_email?.trim().toLowerCase() ??
    session.customer_details?.email?.trim().toLowerCase() ??
    null;

  if (contactEmail) {
    try {
      await sendPaymentMagicLink({
        email: contactEmail,
        requestId,
      });
    } catch (err) {
      log.error('magic link send failed', { err, requestId });
      // Paid user can't sign in to claim — high-visibility surface for
      // the error tracker. Tag with the site so alerts route to the
      // right on-call mental model. No-op until Sentry DSN lands.
      captureException(err, {
        tags: { route: 'stripe/webhook', site: 'magic-link', requestId },
      });
    }
  } else {
    log.warn('no contact email found for magic link', { requestId });
  }

  // 5. On-demand business seeding. Fires Google Places searchText
  //    biased to the request's origin coords so the call engine has a
  //    fresh, geo-relevant pool to pick from. Best-effort: if Places
  //    is rate-limited, down, or returns zero rows, the engine still
  //    runs against whatever's in the DB (manual ingest, prior seeds).
  //    Idempotent via quote_requests.businesses_seeded_at — a webhook
  //    replay won't double-charge the Places API.
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

  try {
    const enq = await enqueueQuoteCalls({ quoteRequestId: requestId });

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

  return 'Processed';
}
