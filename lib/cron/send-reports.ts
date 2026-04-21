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
//   2. For each request: load the quotes + join business names,
//      render the report template, send via Resend.
//   3. On successful send: stamp report_generated_at, report_data,
//      report_sent_at, flip status → 'completed'.
//   4. On failed send: leave status='processing' so the next run
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
} from '@/lib/email/templates';

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

  // 3. Compose the email.
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

  // 4. Persist a snapshot BEFORE sending so we have a durable record
  // of what went out even if the mail provider's response is lost.
  const reportData = {
    generated_at: new Date().toISOString(),
    category_name: categoryName,
    coverage_summary: coverageSummary,
    quote_count: quotes.length,
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

  // 5. Send.
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
    console.error(
      `[cron/send-reports] send failed for ${request.id}: ${send.error}`
    );
    return { status: 'failed', reason: send.error };
  }

  // 6. Stamp completion. If this update errors AFTER a successful
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
    console.error(
      `[cron/send-reports] email sent (${send.id}) but final stamp failed for ${request.id}: ${finalErr.message}`
    );
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
