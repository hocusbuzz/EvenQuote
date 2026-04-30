// HTTP entry point for the dispatch-scheduled-requests cron (#117).
//
// Picks up quote_requests that were deferred to local business hours by
// the enqueueQuoteCalls deferral logic and dispatches them now. All
// business logic lives in `@/lib/cron/dispatch-scheduled-requests`;
// this file is the standard thin Next.js Route wrapper.
//
// Auth: shared CRON_SECRET, same as the other /api/cron/* routes.
//   pg_cron via pg_net.http_post passes `Authorization: Bearer <secret>`
//   curl: `curl -H 'x-cron-secret: <secret>' …`
//
// Schedule: every 5 minutes via pg_cron (see migration 0014).
//
// Response shapes:
//   200 { ok: true, scanned, dispatched, skipped, failed: [] }
//   401 { ok: false, error: 'unauthorized' }
//   500 { ok: false, error: '<short>' }

import { createAdminClient } from '@/lib/supabase/admin';
import { dispatchScheduledRequests } from '@/lib/cron/dispatch-scheduled-requests';
import { createLogger } from '@/lib/logger';
import { assertCronAuth } from '@/lib/security/cron-auth';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/dispatch-scheduled-requests');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  return handle(req);
}

// Keep GET around so an ops person can curl the route with no body.
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const deny = assertCronAuth(req);
  if (deny) return deny;

  const admin = createAdminClient();
  try {
    const result = await dispatchScheduledRequests(admin);
    return Response.json(result);
  } catch (err) {
    log.error('run failed', { err });
    captureException(
      err instanceof Error
        ? err
        : new Error(`cron/dispatch-scheduled-requests: ${String(err)}`),
      {
        tags: {
          route: 'cron/dispatch-scheduled-requests',
          reason: 'topLevelException',
        },
      }
    );
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : 'unknown error' },
      { status: 500 }
    );
  }
}
