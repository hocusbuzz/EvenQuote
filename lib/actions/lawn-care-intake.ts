'use server';

// Server action for submitting a completed lawn-care intake.
//
// Parallels lib/actions/handyman-intake.ts. Same flow:
//   1. Rate limit (10/min/IP, separate bucket from other verticals)
//   2. Re-validate with Zod (server never trusts client validation)
//   3. Look up the 'lawn-care' service category id
//   4. Insert a quote_request row with status='pending_payment'
//   5. Return the id so the client can redirect to checkout
//
// Primary location on quote_requests (city/state/zip_code) is the
// yard address — lawn care is single-location, so it drops straight
// onto the row. Same shape as cleaning + handyman.
//
// PII contract: Sentry tags carry {lib, reason, vertical} only —
// no user_id, no email, no phone, no address. See intake.ts (moving)
// for the full PII contract documentation.

import { headers } from 'next/headers';
import { LawnCareIntakeSchema, type LawnCareIntakeData } from '@/lib/forms/lawn-care-intake';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth';
import { rateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { isHoneypotTripped, HONEYPOT_GENERIC_ERROR } from '@/lib/security/honeypot';
import { verifyTurnstileToken } from '@/lib/security/turnstile';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('submitLawnCareIntake');

// Canonical Sentry tag shape shared with the other intake actions
// (intake.ts, cleaning-intake.ts, handyman-intake.ts). Kept as a
// literal-typed export so the regression-guard tests can assert no
// other reasons leak into Sentry from this action.
export type IntakeReason = 'categoryLookupFailed' | 'insertFailed';

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitLawnCareIntake(raw: unknown): Promise<SubmitResult> {
  // 0a. Honeypot — see lib/security/honeypot.ts + intake.ts (moving)
  // for the rationale. Same generic error so bots can't detect the trip.
  if (isHoneypotTripped(raw)) {
    log.info('honeypot tripped — silently dropping', {
      lib: 'intake',
      vertical: 'lawn-care',
    });
    return { ok: false, error: HONEYPOT_GENERIC_ERROR };
  }

  // 0b. Rate limit parity with the other verticals — 10/min/IP. Cross-
  // vertical buckets are intentionally separate (see intake-rate-limit-
  // audit.test.ts) so a moving-blocked IP can still submit lawn-care.
  const rl = rateLimit(clientKeyFromHeaders(headers(), 'intake:lawn-care'), {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Too many requests. Try again in ${rl.retryAfterSec}s.`,
    };
  }

  // 0c. Turnstile verify — see intake.ts (moving) for the rationale.
  const tsToken =
    raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).turnstile_token as string | undefined)
      : undefined;
  const ts = await verifyTurnstileToken({ token: tsToken });
  if (!ts.ok) {
    log.info('turnstile verify failed', {
      lib: 'intake',
      vertical: 'lawn-care',
      reason: ts.reason,
    });
    return { ok: false, error: HONEYPOT_GENERIC_ERROR };
  }

  // 1. Validate
  const parsed = LawnCareIntakeSchema.safeParse(raw);
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

  const data: LawnCareIntakeData = parsed.data;

  // 1b. Per-email throttle — see intake.ts (moving) for the rationale.
  const emailKey = `intake:email:${data.contact_email.toLowerCase()}`;
  const emailRl = rateLimit(emailKey, { limit: 5, windowMs: 24 * 60 * 60 * 1000 });
  if (!emailRl.ok) {
    log.info('per-email throttle tripped', { lib: 'intake', vertical: 'lawn-care' });
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
    .eq('slug', 'lawn-care')
    .eq('is_active', true)
    .single();

  if (catErr || !category) {
    log.error('lawn-care category not found', { err: catErr });
    if (catErr) {
      const msg =
        catErr && typeof catErr === 'object' && 'message' in catErr
          ? String((catErr as { message: unknown }).message)
          : String(catErr);
      captureException(new Error(`intake categoryLookupFailed: ${msg}`), {
        tags: { lib: 'intake', reason: 'categoryLookupFailed', vertical: 'lawn-care' },
      });
    }
    return { ok: false, error: 'Lawn care category is unavailable. Please try again.' };
  }

  // 3. Check for an authenticated user (optional for guest flow)
  const user = await getUser();

  // 4. Insert. The yard address is the service location, so it goes
  //    straight onto the top-level city/state/zip_code columns.
  //    lat/lng (when the user picked a Google prediction) get persisted
  //    to origin_lat/origin_lng — used by the on-demand business seeder
  //    and the radius selector. Nullable: manual entries lack coords.
  //
  //    utm_* columns: see intake.ts (moving) for the full rationale.
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
      tags: { lib: 'intake', reason: 'insertFailed', vertical: 'lawn-care' },
    });
    return { ok: false, error: 'Could not save your request. Please try again.' };
  }

  return { ok: true, requestId: inserted.id };
}
