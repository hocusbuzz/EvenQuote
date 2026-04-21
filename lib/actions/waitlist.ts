'use server';

// Waitlist signup for verticals we haven't built yet (handyman,
// lawn-care, etc). Writes to public.waitlist_signups; uniqueness on
// (category_id, email) dedupes retries silently.
//
// Insert is done via the service-role client because waitlist_signups
// has RLS on with no policies — nothing can write from a client session.
//
// The action intentionally returns `ok: true` even when the signup
// already existed, because from the user's perspective "you're on the
// list" is the same outcome either way.

import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';

export type WaitlistResult =
  | { ok: true; alreadyOnList: boolean }
  | { ok: false; error: string };

const WaitlistSchema = z.object({
  categorySlug: z.string().min(1),
  email: z.string().trim().toLowerCase().email('Valid email, please'),
  zipCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, 'Must be a 5-digit ZIP (or ZIP+4)')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

export async function joinWaitlist(raw: unknown): Promise<WaitlistResult> {
  const parsed = WaitlistSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? 'Invalid input' };
  }

  const { categorySlug, email, zipCode } = parsed.data;
  const admin = createAdminClient();

  // Look up the category — we store by id, not slug, so a category
  // rename/merger doesn't orphan signups.
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('id')
    .eq('slug', categorySlug)
    .maybeSingle();

  if (catErr || !category) {
    console.error('[joinWaitlist] unknown category', categorySlug, catErr);
    return { ok: false, error: 'That category isn\'t available yet.' };
  }

  const { error: insertErr } = await admin.from('waitlist_signups').insert({
    category_id: category.id,
    email,
    zip_code: zipCode ?? null,
  });

  if (insertErr) {
    // 23505 = unique_violation — already on the list, not an error.
    if ((insertErr as { code?: string }).code === '23505') {
      return { ok: true, alreadyOnList: true };
    }
    console.error('[joinWaitlist] insert failed', insertErr);
    return { ok: false, error: 'Could not save you to the waitlist. Try again?' };
  }

  return { ok: true, alreadyOnList: false };
}
