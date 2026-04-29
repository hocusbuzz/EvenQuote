// Stuck-request watchdog.
//
// Finds quote_requests that have been parked in `paid` / `calling` /
// `processing` past their SLA — symptoms of a webhook drop, a Vapi
// hang, or a send-reports cron that's not firing. Emails the ops
// inbox so the operator hears about it in <15 min instead of from a
// support reply a day later.
//
// Thresholds:
//   paid       — flagged after 15 min  (call engine should pick up
//                within ~30s; 15 min = real problem)
//   calling    — flagged after 25 min  (10 calls × ~3 min cap = 30
//                min worst case + slack)
//   processing — flagged after 60 min  (send-reports runs every 5 min;
//                an hour means it's not running at all)
//
// Volume model: at pre-launch volume (≤50/day) ≥1 stuck rows is rare
// enough that the un-deduplicated 15-min cron tick is appropriate.
// If you find yourself getting the same alert hourly, that's signal
// the underlying issue isn't being addressed — not noise to silence.
// Add row-level snooze (quote_requests.stuck_alert_sent_at) when
// volume justifies it.
//
// Deliberately uses sendEmail (Resend) rather than Sentry — the
// audience is "Antonio holding a phone", not the error tracker.
// Sentry already captures the underlying failures (Vapi webhook
// signature errors, Stripe webhook drops) when they happen at the
// integration boundary.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/resend';
import {
  renderStuckRequestsAlert,
  type StuckRequestRow,
} from '@/lib/email/templates';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/check-stuck-requests');

// Stuck thresholds in minutes. Default 15 / 25 / 60. Tunable via env
// if pre-launch testing surfaces a chronically-slow stage that's
// false-positive-y.
const PAID_MIN = Number(process.env.STUCK_PAID_MINUTES ?? '15');
const CALLING_MIN = Number(process.env.STUCK_CALLING_MINUTES ?? '25');
const PROCESSING_MIN = Number(process.env.STUCK_PROCESSING_MINUTES ?? '60');

// Hard limit on rows we'll email about in a single run. Past this
// you don't have a stuck-row problem, you have a system-down problem,
// and the ops email surface has degraded into noise.
const MAX_ROWS_PER_ALERT = 25;

export type CheckStuckReason = 'queryFailed' | 'sendFailed';

export type StuckCheckResult =
  | { ok: true; stuckCount: number; alertSent: boolean; note?: string }
  | { ok: false; reason: string };

export async function checkStuckRequests(
  admin: SupabaseClient
): Promise<StuckCheckResult> {
  const now = Date.now();
  const paidCutoff = new Date(now - PAID_MIN * 60_000).toISOString();
  const callingCutoff = new Date(now - CALLING_MIN * 60_000).toISOString();
  const processingCutoff = new Date(now - PROCESSING_MIN * 60_000).toISOString();

  // PostgREST OR with three nested AND clauses — one query, no
  // round-trip multiplication.
  const orFilter = [
    `and(status.eq.paid,created_at.lt.${paidCutoff})`,
    `and(status.eq.calling,vapi_batch_started_at.lt.${callingCutoff})`,
    `and(status.eq.processing,created_at.lt.${processingCutoff})`,
  ].join(',');

  const { data, error } = await admin
    .from('quote_requests')
    .select(
      'id, status, city, state, zip_code, created_at, vapi_batch_started_at'
    )
    .or(orFilter)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_ROWS_PER_ALERT);

  if (error) {
    log.error('stuck query failed', { err: error });
    captureException(new Error(`check-stuck-requests query: ${error.message}`), {
      tags: {
        lib: 'cron-check-stuck-requests',
        reason: 'queryFailed' satisfies CheckStuckReason,
      },
    });
    return { ok: false, reason: error.message };
  }

  const stuckCount = (data ?? []).length;
  if (stuckCount === 0) {
    return { ok: true, stuckCount: 0, alertSent: false };
  }

  // Compose the alert. Recipient is EVENQUOTE_SUPPORT_EMAIL — an
  // ops inbox the operator monitors. If unset (e.g. on first deploy
  // before the env was filled), we still log + return success so the
  // cron doesn't 503 forever.
  const supportEmail = process.env.EVENQUOTE_SUPPORT_EMAIL;
  if (!supportEmail) {
    log.warn('stuck rows present but EVENQUOTE_SUPPORT_EMAIL is not set', {
      stuckCount,
    });
    return {
      ok: true,
      stuckCount,
      alertSent: false,
      note: 'no support email configured — set EVENQUOTE_SUPPORT_EMAIL',
    };
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const rows: StuckRequestRow[] = (data ?? []).map((r) => {
    const stuckSince =
      r.status === 'calling' && r.vapi_batch_started_at
        ? r.vapi_batch_started_at
        : r.created_at;
    const minutesStuck = Math.max(
      0,
      Math.round((now - new Date(stuckSince as string).getTime()) / 60_000)
    );
    return {
      id: r.id as string,
      status: r.status as string,
      location: `${r.city ?? ''}, ${r.state ?? ''} ${r.zip_code ?? ''}`.trim(),
      minutesStuck,
      adminUrl: appUrl ? `${appUrl}/admin/requests/${r.id}` : '',
    };
  });

  const rendered = renderStuckRequestsAlert({ rows });

  const send = await sendEmail({
    to: supportEmail,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  if (!send.ok) {
    log.error('stuck alert send failed', { err: send.error });
    captureException(
      new Error(`check-stuck-requests sendFailed: ${send.error ?? 'unknown'}`),
      {
        tags: {
          lib: 'cron-check-stuck-requests',
          reason: 'sendFailed' satisfies CheckStuckReason,
        },
      }
    );
    return { ok: false, reason: 'email send failed' };
  }

  log.info('stuck alert sent', { stuckCount });
  return { ok: true, stuckCount, alertSent: true };
}
