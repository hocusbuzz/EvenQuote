// R44(c) — Route response-header EXACT-shape lock.
//
// R43(c) (`route-response-headers-drift.test.ts`) locks the PREFIX of
// Cache-Control values on non-cacheable routes (must start with
// `no-store`). This file tightens that to the EXACT canonical string
// the codebase uses:
//
//   NON_CACHEABLE_CACHE_CONTROL =
//     'no-store, no-cache, must-revalidate, max-age=0'
//
// Every non-cacheable route that sets a Cache-Control header MUST
// set exactly this string. The version route's `public, s-maxage=60,
// stale-while-revalidate=120` is already exact-locked in R43(c).
//
// Why exact-lock:
//   • Multiple prefixes-starting-with-no-store are technically
//     correct (`no-store` alone, `no-store, private`, …) but mixing
//     them across handlers creates "which flavor of no-cache does
//     THIS route use?" confusion in incident review.
//   • `must-revalidate` specifically addresses stale cache edge
//     cases when a CDN's cache policy ignores no-store for shared
//     caches — belt-and-braces.
//   • `max-age=0` is the client-side belt to `no-store`'s suspenders.
//
// Routes that DO NOT set a Cache-Control are still fine — they rely
// on `dynamic = 'force-dynamic'` (locked elsewhere) + Next.js defaults.
// This test only applies to routes that chose to set the header.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsOnlyRegex } from '@/tests/helpers/source-walker';
import {
  NON_CACHEABLE,
  CANONICAL_NO_STORE,
  walkRouteFiles,
} from '@/tests/helpers/route-catalog';

const APP_DIR = join(process.cwd(), 'app');

// R46(d): the NON_CACHEABLE catalog and the canonical no-store value
// are imported from `tests/helpers/route-catalog.ts`. Previously this
// audit kept its own copy of the set "for resilience" — but R45's
// places-proxy add-on touched the OTHER copy and missed this one,
// silently exempting the Places proxies from the exact-shape lock.
// The shared catalog eliminates that drift class.

function findRouteFiles(root: string): string[] {
  return walkRouteFiles(root);
}

describe('app/**/route.ts — Cache-Control exact-shape lock (R44(c))', () => {
  const discoveredRel = findRouteFiles(APP_DIR).map((p) =>
    p.replace(process.cwd() + '/', ''),
  );

  // Sanity: make sure R44(c) and R43(c) agree on membership.
  it('NON_CACHEABLE set is a subset of discovered routes', () => {
    for (const r of NON_CACHEABLE) {
      expect(
        discoveredRel.includes(r),
        `NON_CACHEABLE references ${r} but that file is not in discovery`,
      ).toBe(true);
    }
  });

  for (const rel of [...NON_CACHEABLE].sort()) {
    it(`${rel}: if Cache-Control is set, the value equals the canonical no-store string`, () => {
      const full = join(process.cwd(), rel);
      const src = readFileSync(full, 'utf8');
      const stripped = stripCommentsOnlyRegex(src);
      // Match `'Cache-Control': '<value>'` pairings.
      const re = /['"]Cache-Control['"]\s*:\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        const value = m[1].trim();
        expect(
          value,
          `${rel}: Cache-Control value "${value}" drifts from canonical "${CANONICAL_NO_STORE}"`,
        ).toBe(CANONICAL_NO_STORE);
      }
    });
  }

  // At least ONE non-cacheable route must actually set the header —
  // otherwise the exact-shape lock above vacuously passes and we
  // don't notice if every route silently dropped its Cache-Control.
  it('at least one NON_CACHEABLE route sets Cache-Control to the canonical value', () => {
    let found = 0;
    for (const rel of NON_CACHEABLE) {
      const full = join(process.cwd(), rel);
      const src = readFileSync(full, 'utf8');
      const stripped = stripCommentsOnlyRegex(src);
      const re = new RegExp(
        `['"]Cache-Control['"]\\s*:\\s*['"]${CANONICAL_NO_STORE.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )}['"]`,
      );
      if (re.test(stripped)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(1);
  });

  // Forbidden-value guard: the OLD, shorter `no-store` alone, or
  // mixed-case, or extra tokens must not creep in.
  for (const rel of [...NON_CACHEABLE].sort()) {
    it(`${rel}: no non-canonical no-store variant present`, () => {
      const full = join(process.cwd(), rel);
      const src = readFileSync(full, 'utf8');
      const stripped = stripCommentsOnlyRegex(src);
      const FORBIDDEN: string[] = [
        'no-store',
        'no-store, private',
        'no-store, max-age=0',
        'no-store,no-cache',
        'No-Store, No-Cache, Must-Revalidate, Max-Age=0',
      ];
      const re = /['"]Cache-Control['"]\s*:\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        const value = m[1].trim();
        if (value === CANONICAL_NO_STORE) continue; // OK
        expect(
          FORBIDDEN.includes(value),
          `${rel}: Cache-Control value "${value}" matches a forbidden non-canonical variant`,
        ).toBe(false);
      }
    });
  }
});
