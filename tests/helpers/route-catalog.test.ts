// R46(d) — Tests for the shared route-catalog source-of-truth.
//
// `tests/helpers/route-catalog.ts` is imported by multiple audit
// tests. If the catalog gets out of sync with the actual app/
// directory, every consuming audit either silently passes or fails
// with a confusing per-route error. This file is the single place
// that asserts the catalog itself is internally consistent and
// matches the filesystem.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  NON_CACHEABLE,
  CACHEABLE_VERSION,
  ALL_ROUTES,
  CANONICAL_NO_STORE,
  CANONICAL_VERSION_CACHE_CONTROL,
  walkRouteFiles,
  assertCatalogPathsExist,
  assertCatalogsDisjoint,
  toAppRelative,
  toRouteSegment,
} from './route-catalog';

const APP_DIR = path.join(process.cwd(), 'app');

describe('R46(d) — shared route-catalog sanity', () => {
  it('every NON_CACHEABLE path exists on disk', () => {
    for (const rel of NON_CACHEABLE) {
      const full = path.join(process.cwd(), rel);
      expect(
        fs.existsSync(full),
        `NON_CACHEABLE references missing file: ${rel}`,
      ).toBe(true);
    }
  });

  it('every CACHEABLE_VERSION path exists on disk', () => {
    for (const rel of CACHEABLE_VERSION) {
      const full = path.join(process.cwd(), rel);
      expect(
        fs.existsSync(full),
        `CACHEABLE_VERSION references missing file: ${rel}`,
      ).toBe(true);
    }
  });

  it('NON_CACHEABLE and CACHEABLE_VERSION are disjoint', () => {
    for (const p of NON_CACHEABLE) {
      expect(
        CACHEABLE_VERSION.has(p),
        `${p} appears in BOTH NON_CACHEABLE and CACHEABLE_VERSION — pick one`,
      ).toBe(false);
    }
  });

  it('catalog covers every route.ts under app/', () => {
    // walkRouteFiles returns absolute paths; convert to repo-relative.
    const discovered = new Set(
      walkRouteFiles(APP_DIR).map((p) =>
        p.replace(process.cwd() + '/', ''),
      ),
    );
    const cataloged = new Set([...NON_CACHEABLE, ...CACHEABLE_VERSION]);

    // Every discovered route MUST be in the catalog.
    const missing: string[] = [];
    for (const rel of discovered) {
      if (!cataloged.has(rel)) missing.push(rel);
    }
    expect(
      missing,
      `Routes discovered under app/ but absent from route-catalog.ts. Add to NON_CACHEABLE or CACHEABLE_VERSION: ${missing.join(', ')}`,
    ).toEqual([]);

    // No catalog ghost — every cataloged route must exist.
    const ghosts: string[] = [];
    for (const rel of cataloged) {
      if (!discovered.has(rel)) ghosts.push(rel);
    }
    expect(
      ghosts,
      `route-catalog.ts references routes that no longer exist on disk: ${ghosts.join(', ')}`,
    ).toEqual([]);
  });

  it('CANONICAL_NO_STORE has the expected token order', () => {
    // Lock the canonical tokens themselves so `route-response-headers-
    // exact-shape.test.ts` and any future consumer share the same
    // string. If a future tightening adds `private`, update here ONCE.
    expect(CANONICAL_NO_STORE).toBe(
      'no-store, no-cache, must-revalidate, max-age=0',
    );
  });

  it('CANONICAL_VERSION_CACHE_CONTROL is the s-maxage=60 SWR=120 string', () => {
    expect(CANONICAL_VERSION_CACHE_CONTROL).toBe(
      'public, s-maxage=60, stale-while-revalidate=120',
    );
  });

  it('walkRouteFiles returns sorted absolute paths', () => {
    const files = walkRouteFiles(APP_DIR);
    expect(files.length, 'walk found no route.ts').toBeGreaterThan(0);
    // Paths are absolute.
    for (const f of files) {
      expect(f.startsWith('/'), `path is not absolute: ${f}`).toBe(true);
      expect(f.endsWith('/route.ts'), `path is not a route.ts: ${f}`).toBe(true);
    }
    // Output is sorted.
    const copy = [...files];
    copy.sort();
    expect(files).toEqual(copy);
  });

  it('walkRouteFiles handles non-existent root without throwing', () => {
    const result = walkRouteFiles(path.join(process.cwd(), '.does-not-exist'));
    expect(result).toEqual([]);
  });

  it('assertCatalogPathsExist passes for current state', () => {
    expect(() => assertCatalogPathsExist()).not.toThrow();
  });

  it('assertCatalogsDisjoint passes for current state', () => {
    expect(() => assertCatalogsDisjoint()).not.toThrow();
  });

  it('NON_CACHEABLE has every route under app/api/places (R45 close found this drift)', () => {
    // Specific regression lock: R45's Places-proxy add-on missed
    // route-response-headers-exact-shape.test.ts's local NON_CACHEABLE
    // copy. R46(d) consolidated to a single source-of-truth, so this
    // can't recur — but lock it here as a posterity test in case
    // someone partially reverts the consolidation.
    const placesRoutes = walkRouteFiles(path.join(APP_DIR, 'api/places'))
      .map((p) => p.replace(process.cwd() + '/', ''));
    expect(placesRoutes.length).toBeGreaterThan(0);
    for (const rel of placesRoutes) {
      expect(
        NON_CACHEABLE.has(rel),
        `Places proxy ${rel} must be in NON_CACHEABLE — it fronts a paid Google API and responses must never be cached`,
      ).toBe(true);
    }
  });

  // ── R47(b) — ALL_ROUTES + path-format helpers ──────────────────

  it('ALL_ROUTES is the union of NON_CACHEABLE and CACHEABLE_VERSION', () => {
    const expected = new Set([...NON_CACHEABLE, ...CACHEABLE_VERSION]);
    expect(ALL_ROUTES.size).toBe(expected.size);
    for (const p of expected) {
      expect(
        ALL_ROUTES.has(p),
        `ALL_ROUTES missing path that's in NON_CACHEABLE or CACHEABLE_VERSION: ${p}`,
      ).toBe(true);
    }
  });

  it('ALL_ROUTES covers every route.ts under app/ (single source of truth)', () => {
    const discovered = new Set(
      walkRouteFiles(APP_DIR).map((p) =>
        p.replace(process.cwd() + '/', ''),
      ),
    );
    const missing: string[] = [];
    for (const rel of discovered) {
      if (!ALL_ROUTES.has(rel)) missing.push(rel);
    }
    expect(
      missing,
      `Routes on disk but missing from ALL_ROUTES (add to NON_CACHEABLE or CACHEABLE_VERSION): ${missing.join(', ')}`,
    ).toEqual([]);
    // No ghosts.
    const ghosts: string[] = [];
    for (const rel of ALL_ROUTES) {
      if (!discovered.has(rel)) ghosts.push(rel);
    }
    expect(
      ghosts,
      `ALL_ROUTES references routes that no longer exist on disk: ${ghosts.join(', ')}`,
    ).toEqual([]);
  });

  it('toAppRelative strips leading app/ from a catalog path', () => {
    expect(toAppRelative('app/api/health/route.ts')).toBe(
      'api/health/route.ts',
    );
    expect(toAppRelative('app/auth/callback/route.ts')).toBe(
      'auth/callback/route.ts',
    );
  });

  it('toAppRelative throws on a path that does not start with app/', () => {
    expect(() => toAppRelative('api/health/route.ts')).toThrow(
      /expected catalog path to start with 'app\/'/,
    );
  });

  it('toRouteSegment strips both app/ and /route.ts', () => {
    expect(toRouteSegment('app/api/stripe/webhook/route.ts')).toBe(
      'api/stripe/webhook',
    );
    expect(toRouteSegment('app/api/places/autocomplete/route.ts')).toBe(
      'api/places/autocomplete',
    );
  });

  it('toRouteSegment throws on a malformed path', () => {
    expect(() => toRouteSegment('api/health/route.ts')).toThrow();
    expect(() => toRouteSegment('app/api/health/page.tsx')).toThrow();
  });

  it('every ALL_ROUTES entry is a syntactically valid catalog path', () => {
    for (const p of ALL_ROUTES) {
      expect(
        p.startsWith('app/') && p.endsWith('/route.ts'),
        `ALL_ROUTES entry has unexpected shape: ${p} (expected 'app/.../route.ts')`,
      ).toBe(true);
    }
  });
});
