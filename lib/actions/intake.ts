'use server';

// Server action for submitting a completed moving intake.
//
// Flow:
//   1. Re-validate with Zod (never trust client-side validation alone).
//   2. Look up the 'moving' service category ID.
//   3. Create the quote_request row with status='pending_payment'.
//      We always write via the admin (service-role) client so that
//      both guest AND authenticated submissions work uniformly —
//      RLS forbids direct inserts per our Phase 1 policy design.
//   4. If the user is signed in, attach their profile id. If not, the
//      user_id stays null for now; Phase 5 checkout will require sign-in
//      and link the request at that point.
//   5. Return the new request id so the client can redirect to checkout.
//
// This action deliberately does NOT charge Stripe yet — that's Phase 5.
// For now, successful submission just parks a pending_payment row in
// the DB and hands the id back to the client to redirect.
//
// Important schema note: our Phase 1 quote_requests table has
// user_id NOT NULL. For Phase 4 (guest flow), we need to make that
// nullable — see migrations/0002_guest_quote_requests.sql shipped
// with this phase.

import { z } from 'zod';
import { headers } from 'next/headers';
import { MovingIntakeSchema, type MovingIntakeData } from '@/lib/forms/moving-intake';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth';
import { rateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('submitMovingIntake');

// ── Canonical Sentry tag shape for this lib ──
// Mirrors the R28 checkout.ts / R26 extract-quote.ts convention of a
// lib+reason tag pair, with `vertical` to distinguish moving/cleaning
// in Sentry facets. If intake starts failing for one vertical only,
// a merged reason would mask that — a category_id rename on a single
// category table row would hit only one surface.
//
// Reasons:
//   - categoryLookupFailed  → DB error while selecting service_categories.
//     NOT raised when the row simply doesn't match filters (is_active=false,
//     renamed slug) — that's a config state, not an incident, and capturing
//     it would flood Sentry on intentional category pauses.
//   - insertFailed          → quote_requests insert returned an error.
//     RLS-deny, schema drift, check-constraint violation — all worth an alert.
//     User-facing message stays generic ("Could not save..."); tag carries
//     the telemetry without leaking to the page.
//
// PII contract: tags carry `{lib, reason, vertical}` only. No user_id,
// no email, no phone, no address — Sentry tags are search-indexed and
// the blast radius of a tag-level PII leak is wider than a message
// leak. See resend.ts for the same contract.
export type IntakeReason = 'categoryLookupFailed' | 'insertFailed';

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitMovingIntake(raw: unknown): Promise<SubmitResult> {
  // 0. Rate limit: 10 intake submissions per minute per IP. Higher than
  // the waitlist because a real user often submits once per device and
  // rarely more, but the intake form has multiple steps so a single
  // hesitant user might retry a couple times. Anything past 10 is bot-shaped.
  const rl = rateLimit(clientKeyFromHeaders(headers(), 'intake:moving'), {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Too many requests. Try again in ${rl.retryAfterSec}s.`,
    };
  }

  // 1. Validate
  const parsed = MovingIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.');
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      error: 'Please review the highlighted fields.',
      fieldErrors,
    };
  }

  const data: MovingIntakeData = parsed.data;

  // 2. Get category id
  const admin = createAdminClient();
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('id')
    .eq('slug', 'moving')
    .eq('is_active', true)
    .single();

  if (catErr || !category) {
    log.error('moving category not found', { err: catErr });
    // Only capture when the DB returned an error. Missing-row (RLS filter
    // mismatch, is_active=false) is a config state, not an incident —
    // capturing it would flood on intentional category pauses.
    if (catErr) {
      const msg =
        catErr && typeof catErr === 'object' && 'message' in catErr
          ? String((catErr as { message: unknown }).message)
          : String(catErr);
      captureException(new Error(`intake categoryLookupFailed: ${msg}`), {
        tags: { lib: 'intake', reason: 'categoryLookupFailed', vertical: 'moving' },
      });
    }
    return { ok: false, error: 'Moving category is unavailable. Please try again.' };
  }

  // 3. Check for an authenticated user (optional for guest flow)
  const user = await getUser();

  // 4. Insert the request.
  // The destination ZIP is stored as the primary location — that's where
  // they're moving to, which is also a reasonable default for "where
  // should we show you searchable businesses". (We also keep origin_zip
  // inside intake_data.)
  //
  // origin_lat/lng on quote_requests = destination coords for movers,
  // because the call engine seeds + selects businesses around the
  // service location, not where the customer is moving from. Both
  // nullable — manual address entries can lack them and the seeder
  // falls back to a city-name geocoded query.
  // utm_* columns (migration 0015): also present inside intake_data
  // because UtmsSchema is merged into MovingIntakeSchema; the dedicated
  // columns make CAC / cohort SQL trivially indexable without jsonb
  // path operators. Both surfaces stay in sync because they come from
  // the same parsed payload — see lib/marketing/utms-store.ts for
  // capture and components/get-quotes/form-shell.tsx for merge-at-submit.
  const { data: inserted, error: insertErr } = await admin
    .from('quote_requests')
    .insert({
      user_id: user?.id ?? null,
      category_id: category.id,
      status: 'pending_payment',
      intake_data: data,
      city: data.destination_city,
      state: data.destination_state,
      zip_code: data.destination_zip,
      origin_lat: data.destination_lat ?? null,
      origin_lng: data.destination_lng ?? null,
      utm_source: data.utm_source ?? null,
      utm_medium: data.utm_medium ?? null,
      utm_campaign: data.utm_campaign ?? null,
      utm_content: data.utm_content ?? null,
      utm_term: data.utm_term ?? null,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    log.error('insert failed', { err: insertErr, userId: user?.id ?? null });
    // Insert failures are always worth an alert — RLS/schema/constraint
    // drift all manifest here and silently return "Could not save" to
    // the user with zero operator visibility pre-R29.
    const msg =
      insertErr && typeof insertErr === 'object' && 'message' in insertErr
        ? String((insertErr as { message: unknown }).message)
        : insertErr
          ? String(insertErr)
          : 'insert returned no row';
    captureException(new Error(`intake insertFailed: ${msg}`), {
      tags: { lib: 'intake', reason: 'insertFailed', vertical: 'moving' },
    });
    return { ok: false, error: 'Could not save your request. Please try again.' };
  }

  return { ok: true, requestId: inserted.id };
}
