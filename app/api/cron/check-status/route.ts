// GET/POST /api/cron/check-status
//
// Cron-friendly wrapper around /api/status. Companion to the other
// jobs in /api/cron/. The point of this route is to be schedulable
// from Vercel Cron / pg_cron and to *fail loudly* (non-2xx) when a
// downstream integration is degraded. Vercel Cron pages on non-2xx
// responses; that's the alerting hook.
//
// Why a separate route vs. just scheduling /api/status directly?
//   • /api/status is the "ask me what's broken" inspection endpoint.
//     Its caller is a human or an uptime monitor that wants the full
//     JSON breakdown. It returns 503 only when *probes failed* — the
//     'skip' outcome (env not configured) is treated as healthy.
//   • This route is the "wake me up if something's broken" endpoint.
//     It applies the same Stripe + Vapi probes but returns a TINY,
//     boring JSON body so the cron history is grep-able, and never
//     returns 503 from a 'skip' outcome (preview envs without keys
//     would page forever).
//
// Auth: shared CRON_SECRET, same as the other /api/cron/* routes.
//
// Response shapes:
//   200 { ok: true,  checks: { stripe: 'ok'|'skip', vapi: 'ok'|'skip' } }
//   503 { ok: false, checks: { stripe: 'fail', vapi: 'ok' }, errors: { stripe: '<short>' } }
//   401 { ok: false, error: 'unauthorized' }
//   500 { ok: false, error: 'CRON_SECRET not configured' }

import { NextResponse } from 'next/server';
import { checkStripe, checkVapi } from '@/app/api/status/route';
import { createLogger } from '@/lib/logger';

const log = createLogger('cron/check-status');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function extractSecret(req: Request): string {
  return (
    req.headers.get('x-cron-secret') ??
    req.headers.get('X-Cron-Secret') ??
    (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  );
}

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }
  if (extractSecret(req) !== expected) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 }
    );
  }

  const [stripe, vapi] = await Promise.all([checkStripe(), checkVapi()]);

  const errors: Record<string, string> = {};
  if (stripe.outcome === 'fail' && stripe.message) errors.stripe = stripe.message;
  if (vapi.outcome === 'fail' && vapi.message) errors.vapi = vapi.message;

  const anyFail = stripe.outcome === 'fail' || vapi.outcome === 'fail';
  if (anyFail) {
    // Log loudly so the failure shows up in Vercel logs *and* in the
    // cron failure email body once Vercel surfaces a non-2xx run.
    log.error('integration check failed', {
      stripe: stripe.outcome,
      vapi: vapi.outcome,
      errors,
    });
  }

  return NextResponse.json(
    {
      ok: !anyFail,
      checks: { stripe: stripe.outcome, vapi: vapi.outcome },
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    },
    {
      status: anyFail ? 503 : 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    }
  );
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
