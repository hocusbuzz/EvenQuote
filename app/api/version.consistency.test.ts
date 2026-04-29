// Cross-route consistency lockdown.
//
// /api/health and /api/version must report the same commit identity.
// Monitors and support replies assume "health.version === version.commitShort"
// — a silent divergence between the two is a debugging rabbit hole.
//
// Round 18 pointed at the drift surface: both routes independently
// read VERCEL_GIT_COMMIT_SHA with a 'dev' fallback. Round 19
// centralized the read in lib/observability/version and this file
// locks the invariant in place so a future refactor that inlines
// either call fails CI before it fails an on-call debug session.
//
// What we assert:
//   1. With VERCEL_GIT_COMMIT_SHA unset, both routes return 'dev'.
//   2. With a synthetic 40-char SHA set, version.commitShort ===
//      health.version (both derive from the same helper).
//   3. version.commit is the FULL SHA (not truncated), and
//      version.commitShort is exactly 7 chars of it.
//
// Implementation notes:
//   • /api/health does a DB check before building its body. We stub
//     createAdminClient so that path returns ok — we care about the
//     `version` field, not DB health. The test file doesn't need a
//     real Supabase connection.
//   • /api/version has no I/O, so no mocking is needed for it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const env = process.env as Record<string, string | undefined>;

// Stub the admin client so /api/health's DB check doesn't touch the
// network during these tests. The query shape is:
//   admin.from('service_categories').select('id', { count: 'exact', head: true })
// and the route expects { error: null | Error }.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: async () => ({ error: null }),
    }),
  }),
}));

describe('version consistency across /api/health and /api/version', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    saved.VERCEL_GIT_COMMIT_SHA = env.VERCEL_GIT_COMMIT_SHA;
    delete env.VERCEL_GIT_COMMIT_SHA;
  });

  afterEach(() => {
    if (saved.VERCEL_GIT_COMMIT_SHA === undefined) delete env.VERCEL_GIT_COMMIT_SHA;
    else env.VERCEL_GIT_COMMIT_SHA = saved.VERCEL_GIT_COMMIT_SHA;
  });

  it("both routes return 'dev' when VERCEL_GIT_COMMIT_SHA is unset", async () => {
    const { GET: healthGET } = await import('./health/route');
    const { GET: versionGET } = await import('./version/route');

    const healthRes = await healthGET();
    const versionRes = await versionGET();
    const healthBody = await healthRes.json();
    const versionBody = await versionRes.json();

    expect(healthBody.version).toBe('dev');
    expect(versionBody.commitShort).toBe('dev');
    expect(versionBody.commit).toBe('dev');
  });

  it('both routes report identical short SHA when VERCEL_GIT_COMMIT_SHA is set', async () => {
    env.VERCEL_GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef01234567';
    // Fresh module load — the helper reads env at call time, not at
    // import time (verified in lib/observability/version.test.ts), but
    // resetModules is a cheap belt-and-suspenders against any cached
    // top-level read added later.
    vi.resetModules();
    const { GET: healthGET } = await import('./health/route');
    const { GET: versionGET } = await import('./version/route');

    const healthRes = await healthGET();
    const versionRes = await versionGET();
    const healthBody = await healthRes.json();
    const versionBody = await versionRes.json();

    // The point of this file: these two must always be equal.
    expect(healthBody.version).toBe(versionBody.commitShort);
    expect(healthBody.version).toBe('abc1234');
  });

  it('version.commit is the FULL SHA and commitShort is its 7-char prefix', async () => {
    const fullSha = '0123456789abcdef0123456789abcdef01234567';
    env.VERCEL_GIT_COMMIT_SHA = fullSha;
    vi.resetModules();
    const { GET: versionGET } = await import('./version/route');

    const res = await versionGET();
    const body = await res.json();

    expect(body.commit).toBe(fullSha);
    expect(body.commitShort).toBe('0123456');
    expect(body.commit.startsWith(body.commitShort)).toBe(true);
  });
});
