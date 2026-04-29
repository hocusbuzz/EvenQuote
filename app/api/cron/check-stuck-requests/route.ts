// GET/POST /api/cron/check-stuck-requests
//
// Watchdog for quote_requests stuck past their SLA. Wakes the operator
// up via email when the pipeline silently drops a paid customer's job.
// Companion to send-reports + retry-failed-calls + check-status. See
// lib/cron/check-stuck-requests.ts for the threshold table and design
// rationale.
//
// Auth: shared CRON_SECRET, same as the other /api/cron/* routes.
//
// Response shapes:
//   200 { ok: true, stuckCount: 0, alertSent: false }
//   200 { ok: true, stuckCount: 3, alertSent: true }
//   200 { ok: true, stuckCount: N, alertSent: false, note: '...' }
//   503 { ok: false, error: '<short reason>' }    on query/email failure
//   401 { ok: false, error: 'unauthorized' }
//   500 { ok: false, error: 'CRON_SECRET not configured' }

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkStuckRequests } from '@/lib/cron/check-stuck-requests';
import { assertCronAuth } from '@/lib/security/cron-auth';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/check-stuck-requests');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const deny = assertCronAuth(req);
  if (deny) return deny;

  try {
    const admin = createAdminClient();
    const result = await checkStuckRequests(admin);

    if (!result.ok) {
      log.error('check failed', { reason: result.reason });
      // Already captured at the lib boundary by checkStuckRequests
      // for queryFailed / sendFailed reasons; no need to double-tag.
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: 503 }
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // Defense in depth: createAdminClient or any other unexpected
    // throw. The lib boundary catches expected failures; this is for
    // the truly weird ones.
    log.error('handler threw', { err });
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { route: 'cron/check-stuck-requests', reason: 'handlerThrew' },
    });
    return NextResponse.json(
      { ok: false, error: 'internal error' },
      { status: 503 }
    );
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
