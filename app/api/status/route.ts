// GET /api/status
//
// Deeper companion to /api/health. While /health only answers "is the
// web tier alive and can it talk to its DB?", /status exercises the
// paid integrations we depend on — Stripe and Vapi — to catch silent
// rot (e.g., a rotated/expired API key that health doesn't detect).
//
// NOT public. Gated by the same CRON_SECRET the other scheduled jobs
// use. The expected caller is an uptime monitor running on a 5-10 min
// cadence with the secret in its request headers. We do NOT want every
// crawler probing Stripe's API on our behalf.
//
// Response shape (200):
//   { ok: true, checked_at, checks: { stripe: 'ok', vapi: 'ok' } }
// Degraded (503):
//   { ok: false, checked_at,
//     checks: { stripe: 'ok', vapi: 'fail' },
//     errors: { vapi: '<short message>' } }
//
// Design notes:
//   • 5s timeout per integration via AbortController. A hung Vapi API
//     shouldn't hold the status handler for the full Vercel 10s budget.
//   • We only surface short error messages, never raw error bodies —
//     Stripe errors can include request IDs or charge objects we don't
//     want leaking into a monitor's alert payload.
//   • When an integration is unconfigured (env unset) we report 'skip'
//     rather than treating it as a failure. Useful for preview envs
//     that legitimately have no Vapi key.

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('status');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHECK_TIMEOUT_MS = 5000;

type CheckOutcome = 'ok' | 'fail' | 'skip';

export type StatusResponse = {
  ok: boolean;
  checked_at: string;
  checks: {
    stripe: CheckOutcome;
    vapi: CheckOutcome;
  };
  errors?: Record<string, string>;
};

function unauthorized() {
  return NextResponse.json(
    { ok: false, error: 'unauthorized' },
    { status: 401 }
  );
}

function extractSecret(req: Request): string {
  return (
    req.headers.get('x-cron-secret') ??
    req.headers.get('X-Cron-Secret') ??
    (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  );
}

/**
 * Exercise Stripe with a cheap customers.list({limit:1}) call.
 * A successful round-trip confirms our key is valid AND Stripe's API
 * is reachable from this instance. Returns 'skip' when STRIPE_SECRET_KEY
 * is unset (preview env).
 *
 * Exported for testing — callers should use the GET handler.
 */
export async function checkStripe(): Promise<{ outcome: CheckOutcome; message?: string }> {
  if (!process.env.STRIPE_SECRET_KEY) return { outcome: 'skip' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    // Dynamic import so unit tests can vi.mock('@/lib/stripe/server')
    // without this file loading the SDK at module time.
    const { getStripe } = await import('@/lib/stripe/server');
    const stripe = getStripe();
    await stripe.customers.list({ limit: 1 }, { signal: ctrl.signal } as never);
    return { outcome: 'ok' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
    log.error('stripe check failed', { err: message });
    return { outcome: 'fail', message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exercise Vapi by hitting its `/account` endpoint. It's the cheapest
 * authenticated call Vapi exposes — returns the current org's billing
 * summary. A 200 means our bearer token is valid and the service is up.
 *
 * Exported for testing.
 */
export async function checkVapi(): Promise<{ outcome: CheckOutcome; message?: string }> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return { outcome: 'skip' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.vapi.ai/account', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const short = `HTTP ${res.status}`;
      log.error('vapi check non-2xx', { status: res.status });
      return { outcome: 'fail', message: short };
    }
    return { outcome: 'ok' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
    log.error('vapi check threw', { err: message });
    return { outcome: 'fail', message };
  } finally {
    clearTimeout(timer);
  }
}

async function handle(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'CRON_SECRET not configured' },
      { status: 500 }
    );
  }
  if (extractSecret(req) !== expected) return unauthorized();

  // Run both probes in parallel — they're independent, and /status
  // should not take longer than the slower of the two.
  const [stripe, vapi] = await Promise.all([checkStripe(), checkVapi()]);

  const errors: Record<string, string> = {};
  if (stripe.outcome === 'fail' && stripe.message) errors.stripe = stripe.message;
  if (vapi.outcome === 'fail' && vapi.message) errors.vapi = vapi.message;

  const anyFail = stripe.outcome === 'fail' || vapi.outcome === 'fail';
  const body: StatusResponse = {
    ok: !anyFail,
    checked_at: new Date().toISOString(),
    checks: { stripe: stripe.outcome, vapi: vapi.outcome },
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };

  return NextResponse.json(body, {
    status: anyFail ? 503 : 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
