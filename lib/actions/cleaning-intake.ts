'use server';

// Server action for submitting a completed cleaning intake.
//
// Parallels lib/actions/intake.ts (moving). Same flow:
//   1. Re-validate with Zod.
//   2. Look up the 'cleaning' service category id.
//   3. Insert a quote_request row with status='pending_payment'.
//   4. Return the id so the client can redirect to checkout.
//
// Primary location on quote_requests (city/state/zip_code) is the
// cleaning address — unlike moving which has origin + destination,
// cleaning is one-location so it drops straight onto the row.

import { headers } from 'next/headers';
import { CleaningIntakeSchema, type CleaningIntakeData } from '@/lib/forms/cleaning-intake';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth';
import { rateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { isHoneypotTripped, HONEYPOT_GENERIC_ERROR } from '@/lib/security/honeypot';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('submitCleaningIntake');

// Canonical Sentry tag shape shared with intake.ts (moving). Keep
// `IntakeReason` imported from that file? No — server-only modules and
// a cross-import would create a circular dep through lib/forms. Locally
// re-declare; the regression-guard tests in both files lock the same
// value set so a drift between the two is caught at CI.
export type IntakeReason = 'categoryLookupFailed' | 'insertFailed';

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitCleaningIntake(raw: unknown): Promise<SubmitResult> {
  // 0a. Honeypot — see lib/security/honeypot.ts + intake.ts (moving)
  // for the rationale. Same generic error so bots can't detect the trip.
  if (isHoneypotTripped(raw)) {
    log.info('honeypot tripped — silently dropping', {
      lib: 'intake',
      vertical: 'cleaning',
    });
    return { ok: false, error: HONEYPOT_GENERIC_ERROR };
  }

  // 0b. Rate limit parity with moving intake — 10/min/IP.
  const rl = rateLimit(clientKeyFromHeaders(headers(), 'intake:cleaning'), {
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
  const parsed = CleaningIntakeSchema.safeParse(raw);
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

  const data: CleaningIntakeData = parsed.data;

  // 1b. Per-email throttle — see intake.ts (moving) for the rationale.
  const emailKey = `intake:email:${data.contact_email.toLowerCase()}`;
  const emailRl = rateLimit(emailKey, { limit: 5, windowMs: 24 * 60 * 60 * 1000 });
  if (!emailRl.ok) {
    log.info('per-email throttle tripped', { lib: 'intake', vertical: 'cleaning' });
    return {
      ok: false,
      error: `Too many requests for this email. Try again in ${Math.ceil(emailRl.retryAfterSec / 3600)}h.`,
    };
  }

  // 2. Get category id
  const admin = createAdminClient();
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('id')
    .eq('slug', 'cleaning')
    .eq('is_active', true)
    .single();

  if (catErr || !category) {
    log.error('cleaning category not found', { err: catErr });
    if (catErr) {
      const msg =
        catErr && typeof catErr === 'object' && 'message' in catErr
          ? String((catErr as { message: unknown }).message)
          : String(catErr);
      captureException(new Error(`intake categoryLookupFailed: ${msg}`), {
        tags: { lib: 'intake', reason: 'categoryLookupFailed', vertical: 'cleaning' },
      });
    }
    return { ok: false, error: 'Cleaning category is unavailable. Please try again.' };
  }

  // 3. Check for an authenticated user (optional for guest flow)
  const user = await getUser();

  // 4. Insert. The cleaning address *is* the service location, so it
  //    goes straight onto the top-level city/state/zip_code columns.
  //    lat/lng (when the user picked a Google prediction) get persisted
  //    to origin_lat/origin_lng — used by the on-demand business seeder
  //    and the radius selector. Nullable: manual entries lack coords.
  //
  //    utm_* columns: see intake.ts (moving) for the full rationale —
  //    captured by utm-capture.tsx, merged into payload at submit,
  //    persisted both inside intake_data jsonb and as dedicated
  //    columns for indexable cohort/CAC analysis.
  const { data: inserted, error: insertErr } = await admin
    .from('quote_requests')
    .insert({
      user_id: user?.id ?? null,
      category_id: category.id,
      status: 'pending_payment',
      intake_data: data,
      city: data.city,
      state: data.state,
      zip_code: data.zip,
      origin_lat: data.lat ?? null,
      origin_lng: data.lng ?? null,
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
    const msg =
      insertErr && typeof insertErr === 'object' && 'message' in insertErr
        ? String((insertErr as { message: unknown }).message)
        : insertErr
          ? String(insertErr)
          : 'insert returned no row';
    captureException(new Error(`intake insertFailed: ${msg}`), {
      tags: { lib: 'intake', reason: 'insertFailed', vertical: 'cleaning' },
    });
    return { ok: false, error: 'Could not save your request. Please try again.' };
  }

  return { ok: true, requestId: inserted.id };
}
