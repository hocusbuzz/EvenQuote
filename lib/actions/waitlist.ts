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
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertRateLimitFromHeaders } from '@/lib/security/rate-limit-auth';
import { createLogger } from '@/lib/logger';
import { EmailSchema, ZipSchema } from '@/lib/forms/moving-intake';
import { isHoneypotTripped, HONEYPOT_GENERIC_ERROR } from '@/lib/security/honeypot';

const log = createLogger('joinWaitlist');

export type WaitlistResult =
  | { ok: true; alreadyOnList: boolean }
  | { ok: false; error: string };

// Email + ZIP pulled from the shared primitives in moving-intake.ts so
// the chain order / regex / error copy stay consistent with every
// other email + ZIP field across the product (R45(d)).
const WaitlistSchema = z.object({
  categorySlug: z.string().min(1),
  email: EmailSchema,
  zipCode: ZipSchema
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

export async function joinWaitlist(raw: unknown): Promise<WaitlistResult> {
  // Honeypot: same hidden-field bot trap used on the intake actions.
  // Returns the same generic copy a real save-failure would so the
  // bot can't iterate around it.
  if (isHoneypotTripped(raw)) {
    log.info('honeypot tripped — silently dropping', { lib: 'waitlist' });
    return { ok: false, error: HONEYPOT_GENERIC_ERROR };
  }

  // Rate limit: 5 signups per minute per IP. The endpoint returns "already
  // on list" silently on dup-insert, so a scraper can't distinguish new
  // signups from repeats — but we still don't want a firehose overwhelming
  // us. Tight limit is appropriate: a real user hits this once, then maybe
  // once more if they mistype.
  //
  // Using the shared `assertRateLimitFromHeaders` helper instead of the
  // low-level rateLimit() call keeps the deny path consistent with the
  // route-handler version (`assertRateLimit`) — same prefix namespacing,
  // same token-bucket backing store. When we swap to Upstash (user-input
  // #2), the migration is a one-file change in lib/rate-limit.ts.
  const deny = assertRateLimitFromHeaders(headers(), {
    prefix: 'waitlist',
    limit: 5,
    windowMs: 60_000,
  });
  if (deny) {
    return {
      ok: false,
      error: `Too many requests. Try again in ${deny.retryAfterSec}s.`,
    };
  }

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
    log.error('unknown category', { categorySlug, err: catErr });
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
    log.error('insert failed', { err: insertErr, categorySlug });
    return { ok: false, error: 'Could not save you to the waitlist. Try again?' };
  }

  return { ok: true, alreadyOnList: false };
}
