// HTTP entry point for the send-winbacks cron.
//
// All business logic lives in `@/lib/cron/send-winbacks`. This file
// is intentionally thin — Next.js 14's App Router only permits HTTP
// method exports + a tiny config allowlist from a route.ts file.
// See cron-route-parity-drift.test.ts for the locked-in contract.
//
// Auth: requires CRON_SECRET. The pg_cron caller passes it as
// `Authorization: Bearer <secret>`. Local curls may use either
// `x-cron-secret` or the bearer header.

import { createAdminClient } from '@/lib/supabase/admin';
import { sendWinBacks } from '@/lib/cron/send-winbacks';
import { createLogger } from '@/lib/logger';
import { assertCronAuth } from '@/lib/security/cron-auth';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/send-winbacks');

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
    const result = await sendWinBacks(admin);
    return Response.json(result);
  } catch (err) {
    log.error('run failed', { err });
    captureException(err, {
      tags: { route: 'cron/send-winbacks', reason: 'runFailed' },
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
