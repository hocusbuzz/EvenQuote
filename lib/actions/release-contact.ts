'use server';

// Phase 8 — customer opts to release their contact info to a specific
// business whose quote they liked. This is the ONLY code path that
// forwards customer PII (name / phone / email) to a business.
//
// Flow:
//   1. Validate the current user owns the quote (via RLS-aware client).
//   2. Re-read the relevant context with the service-role client
//      (quote + business + the owning quote_request's intake_data).
//   3. Short-circuit if already released — idempotent, safe to retry.
//   4. Compose the email via lib/email/templates.ts and send via Resend.
//   5. Stamp quotes.contact_released_at and insert an audit row.
//
// Error posture:
//   • Ownership failure → return { ok: false, error } without leaking why.
//   • Send failure      → don't set contact_released_at, DO insert an
//                         audit row with email_error so ops can resend.
//   • DB failure after a successful send → log loud. The business
//     already has the email; we don't want to double-send on retry, so
//     the audit row (inserted before the stamp) is the source of truth
//     for "did this release go out".
//
// PII handling: we never log the full email body; only the message id,
// business id, and release id.

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendEmail } from '@/lib/email/resend';
import {
  renderContactRelease,
  type ContactReleaseInput,
} from '@/lib/email/templates';
import { revalidatePath } from 'next/cache';
import { createLogger } from '@/lib/logger';

const log = createLogger('releaseContact');

export type ReleaseContactResult =
  | { ok: true; alreadyReleased: boolean; releaseId: string }
  | { ok: false; error: string };

