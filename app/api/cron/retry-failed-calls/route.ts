// HTTP entry point for the retry-failed-calls cron.
//
// All business logic lives in `@/lib/cron/retry-failed-calls`. This file
// is intentionally thin because Next.js 14's App Router only permits
// HTTP method exports (GET/POST/…) and a small allowlist of config
// consts (dynamic, runtime, preferredRegion, …) from a route.ts file —
// any other export fails the build with:
//
//   Type error: Route "…/route.ts" does not match the required types
//   of a Next.js Route. "retryFailedCalls" is not a valid Route export
//   field.
//
// Auth: requires CRON_SECRET. The scheduler (pg_cron via pg_net) passes
// it as `Authorization: Bearer <secret>`; the old Vercel Cron wiring used
// the `x-cron-secret` header, and local curls may use either.
//
// Manually:
//   curl -H 'x-cron-secret: <secret>' https://…/api/cron/retry-failed-calls

import { createAdminClient } from '@/lib/supabase/admin';
import { retryFailedCalls } from '@/lib/cron/retry-failed-calls';
import { createLogger } from '@/lib/logger';

const log = createLogger('cron/retry-failed-calls');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  return handle(req);
}

// pg_cron + pg_net.http_post is POST-only, but keep GET around too so
// an ops person can curl the route with no body and Vercel Cron (if we
// ever re-enable it as a fallback) keeps working.
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed if the secret isn't configured. You REALLY don't
    // want this endpoint open to the internet.
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
    const result = await retryFailedCalls(admin);
    return Response.json(result);
  } catch (err) {
    // Safe envelope: log the full error server-side (structured logger),
    // but return only the short message to the caller so we don't leak
    // stack traces or internal query shapes to a misbehaving caller.
    log.error('run failed', { err });
    return Response.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
