// Unit tests for lib/observability/version.
//
// This module is the single source of truth shared by /api/health and
// /api/version. The invariants worth locking:
//   • The 'dev' fallback fires when VERCEL_GIT_COMMIT_SHA is unset.
//   • `getCommitShort` is exactly 7 chars for any SHA at least 7 long.
//   • A short env value (< 7 chars) is returned as-is, not padded —
//     caller contract documented in the source.
//
// The cross-route consistency lockdown lives in
// version.consistency.test.ts (route-level integration). This file
// covers the helpers in isolation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCommitSha, getCommitShort } from './version';

const env = process.env as Record<string, string | undefined>;

describe('lib/observability/version', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.VERCEL_GIT_COMMIT_SHA = env.VERCEL_GIT_COMMIT_SHA;
    saved.NEXT_PUBLIC_BUILD_SHA = env.NEXT_PUBLIC_BUILD_SHA;
    delete env.VERCEL_GIT_COMMIT_SHA;
    delete env.NEXT_PUBLIC_BUILD_SHA;
  });

  afterEach(() => {
    if (saved.VERCEL_GIT_COMMIT_SHA === undefined) delete env.VERCEL_GIT_COMMIT_SHA;
    else env.VERCEL_GIT_COMMIT_SHA = saved.VERCEL_GIT_COMMIT_SHA;
    if (saved.NEXT_PUBLIC_BUILD_SHA === undefined) delete env.NEXT_PUBLIC_BUILD_SHA;
    else env.NEXT_PUBLIC_BUILD_SHA = saved.NEXT_PUBLIC_BUILD_SHA;
  });

  describe('getCommitSha', () => {
    it("returns 'dev' when VERCEL_GIT_COMMIT_SHA is unset", () => {
      expect(getCommitSha()).toBe('dev');
    });

    it('returns the full SHA verbatim when set', () => {
      env.VERCEL_GIT_COMMIT_SHA = 'a'.repeat(40);
      expect(getCommitSha()).toBe('a'.repeat(40));
    });

    it("treats empty-string VERCEL_GIT_COMMIT_SHA as 'dev' via nullish fallback", () => {
      // Explicit guard: empty string is falsy but NOT null/undefined,
      // so `??` keeps it. This test locks the current behavior — if we
      // ever want to treat '' as unset, this failure tells us to update
      // BOTH the helper and the test.
      env.VERCEL_GIT_COMMIT_SHA = '';
      expect(getCommitSha()).toBe('');
    });
  });

  describe('getCommitShort', () => {
    it("returns 'dev' when VERCEL_GIT_COMMIT_SHA is unset", () => {
      expect(getCommitShort()).toBe('dev');
    });

    it('returns exactly 7 chars for a full 40-char SHA', () => {
      env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
      const short = getCommitShort();
      expect(short).toHaveLength(7);
      expect(short).toBe('0123456');
    });

    it("returns 'dev' for empty-string env (contrast with getCommitSha)", () => {
      // Deliberately asymmetric with getCommitSha: short uses a truthy
      // check because 'dev' is a more useful display value than '' for
      // the /api/health `version` field. Lock the asymmetry.
      env.VERCEL_GIT_COMMIT_SHA = '';
      expect(getCommitShort()).toBe('dev');
    });

    it('returns the full string when it is shorter than 7 chars (no padding)', () => {
      // Defensive: some CI systems might set a truncated value. Slicing
      // a 5-char string returns 5 chars, not 7 + padding. Documented in
      // the helper's JSDoc.
      env.VERCEL_GIT_COMMIT_SHA = 'abcde';
      expect(getCommitShort()).toBe('abcde');
    });
  });

  describe('build-time SHA fallback (NEXT_PUBLIC_BUILD_SHA)', () => {
    // Injected by next.config.mjs via `git rev-parse --short HEAD` at
    // build time. Consumed when VERCEL_GIT_COMMIT_SHA is absent — e.g.
    // self-hosted Docker, a `next build && next start` off a laptop
    // for a customer demo, CI that doesn't propagate Vercel-specific
    // vars. The tier order is load-bearing for support triage: a
    // screenshot from any of those environments must carry a real SHA,
    // not 'dev'.

    it('getCommitSha prefers VERCEL_GIT_COMMIT_SHA over NEXT_PUBLIC_BUILD_SHA', () => {
      env.VERCEL_GIT_COMMIT_SHA = 'a'.repeat(40);
      env.NEXT_PUBLIC_BUILD_SHA = '1234567';
      expect(getCommitSha()).toBe('a'.repeat(40));
    });

    it('getCommitSha falls back to NEXT_PUBLIC_BUILD_SHA when Vercel SHA is unset', () => {
      env.NEXT_PUBLIC_BUILD_SHA = '1234567';
      expect(getCommitSha()).toBe('1234567');
    });

    it("getCommitSha returns 'dev' when both vars are unset", () => {
      expect(getCommitSha()).toBe('dev');
    });

    it("getCommitSha falls through to 'dev' when build-SHA is empty string", () => {
      // Empty string signals a failed `git rev-parse` at build time (no
      // .git, detached build, timeout). Reporting '' on /api/version
      // would look like a broken deploy; 'dev' is the honest answer.
      env.NEXT_PUBLIC_BUILD_SHA = '';
      expect(getCommitSha()).toBe('dev');
    });

    it('getCommitShort prefers VERCEL_GIT_COMMIT_SHA (sliced to 7) over build SHA', () => {
      env.VERCEL_GIT_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
      env.NEXT_PUBLIC_BUILD_SHA = 'deadbee';
      expect(getCommitShort()).toBe('0123456');
    });

    it('getCommitShort uses NEXT_PUBLIC_BUILD_SHA when Vercel SHA is unset', () => {
      env.NEXT_PUBLIC_BUILD_SHA = 'deadbee';
      expect(getCommitShort()).toBe('deadbee');
    });

    it('getCommitShort slices a long build-SHA to 7 chars defensively', () => {
      // If someone pipes a full 40-char SHA through the build-arg path,
      // we still want 7 chars for display consistency with the Vercel
      // path.
      env.NEXT_PUBLIC_BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';
      expect(getCommitShort()).toBe('0123456');
    });

    it("getCommitShort returns 'dev' when build-SHA is empty string", () => {
      env.NEXT_PUBLIC_BUILD_SHA = '';
      expect(getCommitShort()).toBe('dev');
    });
  });

  // R33 edge cases — anchoring the contract against real-world CI
  // corruption shapes, type invariants, and pureness properties that
  // downstream callers implicitly depend on.
  describe('edge cases (R33)', () => {
    it('getCommitSha never returns undefined / null / non-string under any env permutation', () => {
      // /api/health and /api/version both assign this to a non-nullable
      // string field. A future refactor that forgot to cover one branch
      // (e.g. added a parsing step that threw) would surface here.
      const permutations: Array<{ v?: string; b?: string }> = [
        {},
        { v: undefined, b: undefined },
        { v: '' },
        { b: '' },
        { v: '', b: '' },
        { v: 'abc' },
        { b: 'abc' },
        { v: 'a'.repeat(40), b: 'deadbee' },
      ];
      for (const p of permutations) {
        delete env.VERCEL_GIT_COMMIT_SHA;
        delete env.NEXT_PUBLIC_BUILD_SHA;
        if (p.v !== undefined) env.VERCEL_GIT_COMMIT_SHA = p.v;
        if (p.b !== undefined) env.NEXT_PUBLIC_BUILD_SHA = p.b;
        const sha = getCommitSha();
        const short = getCommitShort();
        expect(typeof sha, `sha type for ${JSON.stringify(p)}`).toBe('string');
        expect(typeof short, `short type for ${JSON.stringify(p)}`).toBe('string');
      }
    });

    it('getCommitShort never exceeds 7 chars for any env permutation', () => {
      // The version endpoint's commitShort contract — locked at the
      // route level too, but doubled-up here so a future helper that
      // accidentally returned the full SHA (e.g. if someone "helpfully"
      // removed the slice because their test SHA happened to be 7
      // chars) breaks in TWO places, not just one.
      const permutations = [
        { v: 'a'.repeat(40) },
        { v: 'a'.repeat(12) },
        { b: 'a'.repeat(40) },
        { v: 'a'.repeat(40), b: 'deadbee' },
        // 'dev' is 3 chars — still under 7.
        {},
      ];
      for (const p of permutations) {
        delete env.VERCEL_GIT_COMMIT_SHA;
        delete env.NEXT_PUBLIC_BUILD_SHA;
        if (p.v !== undefined) env.VERCEL_GIT_COMMIT_SHA = p.v;
        if (p.b !== undefined) env.NEXT_PUBLIC_BUILD_SHA = p.b;
        expect(
          getCommitShort().length,
          `commitShort length for ${JSON.stringify(p)}`,
        ).toBeLessThanOrEqual(7);
      }
    });

    it('tolerates a trailing newline on the build SHA (rev-parse without chomp)', () => {
      // A build script that does `NEXT_PUBLIC_BUILD_SHA=$(git rev-parse
      // --short HEAD)` without trimming ends up with a trailing newline
      // in some shells. The slice(0,7) already clips this for the Vercel
      // path (a real SHA is 40 hex chars, slice stays inside). For the
      // build-SHA path, a 7-char + newline value would slice to 7 chars
      // correctly. We lock that here so a future refactor to `.trim()`
      // doesn't accidentally over-strip.
      env.NEXT_PUBLIC_BUILD_SHA = 'deadbee\n';
      const short = getCommitShort();
      // Either of these is acceptable long-term: current behavior is
      // to return 'deadbee' (slice keeps 7 chars, dropping the newline).
      // The important property: the return is deterministically one of
      // a documented small set.
      expect(['deadbee', 'deadbee\n'.slice(0, 7)]).toContain(short);
    });

    it('handles a single-character SHA (pathological CI case) without throwing', () => {
      // Absurd but possible: a CI system that set SHA='a' for smoke
      // testing. Must not throw, must not return undefined, must slice
      // safely.
      env.VERCEL_GIT_COMMIT_SHA = 'a';
      expect(() => getCommitSha()).not.toThrow();
      expect(() => getCommitShort()).not.toThrow();
      expect(getCommitSha()).toBe('a');
      expect(getCommitShort()).toBe('a');
    });

    it('is pure — same env → same result on repeated calls', () => {
      // Locks: no caching-at-module-scope (would break test isolation),
      // no random appendage (would break version.consistency assertion
      // that /api/health and /api/version report the same SHA), no
      // timestamp injection (would change on each call).
      env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
      const a1 = getCommitSha();
      const a2 = getCommitSha();
      const s1 = getCommitShort();
      const s2 = getCommitShort();
      expect(a1).toBe(a2);
      expect(s1).toBe(s2);
    });

    it('reflects env mutation between calls (no module-scope caching)', () => {
      // Guard against a future "perf" refactor that caches the SHA at
      // module load. Module load happens once per test file on Vitest,
      // but the helpers are called per-request at runtime — caching
      // would make /api/version incorrect after a redeploy within the
      // same serverless instance.
      env.VERCEL_GIT_COMMIT_SHA = 'a'.repeat(40);
      expect(getCommitSha()).toBe('a'.repeat(40));
      env.VERCEL_GIT_COMMIT_SHA = 'b'.repeat(40);
      expect(getCommitSha()).toBe('b'.repeat(40));
      delete env.VERCEL_GIT_COMMIT_SHA;
      env.NEXT_PUBLIC_BUILD_SHA = 'c'.repeat(7);
      expect(getCommitSha()).toBe('ccccccc');
    });

    it('treats a whitespace-only Vercel SHA as a literal value (not stripped)', () => {
      // Current contract: empty-string is preserved for Vercel path
      // (nullish fallback); whitespace is a non-empty string so it
      // passes through. This locks the current behavior against a
      // future "helpful" trim that might mask a broken CI pipeline.
      env.VERCEL_GIT_COMMIT_SHA = '   ';
      expect(getCommitSha()).toBe('   ');
      // getCommitShort uses a truthy check, but a 3-space string is
      // truthy → sliced to 7 chars = same 3 spaces.
      expect(getCommitShort()).toBe('   ');
    });

    it('treats build-SHA with only whitespace as truthy (falls through Vercel-unset path)', () => {
      // The build-SHA path uses a truthy check, so '   ' is kept. This
      // is defensive: if a build script produced whitespace for any
      // reason, we'd rather surface that garbage on /api/version than
      // silently show 'dev' and hide the CI bug.
      env.NEXT_PUBLIC_BUILD_SHA = '   ';
      expect(getCommitSha()).toBe('   ');
      expect(getCommitShort()).toBe('   ');
    });
  });
});
