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

import { NextResponse } from 'next/server';

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

function shortSha(sha: string | undefined): string {
  if (!sha) return 'dev';
  // 7 chars is the git --short default. Long enough to be unambiguous
  // in any realistic repo, short enough to type from memory.
  return sha.slice(0, 7);
}

function vercelEnvironment(): VersionResponse['environment'] {
  // VERCEL_ENV is one of 'production' | 'preview' | 'development' on
  // Vercel deployments; absent on local dev. Fall back to NODE_ENV.
  const v = process.env.VERCEL_ENV;
  if (v === 'production' || v === 'preview' || v === 'development') return v;
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

export async function GET() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev';
  const body: VersionResponse = {
    commit: sha,
    commitShort: shortSha(process.env.VERCEL_GIT_COMMIT_SHA),
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
