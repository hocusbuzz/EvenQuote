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
import { createLogger } from '@/lib/logger';

const log = createLogger('submitCleaningIntake');

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitCleaningIntake(raw: unknown): Promise<SubmitResult> {
  // 0. Rate limit parity with moving intake — 10/min/IP.
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
    return { ok: false, error: 'Cleaning category is unavailable. Please try again.' };
  }

  // 3. Check for an authenticated user (optional for guest flow)
  const user = await getUser();

  // 4. Insert. The cleaning address *is* the service location, so it
  //    goes straight onto the top-level city/state/zip_code columns.
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
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    log.error('insert failed', { err: insertErr, userId: user?.id ?? null });
    return { ok: false, error: 'Could not save your request. Please try again.' };
  }

  return { ok: true, requestId: inserted.id };
}
