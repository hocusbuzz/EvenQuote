// HTTP entry point for the reconcile-calls cron.
//
// All business logic lives in `@/lib/cron/reconcile-calls`. This file
// is intentionally thin because Next.js 14's App Router only permits
// HTTP method exports (GET/POST/…) and a small allowlist of config
// consts (dynamic, runtime, preferredRegion, …) from a route.ts file.
// See cron-route-parity-drift.test.ts for the locked-in contract.
//
// Auth: requires CRON_SECRET. The scheduler (pg_cron via pg_net) passes
// it as `Authorization: Bearer <secret>`; the optional Vercel Cron
// fallback uses `x-cron-secret`.
//
// Manually:
//   curl -H 'x-cron-secret: <secret>' https://…/api/cron/reconcile-calls

import { createAdminClient } from '@/lib/supabase/admin';
import { reconcileStuckCalls } from '@/lib/cron/reconcile-calls';
import { createLogger } from '@/lib/logger';
import { assertCronAuth } from '@/lib/security/cron-auth';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/reconcile-calls');

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
    const result = await reconcileStuckCalls(admin);
    return Response.json(result);
  } catch (err) {
    log.error('run failed', { err });
    captureException(err, {
      tags: { route: 'cron/reconcile-calls', reason: 'runFailed' },
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
