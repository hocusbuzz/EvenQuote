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
//
// ── Observability contract (R33 audit) ────────────────────────────
// This route deliberately does NOT wire captureException on any
// path. Reasoning:
//   1. Polling frequency. Uptime monitors (UptimeRobot, BetterUptime,
//      Vercel's built-in, Vercel's external probes, load balancers)
//      hit this endpoint every 30-60s per instance, per region, per
//      probe. A real DB outage would flood Sentry with thousands of
//      identical events in minutes — alert fatigue with zero added
//      signal because the outage is already visible in the uptime
//      dashboard and on /api/status (which DOES capture, per R28).
//   2. Non-actionable delta. The useful signal here is the HTTP
//      status transition (200 → 503) and Sentry is not the right
//      tool for threshold alarms; uptime monitors already are. If an
//      operator wants to see the underlying Supabase error they can
//      look at the log drain or run /api/status once.
//   3. Redundant error-path. `/api/status` captures integration-probe
//      failures at a bounded frequency (cron schedule). Duplicating
//      the same root-cause at per-probe frequency here is the R26
//      no-double-capture rule.
//   4. createAdminClient throws only on missing env — R29 config-
//      state-no-capture pattern. Would flood on every probe during a
//      misconfig window.
//
// Regression-guards in route.test.ts lock this no-capture contract —
// if a future maintainer wires captureException here, the tests fail.
// If you need to break the rule, update the test AND add a comment
// justifying the new capture site.

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { featureReadiness } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { isEnabled as isSentryEnabled } from '@/lib/observability/sentry';
import { getCommitShort } from '@/lib/observability/version';

const log = createLogger('health');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Captured at module load — first time this file is imported in a given
// serverless instance. Resets on cold start, which is intentional: if the
// uptime graph shows this going to zero, that's the cold-start signal.
const BOOT_TIME_MS = Date.now();

// Both /api/health and /api/version must report the same commit identity.
// Source lives in lib/observability/version so the two routes can't drift
// — see version.consistency.test.ts for the lockdown.
const VERSION = getCommitShort();

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
  // Observability self-report. Separate from `features` because these
  // are side-channel tools (error tracker, log drain, metrics) rather
  // than product integrations — splitting them keeps the surface clean
  // when we add log-drain / metrics readiness later.
  //
  // sentry: 'enabled' | 'disabled'
  //   • 'enabled' when @sentry/nextjs is installed AND SENTRY_DSN is
  //     set AND init() ran. Today that's never true — the stub is a
  //     no-op until user-input #6 resolves. Having the field now gives
  //     `Check Sentry.command` a canary to assert against once the DSN
  //     lands: "health says enabled" means init succeeded, "disabled"
  //     means either the package or the DSN isn't in place.
  //   • We intentionally do NOT surface the DSN or environment name.
  //     Health is public.
  observability: {
    sentry: 'enabled' | 'disabled';
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
      log.error('db check failed', { err: error });
      return 'fail';
    }
    return 'ok';
  } catch (err) {
    log.error('db check threw', { err });
    return 'fail';
  }
}

function reportFeatures(): HealthResponse['features'] {
  // R47.4b: delegate to lib/env.ts featureReadiness() so the
  // health endpoint and the lib-level readiness check can't drift.
  // featureReadiness() requires the FULL credential set per
  // integration (e.g. all four VAPI_* vars, both RESEND_*) so a
  // partial config registers as 'simulation' here. Previously the
  // route checked just VAPI_API_KEY which let a half-configured
  // deploy report as 'configured' while real outbound calls would
  // never dispatch (engine fails on missing assistant id). That
  // gave operators a false-green health signal.
  const r = featureReadiness();
  return {
    stripe: r.stripe ? 'configured' : 'simulation',
    vapi: r.vapi ? 'configured' : 'simulation',
    resend: r.resend ? 'configured' : 'simulation',
    anthropic: r.anthropic ? 'configured' : 'simulation',
  };
}

function reportObservability(): HealthResponse['observability'] {
  return {
    sentry: isSentryEnabled() ? 'enabled' : 'disabled',
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
    observability: reportObservability(),
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
