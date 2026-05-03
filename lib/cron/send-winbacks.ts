// Win-back email cron — re-engages satisfied past customers.
//
// Daily tick selects up to 50 quote_requests where:
//   • status='completed' (we delivered — don't pester refunded customers)
//   • created_at BETWEEN now()-30d AND now()-7d (not too fresh, not too stale)
//   • win_back_sent_at IS NULL (this row hasn't triggered a send yet)
//   • user_id IS NOT NULL (skip guest requests — no profile email to thread on)
//   • NO newer quote_request for the same user_id (skip already-engaged customers)
//   • NO win_back_sent_at on ANY of this user's other requests within
//     the last 60 days (per-user cooldown, prevents over-emailing
//     customers with multiple historical requests)
//
// For each: fetch profile email + name, render renderWinBack template,
// send via Resend, stamp win_back_sent_at on success. Failures don't
// throw — they leave win_back_sent_at NULL so the next tick retries.
//
// Cap at 50/run to keep the daily budget bounded; at scale this becomes
// a 'paginate by stamped order' loop, but for the launch window 50 per
// day is far more headroom than we'll have customers.
//
// CADENCE
// ───────
// Scheduled daily at 17:00 UTC (= 10:00 PT, 13:00 ET, 09:00 if DST is
// off). Why morning Pacific: weekday business inbox window for the
// largest US time zone overlap. Sent more than once per day would risk
// an over-eager triple-fire from a manual cron edit; daily is enough.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/resend';
import { renderWinBack } from '@/lib/email/templates';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/send-winbacks');

// Allow-listed reasons for Sentry facets / dashboards. Keep narrow.
export type CronWinBackReason =
  | 'candidateQueryFailed'
  | 'sendFailed'
  | 'stampFailed';

// How many days a request has to age before we consider it for win-back.
// 7 days = enough that the customer has had time to use the report,
// not so long that the experience is forgotten.
const MIN_AGE_DAYS = 7;

// Upper bound on age. Stale requests don't make for compelling win-
// back triggers — if the customer hasn't come back in 30 days they
// probably won't from one nudge. Saves us from emailing a 6-month-old
// "remember us?" cold-blast.
const MAX_AGE_DAYS = 30;

// Per-user cooldown — don't re-engage a customer who got a win-back
// recently, no matter how many historical requests they have. 60 days
// is conservative; can tighten if data later shows the second win-back
// also converts.
const PER_USER_COOLDOWN_DAYS = 60;

// Cap per tick. See file header for rationale.
const MAX_PER_RUN = 50;

export type WinBackRunResult = {
  ok: boolean;
  scanned: number;
  sent: number;
  skipped: number;
  failed: number;
  notes: string[];
};

type Candidate = {
  id: string;
  user_id: string;
  city: string;
  state: string;
  created_at: string;
  service_categories: { name: string; slug: string } | null;
};

