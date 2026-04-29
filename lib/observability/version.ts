// Single source of truth for the deployed commit identity.
//
// Previously, `/api/health` and `/api/version` each parsed
// `process.env.VERCEL_GIT_COMMIT_SHA` independently with their own
// 'dev' fallback. That meant a future refactor that changed the
// fallback in one route (e.g. 'dev' → 'local' or '0000000') would
// silently diverge them — a monitor asserting `health.version ===
// version.commitShort` would page for a cosmetic difference.
//
// Keeping the read + normalization here means:
//   • Both routes import the same helpers — no divergence possible.
//   • A test (version.consistency.test.ts) locks the invariant so a
//     future refactor to inline either call fails CI.
//   • The 7-char "short" convention matches `git rev-parse --short`.
//     If we ever want to switch to 8 or 12, we change one place.
//
// NOT in scope: branch name, build time, region. Those remain in
// /api/version because they're version-endpoint-specific and health
// deliberately keeps its payload minimal.

/**
 * Full commit SHA with three-tier preference:
 *   1. `VERCEL_GIT_COMMIT_SHA` — populated automatically on every
 *      Vercel deploy; the runtime source of truth when the app is
 *      deployed.
 *   2. `NEXT_PUBLIC_BUILD_SHA` — injected at `next build` time from
 *      `git rev-parse --short HEAD` by `next.config.mjs` (see the
 *      `env` block). Gives a real SHA for non-Vercel builds (self-
 *      hosted Docker, a staging EC2, a customer-facing demo off a
 *      laptop) where the Vercel-specific var is absent.
 *   3. `'dev'` — final sentinel for test runs / dev server where no
 *      build step ran.
 *
 * Why 'dev' and not empty string / null: every caller of this has a
 * non-nullable `string` field, so returning a sentinel avoids forcing
 * each route to decide on its own fallback — which was exactly how
 * the drift surface opened up.
 */
export function getCommitSha(): string {
  // Nullish — Vercel sets this to a real 40-char SHA or doesn't set it
  // at all. Empty-string is preserved as a deliberate caller choice
  // (lockdown: version.test.ts `treats empty-string ... as 'dev'`).
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercelSha !== undefined) return vercelSha;
  const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA;
  // Truthy — a build-time-injected var is either a real short SHA or
  // absent; empty-string would indicate a failed `git rev-parse` at
  // build time, which is best reported as 'dev' not as a silent blank
  // commit field on /api/version.
  if (buildSha) return buildSha;
  return 'dev';
}

/**
 * 7-char short SHA. Matches `git rev-parse --short` default. Long
 * enough to be unambiguous in any realistic repo, short enough to
 * type from memory or paste into a chat message.
 *
 * Preference order matches `getCommitSha`:
 *   1. Vercel runtime SHA (sliced to 7)
 *   2. Build-time SHA (already 7-char by convention, sliced defensively)
 *   3. 'dev'
 *
 * When neither env var is set, returns 'dev' (not 'dev' + padding) —
 * callers that want a fixed-width string can do their own padStart.
 */
export function getCommitShort(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) {
    // 7 chars is the git --short default. Slicing a 40-char SHA yields
    // exactly 7; slicing a shorter string returns what's there (defensive
    // against odd CI that might set a truncated value).
    return sha.slice(0, 7);
  }
  const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA;
  if (buildSha) return buildSha.slice(0, 7);
  return 'dev';
}
