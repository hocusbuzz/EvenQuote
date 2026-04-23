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
//   1. Find quote_requests with status='processing'. Phase 7's
//      apply_call_end() flips a request into 'processing' once
//      total_calls_completed catches the planned batch size — that's
//      our signal that the call list is exhausted and it's time to
//      send the customer their report.
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
import {
  renderQuoteReport,
  type QuoteForReport,
  type QuoteReportInput,
  type RefundOutcome,
} from '@/lib/email/templates';
import { getStripe } from '@/lib/stripe/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('cron/send-reports');

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
    .eq('status', 'processing')
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

  const payload: QuoteReportInput = {
    recipientName: recipient.name,
    categoryName,
    city: request.city,
    state: request.state,
    coverageSummary,
    dashboardUrl,
    refundOutcome,
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

  // 6. Send.
  const send = await sendEmail({
    to: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'quote-report',
  });

  if (!send.ok) {
    // Leave status='processing' so the next run retries. Log loud so
    // sustained failure gets noticed.
    log.error('send failed', { requestId: request.id, err: send.error });
    return { status: 'failed', reason: send.error };
  }

  // 7. Stamp completion. If this update errors AFTER a successful
  // send, next run's `is('report_sent_at', null)` filter would re-send;
  // we log loudly so ops can manually reconcile.
  const { error: finalErr } = await admin
    .from('quote_requests')
    .update({
      report_sent_at: new Date().toISOString(),
      status: 'completed',
    })
    .eq('id', request.id);
  if (finalErr) {
    log.error('email sent but final stamp failed — will re-send next run', {
      requestId: request.id,
      emailId: send.id,
      err: finalErr.message,
    });
    return {
      status: 'failed',
      reason: `final stamp: ${finalErr.message}`,
    };
  }

  return { status: 'sent', email_id: send.id };
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
      err: payErr.message,
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
      err: updErr.message,
    });
  }

  return 'issued';
}
