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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json(
      { ok: false, error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }
  const provided =
    req.headers.get('x-cron-secret') ??
    req.headers.get('X-Cron-Secret') ??
    (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (provided !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  try {
    const result = await sendPendingReports(admin);
    return Response.json(result);
  } catch (err) {
    console.error('[cron/send-reports] run failed', err);
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