export async function sendWinBacks(
  admin: SupabaseClient,
): Promise<WinBackRunResult> {
  const notes: string[] = [];

  const minAgeIso = new Date(
    Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const maxAgeIso = new Date(
    Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const cooldownIso = new Date(
    Date.now() - PER_USER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Pull candidates. The "no newer request for this user" and "no
  // recent win-back for this user" filters are too complex for a single
  // PostgREST query — we pull the candidate set then filter client-side
  // per row. At MAX_PER_RUN=50 this is cheap.
  const { data: rows, error } = await admin
    .from('quote_requests')
    .select(
      `id, user_id, city, state, created_at,
       service_categories:category_id ( name, slug )`,
    )
    .eq('status', 'completed')
    .lte('created_at', minAgeIso)
    .gte('created_at', maxAgeIso)
    .is('win_back_sent_at', null)
    .not('user_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_PER_RUN);

  if (error) {
    log.error('candidate query failed', { err: error });
    captureException(new Error(error.message), {
      tags: {
        lib: 'cron-send-winbacks',
        reason: 'candidateQueryFailed' satisfies CronWinBackReason,
      },
    });
    return {
      ok: false,
      scanned: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      notes: [`candidate query: ${error.message}`],
    };
  }

  const candidates = (rows ?? []) as unknown as Array<
    Candidate & {
      service_categories:
        | Candidate['service_categories']
        | Array<NonNullable<Candidate['service_categories']>>
        | null;
    }
  >;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of candidates) {
    // Per-user filter 1: did this user place a NEWER request after the
    // candidate one? If yes, they're already re-engaged — skip.
    const { count: newerCount } = await admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', row.user_id)
      .gt('created_at', row.created_at);
    if ((newerCount ?? 0) > 0) {
      skipped += 1;
      notes.push(`request ${row.id}: user has newer request — already re-engaged`);
      continue;
    }

    // Per-user filter 2: have we sent a win-back to ANY of this user's
    // requests within the cooldown window? If yes, skip.
    const { count: recentSendCount } = await admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', row.user_id)
      .gte('win_back_sent_at', cooldownIso);
    if ((recentSendCount ?? 0) > 0) {
      skipped += 1;
      notes.push(
        `request ${row.id}: user already received a win-back within ${PER_USER_COOLDOWN_DAYS}d`,
      );
      continue;
    }

    // Resolve recipient. Profile email is the source of truth (the
    // address they signed in with) — intake.contact_email is a guess
    // that might predate a profile change.
    const { data: profile } = await admin
      .from('profiles')
      .select('email, full_name')
      .eq('id', row.user_id)
      .maybeSingle();
    if (!profile?.email) {
      skipped += 1;
      notes.push(`request ${row.id}: no profile email`);
      continue;
    }

    const sc = Array.isArray(row.service_categories)
      ? row.service_categories[0]
      : row.service_categories;
    if (!sc) {
      skipped += 1;
      notes.push(`request ${row.id}: missing category join`);
      continue;
    }

    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const daysSince = Math.max(MIN_AGE_DAYS, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ??
      'https://evenquote.com';
    // utm tags so the conversion attribution stays clean — wins back
    // through this channel show up as utm_campaign=winback in GA4 + Meta.
    const ctaUrl = `${baseUrl}/get-quotes/${sc.slug}?utm_source=evenquote&utm_medium=email&utm_campaign=winback`;

    const rendered = renderWinBack({
      recipientName: profile.full_name ?? null,
      categoryName: sc.name,
      categorySlug: sc.slug,
      location: `${row.city}, ${row.state}`,
      daysSincePriorRequest: daysSince,
      ctaUrl,
    });

    const send = await sendEmail({
      to: profile.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tag: 'win-back',
    });

    if (!send.ok) {
      failed += 1;
      log.error('win-back send failed', { requestId: row.id, err: send.error });
      captureException(new Error(`win-back send: ${send.error}`), {
        tags: {
          lib: 'cron-send-winbacks',
          reason: 'sendFailed' satisfies CronWinBackReason,
          requestId: row.id,
        },
      });
      // Don't stamp win_back_sent_at — leave the row eligible for next
      // tick. Resend transient failures are common; reattempt is fine.
      continue;
    }

    // Stamp on success. A failure here is a book-keeping issue (email
    // sent, DB doesn't reflect it) which means the next tick will
    // re-send. Capture so ops can intervene.
    const stampedAt = new Date().toISOString();
    const { error: stampErr } = await admin
      .from('quote_requests')
      .update({ win_back_sent_at: stampedAt })
      .eq('id', row.id);
    if (stampErr) {
      log.error('win-back stamp failed AFTER send', {
        requestId: row.id,
        err: stampErr,
      });
      captureException(new Error(`win-back stamp: ${stampErr.message}`), {
        tags: {
          lib: 'cron-send-winbacks',
          reason: 'stampFailed' satisfies CronWinBackReason,
          requestId: row.id,
        },
      });
      // Still count as sent — the email DID go out.
    }

    sent += 1;
    notes.push(`request ${row.id}: sent to ${profile.email}`);
  }

  return {
    ok: true,
    scanned: candidates.length,
    sent,
    skipped,
    failed,
    notes,
  };
}
