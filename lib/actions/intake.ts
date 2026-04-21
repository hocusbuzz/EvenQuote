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
import { MovingIntakeSchema, type MovingIntakeData } from '@/lib/forms/moving-intake';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth';

export type SubmitResult =
  | { ok: true; requestId: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function submitMovingIntake(raw: unknown): Promise<SubmitResult> {
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
    console.error('[submitMovingIntake] moving category not found', catErr);
    return { ok: false, error: 'Moving category is unavailable. Please try again.' };
  }

  // 3. Check for an authenticated user (optional for guest flow)
  const user = await getUser();

  // 4. Insert the request.
  // The destination ZIP is stored as the primary location — that's where
  // they're moving to, which is also a reasonable default for "where
  // should we show you searchable businesses". (We also keep origin_zip
  // inside intake_data.)
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
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('[submitMovingIntake] insert failed', insertErr);
    return { ok: false, error: 'Could not save your request. Please try again.' };
  }

  return { ok: true, requestId: inserted.id };
}
