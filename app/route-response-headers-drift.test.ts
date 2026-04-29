// R43(c) — Route response-header drift audit.
//
// Cache-Control hygiene for HTTP route handlers. Webhooks, cron jobs,
// auth callbacks, and status probes must never return responses that
// an intermediate CDN or browser can cache. The defenses in place:
//
//   • `export const dynamic = 'force-dynamic'` tells Next.js to opt
//     the route out of static optimization — already locked by
//     `app/route-handler-exports-drift.test.ts` (R42(c)) via
//     per-route `config: ['dynamic', 'runtime']`.
//
//   • This audit goes further and checks the `dynamic` VALUE and
//     locks explicit Cache-Control headers for routes that set
//     them. Two classes:
//
//       NON_CACHEABLE: webhooks, cron, dev, csp-report, health,
//         status, cron/check-status, stripe/webhook, vapi/webhook,
//         vapi/inbound-callback, twilio/sms, auth/callback,
//         auth/signout, get-quotes/claim. These MUST have
//         `dynamic = 'force-dynamic'` (where `dynamic` is exported
//         at all). If they also set a Cache-Control header, the
//         value MUST start with `no-store` or equivalent — never
//         `public`.
//
//       CACHEABLE_VERSION: `/api/version` is the one route that
//         explicitly SHOULD be cached (short TTL, public build
//         identifier). Its Cache-Control is locked to
//         `public, s-maxage=60, stale-while-revalidate=120`.
//
// The audit walks ALL route.ts files under app/ and fails if:
//   • a non-cacheable route exports a Cache-Control that's cacheable
//   • a non-cacheable route's `dynamic` value isn't `force-dynamic`
//   • the version route's Cache-Control drifts from the locked value
//   • a new route is added without being classified

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  stripCommentsOnlyRegex,
  stripCommentsAndStringLiteralsRegex,
} from '@/tests/helpers/source-walker';
import {
  NON_CACHEABLE,
  CACHEABLE_VERSION,
  CANONICAL_VERSION_CACHE_CONTROL,
  walkRouteFiles,
  assertCatalogPathsExist,
  assertCatalogsDisjoint,
} from '@/tests/helpers/route-catalog';

const APP_DIR = join(process.cwd(), 'app');

// R46(d): catalogs lifted to `tests/helpers/route-catalog.ts` so this
// audit and `route-response-headers-exact-shape.test.ts` (R44(c))
// share a single source of truth. Keep route classification edits in
// `route-catalog.ts` only.

function findRouteFiles(root: string): string[] {
  return walkRouteFiles(root);
}

// The exact Cache-Control value locked for the version route. Imported
// from the shared catalog so a future change is a one-edit operation.
const VERSION_CACHE_CONTROL = CANONICAL_VERSION_CACHE_CONTROL;

