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
import { assertCronAuth } from '@/lib/security/cron-auth';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('cron/check-status');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function handle(req: Request) {
  const deny = assertCronAuth(req);
  if (deny) return deny;

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
    // Route to Sentry with the canonical `{ route }` tag shape used by
    // the other /api/cron/* handlers. We synthesize a new Error because
    // `fail` probes don't throw — they return structured outcomes.
    // Including the failing integration in tags lets on-call filter
    // by surface (stripe vs. vapi) without grepping the message body.
    // PII-safe: the outcome strings are 'ok'|'skip'|'fail' literals,
    // not contact data, so forwarding them as tags is safe.
    captureException(
      new Error(
        `cron/check-status: integration probe failed — stripe=${stripe.outcome} vapi=${vapi.outcome}`
      ),
      {
        tags: {
          route: 'cron/check-status',
          reason: 'integrationProbeFailed',
          stripe: stripe.outcome,
          vapi: vapi.outcome,
        },
      }
    );
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