export async function releaseContactToBusiness(
  quoteId: string
): Promise<ReleaseContactResult> {
  if (!quoteId || typeof quoteId !== 'string') {
    return { ok: false, error: 'Missing quoteId' };
  }

  // 1. Auth: use the cookie-bound client so RLS enforces ownership.
  const ssr = await createClient();
  const {
    data: { user },
    error: userErr,
  } = await ssr.auth.getUser();
  if (userErr || !user) {
    return { ok: false, error: 'Not signed in' };
  }

  // The "quotes: owner read via request" policy means this will
  // return null if the quote doesn't belong to this user — which is
  // exactly the ownership check we want. We only need a few columns
  // for the check; the full read happens via the admin client below.
  const { data: owned, error: ownedErr } = await ssr
    .from('quotes')
    .select('id, contact_released_at')
    .eq('id', quoteId)
    .maybeSingle();
  if (ownedErr) {
    log.error('ownership check failed', { err: ownedErr, quoteId });
    return { ok: false, error: 'Could not verify this quote' };
  }
  if (!owned) {
    // Don't reveal existence/ownership split — always the same message.
    return { ok: false, error: "We couldn't find that quote on your account" };
  }

  // Idempotency — already released. Safe retry path.
  if (owned.contact_released_at) {
    const admin0 = createAdminClient();
    const { data: existing } = await admin0
      .from('quote_contact_releases')
      .select('id')
      .eq('quote_id', quoteId)
      .maybeSingle();
    return {
      ok: true,
      alreadyReleased: true,
      releaseId: existing?.id ?? '',
    };
  }

  // Defense-in-depth against the "send OK, stamp failed" double-send race.
  //
  // The happy-path order below is: send email → insert audit row (with
  // email_send_id) → stamp quotes.contact_released_at. If the final stamp
  // fails (DB blip, RLS hiccup), a retry would see contact_released_at
  // still NULL and re-send the PII to the business — a second, identical
  // lead email is both annoying and, worse, a silent duplicate PII
  // disclosure the customer never consented to.
  //
  // The audit row IS the source of truth for "did the email already go
  // out". It is inserted with a non-null email_send_id only on the
  // success path (the failure path inserts a row with email_error set
  // but email_send_id null). So: if we find a row for this quote with
  // email_send_id IS NOT NULL, the send already happened — short-circuit
  // as if already-released, and best-effort re-stamp contact_released_at
  // so subsequent calls take the cheap early-return path above.
  //
  // This check intentionally runs BEFORE the expensive context load
  // and before composing/sending any email.
  const admin = createAdminClient();

  const { data: priorSend } = await admin
    .from('quote_contact_releases')
    .select('id, email_send_id')
    .eq('quote_id', quoteId)
    .not('email_send_id', 'is', null)
    .maybeSingle();
  if (priorSend?.email_send_id) {
    // Repair the missing stamp (best-effort — failure here is fine,
    // because this same pre-check will catch the next retry).
    const { error: repairErr } = await admin
      .from('quotes')
      .update({ contact_released_at: new Date().toISOString() })
      .eq('id', quoteId)
      .is('contact_released_at', null);
    if (repairErr) {
      log.warn('contact_released_at repair failed (non-fatal)', {
        err: repairErr,
        quoteId,
      });
    }
    return {
      ok: true,
      alreadyReleased: true,
      releaseId: priorSend.id,
    };
  }

  const { data: quote, error: quoteErr } = await admin
    .from('quotes')
    .select(
      `
      id,
      quote_request_id,
      business_id,
      price_min,
      price_max,
      price_description,
      availability,
      notes,
      requires_onsite_estimate
    `
    )
    .eq('id', quoteId)
    .single();
  if (quoteErr || !quote) {
    log.error('quote load failed', { err: quoteErr, quoteId });
    return { ok: false, error: 'Could not load the quote' };
  }

  const { data: request, error: reqErr } = await admin
    .from('quote_requests')
    .select(
      `
      id,
      user_id,
      city,
      state,
      intake_data,
      category:service_categories!quote_requests_category_id_fkey(name, slug)
    `
    )
    .eq('id', quote.quote_request_id)
    .single();
  if (reqErr || !request) {
    log.error('request load failed', { err: reqErr, requestId: quote.quote_request_id });
    return { ok: false, error: 'Could not load the request' };
  }

  // Defense-in-depth: RLS already filtered, but double-check here in
  // case someone ever switches to admin for the initial read.
  if (request.user_id && request.user_id !== user.id) {
    return { ok: false, error: "We couldn't find that quote on your account" };
  }

  const { data: business, error: bizErr } = await admin
    .from('businesses')
    .select('id, name, email, phone')
    .eq('id', quote.business_id)
    .single();
  if (bizErr || !business) {
    log.error('business load failed', { err: bizErr, businessId: quote.business_id });
    return { ok: false, error: 'Could not load the business' };
  }
  if (!business.email) {
    // Can't forward a lead without an email address. Non-fatal to the
    // user but there's nothing we can do here — flag it and bail.
    log.warn('business has no email', { businessId: business.id });
    return {
      ok: false,
      error: 'This pro does not have an email on file — support can help.',
    };
  }

  // Pull customer contact out of intake_data. We stored these at
  // submit time (see lib/forms/*-intake.ts). Be tolerant: if any are
  // missing we can't compose a useful release email.
  const intake = (request.intake_data ?? {}) as Record<string, unknown>;
  const customerName = stringOrNull(intake['contact_name']);
  const customerPhone = stringOrNull(intake['contact_phone']);
  const customerEmail = stringOrNull(intake['contact_email']);
  if (!customerName || !customerPhone || !customerEmail) {
    log.warn('intake missing contact fields', {
      requestId: quote.quote_request_id,
    });
    return {
      ok: false,
      error: 'Your contact info is missing from the request — please contact support.',
    };
  }

  const categoryRaw = (request as { category?: unknown }).category;
  const category = Array.isArray(categoryRaw) ? categoryRaw[0] : categoryRaw;
  const categoryName = (category as { name?: string } | null)?.name ?? 'service';

  // 3. Compose the email.
  const payload: ContactReleaseInput = {
    businessName: business.name,
    customerName,
    customerPhone,
    customerEmail,
    categoryName,
    city: request.city,
    state: request.state,
    jobSummary: summarizeIntake(intake),
    quoteSummary: summarizeQuote(quote),
  };
  const rendered = renderContactRelease(payload);

  // 4. Send.
  const send = await sendEmail({
    to: business.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: customerEmail,
    tag: 'contact-release',
  });

  if (!send.ok) {
    // Log audit + bail. No stamp on the quote — the customer can retry.
    await admin.from('quote_contact_releases').insert({
      quote_id: quote.id,
      quote_request_id: quote.quote_request_id,
      business_id: business.id,
      released_by_user_id: user.id,
      email_simulated: false,
      email_error: send.error,
    });
    return { ok: false, error: 'Could not send the email. Please try again.' };
  }

  // 5. Stamp + audit. Order matters: insert audit FIRST so that a
  // crash between the two still leaves a trail of the send.
  const { data: audit, error: auditErr } = await admin
    .from('quote_contact_releases')
    .insert({
      quote_id: quote.id,
      quote_request_id: quote.quote_request_id,
      business_id: business.id,
      released_by_user_id: user.id,
      email_send_id: send.id,
      email_simulated: send.simulated,
    })
    .select('id')
    .single();
  if (auditErr) {
    // Email went out; audit row failed. Loud log so ops notices — we
    // can reconcile against Resend's send logs.
    log.error('audit insert failed', {
      err: auditErr,
      quoteId,
      sendId: send.id,
    });
  }

  const { error: stampErr } = await admin
    .from('quotes')
    .update({ contact_released_at: new Date().toISOString() })
    .eq('id', quote.id);
  if (stampErr) {
    log.error('stamp failed', { err: stampErr, quoteId });
  }

  // Refresh the request detail page so the button flips to "shared".
  revalidatePath(`/dashboard/requests/${quote.quote_request_id}`);

  return {
    ok: true,
    alreadyReleased: false,
    releaseId: audit?.id ?? '',
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function stringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Build a 2-5 bullet summary of the job from intake_data. We're
 * deliberately conservative: if a known field exists, surface it; if
 * not, skip it. Never dump the whole jsonb into an email.
 */
function summarizeIntake(intake: Record<string, unknown>): string[] {
  const bullets: string[] = [];

  // Moving-style
  const origin = stringOrNull(intake['origin_city']);
  const dest = stringOrNull(intake['destination_city']);
  if (origin && dest && origin !== dest) {
    bullets.push(`Moving from ${origin} to ${dest}`);
  }
  const moveDate = stringOrNull(intake['move_date']);
  if (moveDate) bullets.push(`Target date: ${moveDate}`);
  const homeSize = stringOrNull(intake['home_size']);
  if (homeSize) bullets.push(`Home size: ${homeSize}`);

  // Cleaning-style
  const cleaningType = stringOrNull(intake['cleaning_type']);
  if (cleaningType) bullets.push(`Type: ${cleaningType}`);
  // `bathrooms` is a BathroomsSchema enum string ('1', '1.5', ..., '4+')
  // per lib/forms/cleaning-intake.ts — surface it when present.
  // (An earlier version also read `bedrooms`, which is NOT in either
  //  Zod schema; that was silent drift. Removed R41(b).)
  const bathrooms = stringOrNull(intake['bathrooms']);
  if (bathrooms) bullets.push(`${bathrooms} bath`);

  // Generic notes field — if present, add once. Canonical key is
  // `additional_notes` per both intake Zod schemas. Earlier versions
  // read `intake['notes']` which was always undefined; fixed in R41(b).
  const notes = stringOrNull(intake['additional_notes']);
  if (notes) bullets.push(notes.slice(0, 180));

  // Always cap at 5 bullets so the email stays readable.
  return bullets.slice(0, 5);
}

function summarizeQuote(quote: {
  price_min: number | null;
  price_max: number | null;
  price_description: string | null;
  availability: string | null;
  requires_onsite_estimate: boolean;
}): string {
  if (quote.requires_onsite_estimate) {
    return 'On-site estimate requested';
  }
  const parts: string[] = [];
  if (quote.price_min != null && quote.price_max != null) {
    if (quote.price_min === quote.price_max) {
      parts.push(`$${fmt(quote.price_min)}`);
    } else {
      parts.push(`$${fmt(quote.price_min)}–$${fmt(quote.price_max)}`);
    }
  } else if (quote.price_min != null) {
    parts.push(`from $${fmt(quote.price_min)}`);
  } else if (quote.price_max != null) {
    parts.push(`up to $${fmt(quote.price_max)}`);
  }
  if (quote.price_description) parts.push(quote.price_description);
  if (quote.availability) parts.push(`(avail: ${quote.availability})`);
  return parts.join(' ') || 'See quote for details';
}

function fmt(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
