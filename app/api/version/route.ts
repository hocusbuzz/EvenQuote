// GET /api/version
//
// Reports the deployed commit SHA + build metadata. Pure read of env
// vars — no DB, no external calls. Useful for:
//   • Triaging "is the deploy live yet?" mid-session.
//   • Vercel rollback verification — confirm the SHA matches the
//     deployment dashboard after a promote/rollback.
//   • Including in support replies when a customer reports a bug
//     ("we're on commit abc1234, the fix landed in def5678").
//
// Design choices:
//   • Public route. Commit SHAs are not secret — they're in the build
//     log and visible to anyone who can `git clone`. Keeping it
//     unauthenticated makes it usable from a status page or curl
//     without juggling CRON_SECRET.
//   • Static-cache friendly headers (s-maxage=60). The version doesn't
//     change between deploys, so a one-minute cache is harmless and
//     cuts function invocations on hot-pinged endpoints.
//   • Only env vars Vercel populates by default. No new secret config
//     to maintain.
//
// ── Observability contract (R33 audit) ────────────────────────────
// This route deliberately does NOT wire captureException on any
// path. Reasoning:
//   1. No error paths exist. Pure env-var read. The only branch is
//      `vercelEnvironment()` falling through to `NODE_ENV`, and that
//      has no throw surface.
//   2. Probe frequency. Same rationale as /api/health — uptime
//      monitors and rollback-verification scripts poll this at
//      per-region frequency. Capturing on any synthetic error here
//      would flood.
//   3. Secrets boundary. The response body is literally commit SHAs
//      and region names — no stack traces, no internal errors. A
//      captureException site would be the ONLY way this route could
//      accidentally forward an internal error string into the Sentry
//      event stream; keeping zero capture sites keeps that boundary
//      unambiguous.
//
// Regression-guards in route.test.ts lock this no-capture contract —
// if a future maintainer wires captureException here, the tests fail.

import { NextResponse } from 'next/server';
import { getCommitSha, getCommitShort } from '@/lib/observability/version';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type VersionResponse = {
  commit: string;
  commitShort: string;
  branch: string | null;
  buildTime: string | null;
  environment: 'production' | 'preview' | 'development';
  region: string | null;
};

function vercelEnvironment(): VersionResponse['environment'] {
  // VERCEL_ENV is one of 'production' | 'preview' | 'development' on
  // Vercel deployments; absent on local dev. Fall back to NODE_ENV.
  const v = process.env.VERCEL_ENV;
  if (v === 'production' || v === 'preview' || v === 'development') return v;
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

export async function GET() {
  const body: VersionResponse = {
    // Both fields go through lib/observability/version so /api/health
    // and /api/version can't drift. Lockdown: version.consistency.test.ts.
    commit: getCommitSha(),
    commitShort: getCommitShort(),
    // Branch only populated on preview deploys (production deploys
    // are off main, but we don't want to assume).
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    // VERCEL_BUILD_TIME isn't a documented runtime var, but BUILD_TIME
    // can be injected via vercel build args. Surface it if present;
    // otherwise null is the honest answer.
    buildTime: process.env.BUILD_TIME ?? process.env.VERCEL_BUILD_TIME ?? null,
    environment: vercelEnvironment(),
    region: process.env.VERCEL_REGION ?? null,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      // The version doesn't change between deploys, so a 60-second CDN
      // cache is safe. `stale-while-revalidate` keeps responses snappy
      // during the window when a fresh deploy hasn't repopulated yet.
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}

export async function HEAD() {
  // Some uptime monitors prefer HEAD. Mirror GET status semantics
  // without paying for the body.
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
