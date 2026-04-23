// GET /api/health
//
// Lightweight liveness + readiness probe for uptime monitors (UptimeRobot,
// BetterUptime, Vercel's built-in, etc.) and for load balancers to know
// whether this instance is serving traffic.
//
// Design goals:
//   • Fast: target < 100ms p99. Never touch an external API that could
//     block the response. DB round-trip is the only I/O we do, and it's
//     a trivial count() the planner should satisfy from statistics.
//   • Boolean outcome: overall `ok: true/false`. Monitors alert on the
//     HTTP status code; we return 200 when healthy and 503 when the DB
//     is unreachable (because serving traffic with no DB is useless).
//   • Always safe to expose publicly: no secrets, no PII, no stack
//     traces. The shape is deliberately minimal.
//   • Best-effort env self-report: we show which feature integrations
//     are "configured" (env set) vs "simulation" (env missing) but we
//     never reveal the values or whether they're valid.
//
// Not in scope: warming Lambda containers, running the extraction LLM,
// checking Stripe reachability. Those belong in a separate `/api/status`
// endpoint if we ever want deeper insight.
//
// Response shape on success (200):
//   { ok: true, version, uptimeMs, checks: { db: 'ok' }, features: {...} }
// On DB failure (503):
//   { ok: false, version, uptimeMs, checks: { db: 'fail' }, features: {...} }

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('health');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Captured at module load — first time this file is imported in a given
// serverless instance. Resets on cold start, which is intentional: if the
// uptime graph shows this going to zero, that's the cold-start signal.
const BOOT_TIME_MS = Date.now();

// We read the package.json version at build time via env if available,
// otherwise fall back. Vercel populates VERCEL_GIT_COMMIT_SHA in prod.
const VERSION = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';

type HealthResponse = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  checks: {
    db: 'ok' | 'fail' | 'skip';
  };
  features: {
    stripe: 'configured' | 'simulation';
    vapi: 'configured' | 'simulation';
    resend: 'configured' | 'simulation';
    anthropic: 'configured' | 'simulation';
  };
};

async function checkDatabase(): Promise<'ok' | 'fail'> {
  try {
    const admin = createAdminClient();
    // `count: 'exact', head: true` issues a HEAD-style count query with
    // no data payload. It's the cheapest way to confirm the connection
    // works AND that our table still exists + RLS/privileges are intact.
    const { error } = await admin
      .from('service_categories')
      .select('id', { count: 'exact', head: true });
    if (error) {
      log.error('db check failed', { err: error.message });
      return 'fail';
    }
    return 'ok';
  } catch (err) {
    log.error('db check threw', { err });
    return 'fail';
  }
}

function reportFeatures(): HealthResponse['features'] {
  return {
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'simulation',
    vapi: process.env.VAPI_API_KEY ? 'configured' : 'simulation',
    resend: process.env.RESEND_API_KEY ? 'configured' : 'simulation',
    anthropic: process.env.ANTHROPIC_API_KEY ? 'configured' : 'simulation',
  };
}

export async function GET() {
  const dbCheck = await checkDatabase();
  const body: HealthResponse = {
    ok: dbCheck === 'ok',
    version: VERSION,
    uptimeMs: Date.now() - BOOT_TIME_MS,
    checks: { db: dbCheck },
    features: reportFeatures(),
  };

  return NextResponse.json(body, {
    status: body.ok ? 200 : 503,
    headers: {
      // Never cache a health check. Each monitor poll must hit the
      // function fresh — a cached 200 defeats the point of uptime.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
    },
  });
}

// HEAD is what some load balancers (ALB) send. Mirror GET semantics but
// don't send a body — Next serializes from the same handler.
export async function HEAD() {
  const dbCheck = await checkDatabase();
  return new NextResponse(null, {
    status: dbCheck === 'ok' ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}
