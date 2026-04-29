// Inbound match helper — given a caller phone (voice callback) or SMS
// sender, find the business + quote_request + existing outbound call
// the response belongs to.
//
// Used by:
//   • /api/vapi/inbound-callback — contractor called our number back
//     after getting the voicemail recap
//   • /api/twilio/sms          — contractor texted our number with
//                                their availability + price
//
// Matching strategy (in order):
//   1. Normalize the inbound phone (strip non-digits, drop leading 1).
//   2. Look up businesses where normalized(phone) matches. Multiple
//      businesses could share a phone if seed data has dupes — we pick
//      the one with the most recent outbound call to them.
//   3. Find the most recent calls row for that business where
//      counters_applied_at IS NOT NULL (we actually called them) AND
//      created_at within the last 14 days (stale responses are
//      discarded — the customer probably already got their report).
//   4. Read the quote_request on that call. If it's in a terminal
//      state ('completed', 'failed'), we still accept the quote — the
//      contractor just got back to us late, and the quote is still
//      worth something to the customer if they haven't acted yet.
//
// The helper returns a null match if no match is found. Callers then
// decide what to do — typically store the raw response in an
// "orphan callback" row (TODO: table not yet wired) so ops can
// manually reconcile.

import type { SupabaseClient } from '@supabase/supabase-js';
import { captureException } from '@/lib/observability/sentry';

export type InboundMatch = {
  businessId: string;
  businessName: string;
  quoteRequestId: string;
  /** ID of the ORIGINAL outbound calls row. Not reused, but useful
   *  for logging/observability so we can tie a callback to the
   *  outbound dial that triggered it. */
  outboundCallId: string;
  categorySlug: string | null;
  categoryName: string | null;
  /**
   * Shape of the category's extractionSchema JSONB so the callback
   * webhook can run the same per-vertical extraction prompt as the
   * outbound webhook.
   */
  extractionSchema: Record<string, unknown> | null;
};

/**
 * Normalize a US phone number to its 10-digit form. Mirrors the
 * normalizePhone used in select-businesses.ts. Returns '' on empty
 * input so callers can safely compare against other normalized forms.
 */
export function normalizeInboundPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * Find the most likely quote_request an inbound response belongs to.
 * Returns null if no plausible match exists.
 */
export async function matchInboundToQuoteRequest(
  admin: SupabaseClient,
  callerPhone: string
): Promise<InboundMatch | null> {
  const normalized = normalizeInboundPhone(callerPhone);
  if (!normalized) return null;

  // 1. Find candidate businesses by phone. Order doesn't matter here —
  //    we'll join to calls below and sort by call recency. We fetch up
  //    to 10 candidates to accommodate chains/dupes.
  const { data: businesses, error: bizErr } = await admin
    .from('businesses')
    .select('id, name, phone')
    .limit(20);
  if (bizErr) {
    // Lib-boundary capture. Both callers (twilio/sms + vapi/inbound-callback)
    // have route-level captureException fall-throughs — Sentry dedupes on
    // stack-trace fingerprint so this doesn't double-count, but it DOES add
    // a `lib:'match-inbound'` tag facet ops can alert on independently of
    // which route surfaced the error.
    //
    // Canonical tag shape (PII-free, strict key-set): the caller phone is
    // deliberately NOT in tags. If a business lookup fails there's no
    // quoteRequestId yet (we haven't matched anything) — the tag set is
    // just `{ lib, reason }`.
    const wrapped = new Error(`match-inbound businesses: ${bizErr.message}`);
    captureException(wrapped, {
      tags: { lib: 'match-inbound', reason: 'businessesLookupFailed' },
    });
    throw wrapped;
  }

  // Filter by normalized phone (the DB doesn't have a normalized
  // column, so we do this client-side — cheap for <20 rows).
  const candidates = (businesses ?? []).filter(
    (b) => normalizeInboundPhone(b.phone) === normalized
  );
  if (candidates.length === 0) return null;

  const businessIds = candidates.map((b) => b.id);

  // 2. Find the most recent outbound call to any of these businesses.
  //    counters_applied_at IS NOT NULL ensures we only match completed
  //    dials — a call we abandoned mid-flight shouldn't receive a
  //    callback from the business.
  const fourteenDaysAgo = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: calls, error: callsErr } = await admin
    .from('calls')
    .select(`
      id,
      business_id,
      quote_request_id,
      created_at,
      quote_requests (
        id,
        category_id,
        service_categories (
          slug,
          name,
          extraction_schema
        )
      )
    `)
    .in('business_id', businessIds)
    .not('counters_applied_at', 'is', null)
    .gte('created_at', fourteenDaysAgo)
    .order('created_at', { ascending: false })
    .limit(5);

  if (callsErr) {
    // Same lib-boundary capture rationale as the businesses lookup above.
    // Tag set here can carry the first candidate businessId (opaque UUID,
    // PII-free) — it scopes the dashboard alert to a specific row without
    // leaking the caller phone. We don't have a quoteRequestId yet (that's
    // what this query is trying to resolve), so omit it.
    const wrapped = new Error(`match-inbound calls: ${callsErr.message}`);
    captureException(wrapped, {
      tags: {
        lib: 'match-inbound',
        reason: 'callsLookupFailed',
        businessId: businessIds[0],
      },
    });
    throw wrapped;
  }
  if (!calls || calls.length === 0) return null;

  const top = calls[0] as unknown as {
    id: string;
    business_id: string;
    quote_request_id: string;
    quote_requests:
      | {
          id: string;
          category_id: string;
          service_categories:
            | { slug: string; name: string; extraction_schema: Record<string, unknown> | null }
            | Array<{ slug: string; name: string; extraction_schema: Record<string, unknown> | null }>
            | null;
        }
      | Array<{
          id: string;
          category_id: string;
          service_categories:
            | { slug: string; name: string; extraction_schema: Record<string, unknown> | null }
            | Array<{ slug: string; name: string; extraction_schema: Record<string, unknown> | null }>
            | null;
        }>
      | null;
  };

  const qr = Array.isArray(top.quote_requests) ? top.quote_requests[0] : top.quote_requests;
  const sc = qr
    ? Array.isArray(qr.service_categories)
      ? qr.service_categories[0]
      : qr.service_categories
    : null;

  const matchedBusiness = candidates.find((b) => b.id === top.business_id);

  return {
    businessId: top.business_id,
    businessName: matchedBusiness?.name ?? '(unknown)',
    quoteRequestId: top.quote_request_id,
    outboundCallId: top.id,
    categorySlug: sc?.slug ?? null,
    categoryName: sc?.name ?? null,
    extractionSchema: sc?.extraction_schema ?? null,
  };
}
