// Dev-only "skip payment" shortcut.
//
// POST /api/dev/skip-payment  { quote_request_id: "uuid" }
//
// Exercises the full pre-Stripe flow (intake form → server action →
// /checkout) and then bypasses Stripe entirely by doing what the
// real webhook would do after a successful session.completed event:
//
//   1. Insert a `payments` row with status='completed' and a
//      synthetic stripe_session_id (prefixed `dev_skip_`).
//   2. Flip the `quote_request` from 'pending_payment' to 'paid'.
//   3. Kick `enqueueQuoteCalls` — the same path the real webhook
//      uses, so `runCallBatch` runs with the new batch size cap,
//      cost settings, voicemail detection, and TEST_OVERRIDE_PHONE
//      redirection all intact.
//
// Security gates, same shape as /api/dev/trigger-call:
//   • NODE_ENV !== 'production' → 404
//   • Optional DEV_TRIGGER_TOKEN → 401 on mismatch
//
// To remove: delete this file AND the dev-only button on
// app/get-quotes/checkout/page.tsx that POSTs to it.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { enqueueQuoteCalls } from '@/lib/queue/enqueue-calls';
import { seedBusinessesForRequest } from '@/lib/ingest/seed-on-demand';
import { assertDevToken } from '@/lib/security/dev-token-auth';
import { assertRateLimit } from '@/lib/security/rate-limit-auth';
import { QUOTE_REQUEST_PRICE } from '@/lib/stripe/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('dev/skip-payment');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const deny = assertDevToken(req);
  if (deny) return deny;

  // R48(h) — Defense-in-depth rate limit AFTER assertDevToken so the
  // no-probe-in-prod property holds. 30/60s — skip-payment is invoked
  // from the dev-only checkout button; a runaway loop that's
  // synthesizing paid requests is the precise failure mode this
  // catches.
  const rateLimitDeny = assertRateLimit(req, {
    prefix: 'dev-skip-payment',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimitDeny) return rateLimitDeny;

  let body: { quote_request_id?: string };
  try {
    body = (await req.json()) as { quote_request_id?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }
  const requestId = body.quote_request_id?.trim();
  if (!requestId) {
    return NextResponse.json(
      { ok: false, error: 'quote_request_id required' },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // 1. Load the request. Must exist and be in pending_payment.
  const { data: request, error: loadErr } = await admin
    .from('quote_requests')
    .select('id, status, intake_data, city, state')
    .eq('id', requestId)
    .maybeSingle();
  if (loadErr) {
    return NextResponse.json(
      { ok: false, error: `request lookup: ${loadErr.message}` },
      { status: 500 }
    );
  }
  if (!request) {
    return NextResponse.json({ ok: false, error: 'request not found' }, { status: 404 });
  }
  if (request.status !== 'pending_payment') {
    return NextResponse.json(
      {
        ok: true,
        skipped: true,
        note: `request status is '${request.status}', nothing to do`,
      },
      { status: 200 }
    );
  }

  // 2. Insert synthetic payments row. The `dev_skip_` prefix is how
  //    ops spots these later (same convention as `dev_trigger_` on
  //    /api/dev/trigger-call).
  const syntheticSession = `dev_skip_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const { error: insertErr } = await admin.from('payments').insert({
    user_id: null,
    quote_request_id: requestId,
    stripe_session_id: syntheticSession,
    stripe_payment_intent_id: null,
    stripe_event_id: null,
    amount: QUOTE_REQUEST_PRICE.amountCents,
    currency: 'usd',
    status: 'completed',
  });
  if (insertErr) {
    return NextResponse.json(
      { ok: false, error: `payments insert: ${insertErr.message}` },
      { status: 500 }
    );
  }

  // 3. Flip the request to 'paid'. Conditional update so we don't
  //    clobber a later status (defense in depth — this is a dev
  //    shortcut, but the pattern should be boringly correct).
  const { data: updated, error: updateErr } = await admin
    .from('quote_requests')
    .update({ status: 'paid' })
    .eq('id', requestId)
    .eq('status', 'pending_payment')
    .select('id, status')
    .maybeSingle();
  if (updateErr) {
    return NextResponse.json(
      { ok: false, error: `request update: ${updateErr.message}` },
      { status: 500 }
    );
  }
  if (!updated) {
    return NextResponse.json(
      { ok: true, skipped: true, note: 'request already advanced past pending_payment' },
      { status: 200 }
    );
  }

  // 4. Seed businesses on-demand (same path the webhook uses). Best-
  //    effort: if Places is unreachable we still proceed to enqueue
  //    against whatever's in the DB. Surfaces the result to the dev
  //    button payload so it's easy to spot in DevTools.
  let seed: Awaited<ReturnType<typeof seedBusinessesForRequest>> | null = null;
  try {
    seed = await seedBusinessesForRequest({ quoteRequestId: requestId });
  } catch (err) {
    log.warn('seedBusinessesForRequest threw (continuing)', { err, requestId });
  }

  // 5. Enqueue the call batch — same path the real webhook uses.
  //    Returning the batch result so the caller can see what happened
  //    (selected / dispatched / failed / simulated).
  let batch: Awaited<ReturnType<typeof enqueueQuoteCalls>> | null = null;
  try {
    batch = await enqueueQuoteCalls({ quoteRequestId: requestId });
  } catch (err) {
    log.error('enqueueQuoteCalls failed after skip-payment', { err, requestId });
    return NextResponse.json(
      {
        ok: false,
        note: 'Payment row written + request flipped to paid, but batch enqueue failed. Re-run /api/dev/trigger-call?request=<id> or the existing cron will pick it up.',
        error: err instanceof Error ? err.message : String(err),
        seed,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    quote_request_id: requestId,
    stripe_session_id: syntheticSession,
    status: 'paid',
    seed,
    batch,
    next: {
      success_url: `/get-quotes/success?request=${requestId}`,
      admin_url: `/admin/requests/${requestId}`,
    },
  });
}
