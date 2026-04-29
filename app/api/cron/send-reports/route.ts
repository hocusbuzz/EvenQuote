// HTTP entry point for the send-reports cron.
//
// All business logic lives in `@/lib/cron/send-reports`. This file is
// intentionally thin because Next.js 14's App Router only permits HTTP
// method exports (GET/POST/…) and a small allowlist of config consts
// (dynamic, runtime, preferredRegion, …) from a route.ts file — any
// other export fails the build with:
//
//   Type error: Route "…/route.ts" does not match the required types
//   of a Next.js Route. "sendPendingReports" is not a valid Route
//   export field.
//
// Auth: same CRON_SECRET header/bearer pattern as retry-failed-calls.

import { createAdminClient } from '@/lib/supabase/admin';
import { sendPendingReports } from '@/lib/cron/send-reports';
import { createLogger } from '@/lib/logger';
import { assertCronAuth } from '@/lib/security/cron-auth';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/send-reports');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const deny = assertCronAuth(req);
  if (deny) return deny;

  const admin = createAdminClient();
  try {
    const result = await sendPendingReports(admin);
    return Response.json(result);
  } catch (err) {
    log.error('run failed', { err });
    // Canonical cron tag shape: { route: 'cron/<name>', reason }. Only
    // one capture site in this file today, but locking `reason` now
    // means a future second site (e.g. per-report send failure) can
    // grow in without renaming the existing facet.
    captureException(err, {
      tags: { route: 'cron/send-reports', reason: 'runFailed' },
    });
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