describe('app/**/route.ts — response-header drift (R43(c))', () => {
  const discoveredRel = findRouteFiles(APP_DIR).map((p) =>
    p.replace(process.cwd() + '/', ''),
  );

  it('discovery finds at least one route', () => {
    expect(discoveredRel.length).toBeGreaterThanOrEqual(1);
  });

  it('shared route-catalog paths all exist on disk', () => {
    expect(() => assertCatalogPathsExist()).not.toThrow();
  });

  it('shared route-catalog NON_CACHEABLE / CACHEABLE_VERSION are disjoint', () => {
    expect(() => assertCatalogsDisjoint()).not.toThrow();
  });

  it('discovery catalog equals expected (NON_CACHEABLE ∪ CACHEABLE_VERSION)', () => {
    const expected = new Set([...NON_CACHEABLE, ...CACHEABLE_VERSION]);
    const actual = new Set(discoveredRel);
    expect(actual).toEqual(expected);
  });

  it('NON_CACHEABLE and CACHEABLE_VERSION are disjoint', () => {
    for (const p of NON_CACHEABLE) {
      expect(CACHEABLE_VERSION.has(p)).toBe(false);
    }
  });

  // ── NON_CACHEABLE routes ────────────────────────────────────────

  for (const rel of [...NON_CACHEABLE].sort()) {
    describe(`NON_CACHEABLE: ${rel}`, () => {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      const strippedComments = stripCommentsOnlyRegex(src);
      const strippedAll = stripCommentsAndStringLiteralsRegex(src);

      it("if `dynamic` is exported, its value is 'force-dynamic'", () => {
        const m = /export\s+const\s+dynamic\s*=\s*(['"])([^'"]*)\1/.exec(
          strippedComments,
        );
        if (m === null) {
          // Some routes (auth/callback, auth/signout) don't export
          // `dynamic` — they rely on NextResponse.redirect, which is
          // inherently non-static. This is fine. The catalog in
          // `app/route-handler-exports-drift.test.ts` (R42(c)) locks
          // the exact config-export set per route, so absence here is
          // a conscious decision caught there, not missed here.
          return;
        }
        expect(m[2]).toBe('force-dynamic');
      });

      it("if a Cache-Control header is set, it begins with 'no-store' (not 'public')", () => {
        // Find all string literals whose value looks like a
        // Cache-Control header. Use strippedComments (string bodies
        // kept) so the literal text is visible.
        const re = /['"](no-store|public|private)[^'"]*['"]/g;
        const candidates: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(strippedComments)) !== null) {
          // Only treat as Cache-Control if the string appears near
          // `'Cache-Control'`.
          const start = Math.max(0, m.index - 80);
          const context = strippedComments.slice(start, m.index);
          if (/['"]Cache-Control['"]\s*:\s*$/.test(context.trimEnd() + ':')) {
            // Rough proximity heuristic; refine below.
          }
          candidates.push(m[0]);
        }
        // Stricter: look for `'Cache-Control': '<value>'` pairings.
        const pairRe = /['"]Cache-Control['"]\s*:\s*['"]([^'"]+)['"]/g;
        let p: RegExpExecArray | null;
        while ((p = pairRe.exec(strippedComments)) !== null) {
          const value = p[1].trim().toLowerCase();
          expect(
            value.startsWith('no-store'),
            `Cache-Control value "${p[1]}" in ${rel} must start with 'no-store' (non-cacheable route)`,
          ).toBe(true);
          expect(
            value.includes('public'),
            `Cache-Control value "${p[1]}" in ${rel} must not include 'public'`,
          ).toBe(false);
        }
        // Silence the unused-var lint warning; `candidates` is
        // intentionally collected above for future debug prints.
        void candidates;
      });

      it('source does not attempt to set `Cache-Control: public` anywhere', () => {
        // Belt-and-braces: even in a comment-stripped, string-only
        // view, we should NEVER see a `public,` Cache-Control on
        // these routes. (Template interpolation could evade this
        // check — flag as a TODO for a future audit if templates
        // appear.)
        expect(/Cache-Control['"]\s*:\s*['"]public/.test(strippedComments)).toBe(
          false,
        );
        void strippedAll; // reserved for future token-level checks
      });
    });
  }

  // ── CACHEABLE_VERSION ───────────────────────────────────────────

  describe('CACHEABLE_VERSION: app/api/version/route.ts', () => {
    const rel = 'app/api/version/route.ts';
    const src = readFileSync(join(process.cwd(), rel), 'utf8');
    const strippedComments = stripCommentsOnlyRegex(src);

    it(`Cache-Control is locked to '${VERSION_CACHE_CONTROL}'`, () => {
      // The version route can export /api/version from GET and HEAD
      // — both should share one Cache-Control. We accept multiple
      // occurrences AS LONG AS every one matches the locked value.
      const re = /['"]Cache-Control['"]\s*:\s*['"]([^'"]+)['"]/g;
      const values: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(strippedComments)) !== null) {
        values.push(m[1].trim());
      }
      expect(
        values.length,
        'Expected at least one Cache-Control header in the version route',
      ).toBeGreaterThanOrEqual(1);
      for (const v of values) {
        expect(v).toBe(VERSION_CACHE_CONTROL);
      }
    });

    it("`dynamic` value is still 'force-dynamic' (even though response is public-cacheable)", () => {
      // Subtle but important: `force-dynamic` controls Next.js
      // server-side static-vs-dynamic RENDERING. Cache-Control is a
      // separate header-level decision about DOWNSTREAM caching.
      // Both can and should coexist: always render at request time,
      // but let CDNs cache the identical response for 60 seconds.
      const m = /export\s+const\s+dynamic\s*=\s*(['"])([^'"]*)\1/.exec(
        strippedComments,
      );
      expect(m).not.toBeNull();
      expect(m![2]).toBe('force-dynamic');
    });
  });
});
