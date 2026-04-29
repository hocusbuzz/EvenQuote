// R49(i) — Per-route `dynamic` and `runtime` export VALUE drift audit.
//
// R42(c) (`route-handler-exports-drift.test.ts`) locks the SET of
// route-segment-config exports per route — every route in
// EXPECTED_ROUTES declares `config: ['dynamic', 'runtime']` (or
// some subset), and the audit fails if a route is missing one of
// those exports. But R42(c) does NOT lock the VALUE of those
// exports.
//
// That's a drift surface. Next.js accepts a small set of legal
// values for each:
//
//   • `dynamic` ∈ {'auto', 'force-dynamic', 'force-static', 'error'}
//   • `runtime` ∈ {'nodejs', 'edge'}
//
// A maintainer who hand-edits `dynamic = 'force-static'` on a
// webhook route would silently make it page-cacheable. R42(c) sees
// the export and is satisfied. R48(b) catches the case where a
// `dynamic-only` route loses its dynamic export entirely OR sets
// Cache-Control alongside it, but doesn't lock the literal value.
// R44(c) locks the Cache-Control value on routes that set it but
// doesn't lock `dynamic`. So today there is no test that fails if
// `app/api/stripe/webhook/route.ts` ships with `dynamic = 'force-static'`.
//
// This audit closes that gap. For every route in ALL_ROUTES:
//   - Compare the actual exported value of `dynamic` against
//     DYNAMIC_EXPORT_VALUE attestation.
//   - Compare the actual exported value of `runtime` against
//     RUNTIME_EXPORT_VALUE attestation.
//   - Reject any value that isn't in the Next.js-legal set, even
//     for routes whose attestation is `null`.
//
// Why a separate audit instead of folding into R42(c) or R48(b):
//   - R42(c) is structurally about EXPORT NAMES. Locking VALUES
//     changes its parser surface significantly.
//   - R48(b) is about the Cache-Control STRATEGY. Auth routes
//     (`redirect-only`) don't appear in the `dynamic-only` lock
//     because they shouldn't export `dynamic` at all — but R48(b)
//     locks the absence of `dynamic`, not its value if present.
//   - Keeping R49(i) standalone means a single grep finds the
//     value-shape lock for any future code-review.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsOnlyRegex } from '@/tests/helpers/source-walker';
import {
  ALL_ROUTES,
  CACHE_CONTROL_ATTESTATION,
  DYNAMIC_EXPORT_VALUE,
  RUNTIME_EXPORT_VALUE,
  CANONICAL_DYNAMIC,
  CANONICAL_RUNTIME,
  assertConfigAttestationCovers,
} from '@/tests/helpers/route-catalog';

// Next.js-legal values for each config export. Anything outside
// these sets is a bug — Next.js silently treats unknown literals
// as the default.
//
// https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
const ALLOWED_DYNAMIC_VALUES = new Set<string>([
  'auto',
  'force-dynamic',
  'force-static',
  'error',
]);
const ALLOWED_RUNTIME_VALUES = new Set<string>(['nodejs', 'edge']);

// Regex extracts `export const dynamic = 'X'` and `export const runtime = 'Y'`.
// The capturing group catches the literal value; absence of a match
// means the export is missing entirely.
const DYNAMIC_VALUE_RE = /export\s+const\s+dynamic\s*=\s*['"]([a-z-]+)['"]/;
const RUNTIME_VALUE_RE = /export\s+const\s+runtime\s*=\s*['"]([a-z]+)['"]/;

function readStripped(rel: string): string {
  const full = join(process.cwd(), rel);
  return stripCommentsOnlyRegex(readFileSync(full, 'utf8'));
}

function extractDynamic(stripped: string): string | null {
  const m = DYNAMIC_VALUE_RE.exec(stripped);
  return m ? m[1] : null;
}

function extractRuntime(stripped: string): string | null {
  const m = RUNTIME_VALUE_RE.exec(stripped);
  return m ? m[1] : null;
}

describe('R49(i) — per-route config export value drift', () => {
  it('every ALL_ROUTES route is attested in DYNAMIC_EXPORT_VALUE and RUNTIME_EXPORT_VALUE', () => {
    expect(() => assertConfigAttestationCovers()).not.toThrow();
    expect(Object.keys(DYNAMIC_EXPORT_VALUE).length).toBe(ALL_ROUTES.size);
    expect(Object.keys(RUNTIME_EXPORT_VALUE).length).toBe(ALL_ROUTES.size);
  });

  it('CANONICAL_DYNAMIC is in the Next.js-legal set', () => {
    // Defensive: if a future refactor re-points CANONICAL_DYNAMIC at
    // a misspelled value (e.g. 'force-dynamics'), the audit still
    // passes because actual sources match the now-bad canonical.
    // Lock the canonical against the framework spec.
    expect(ALLOWED_DYNAMIC_VALUES.has(CANONICAL_DYNAMIC)).toBe(true);
  });

  it('CANONICAL_RUNTIME is in the Next.js-legal set', () => {
    expect(ALLOWED_RUNTIME_VALUES.has(CANONICAL_RUNTIME)).toBe(true);
  });

  it('every attested non-null DYNAMIC value is Next.js-legal', () => {
    // A maintainer who edits the catalog to declare a typo'd
    // value (e.g. 'force-dynamicc') would otherwise pass any
    // route comparison that matched the same typo. Lock the
    // catalog itself.
    const bad: { route: string; value: string }[] = [];
    for (const [route, value] of Object.entries(DYNAMIC_EXPORT_VALUE)) {
      if (value !== null && !ALLOWED_DYNAMIC_VALUES.has(value)) {
        bad.push({ route, value });
      }
    }
    expect(
      bad,
      `DYNAMIC_EXPORT_VALUE entries with illegal Next.js value: ${JSON.stringify(bad)}`,
    ).toEqual([]);
  });

  it('every attested non-null RUNTIME value is Next.js-legal', () => {
    const bad: { route: string; value: string }[] = [];
    for (const [route, value] of Object.entries(RUNTIME_EXPORT_VALUE)) {
      if (value !== null && !ALLOWED_RUNTIME_VALUES.has(value)) {
        bad.push({ route, value });
      }
    }
    expect(
      bad,
      `RUNTIME_EXPORT_VALUE entries with illegal Next.js value: ${JSON.stringify(bad)}`,
    ).toEqual([]);
  });

  // ── Per-route DYNAMIC value lock ────────────────────────────────

  for (const route of [...ALL_ROUTES].sort()) {
    const expected = DYNAMIC_EXPORT_VALUE[route];
    const label =
      expected === null
        ? `${route}: must NOT export const dynamic`
        : `${route}: dynamic === '${expected}'`;
    it(`R49(i) — ${label}`, () => {
      const stripped = readStripped(route);
      const actual = extractDynamic(stripped);
      if (expected === null) {
        expect(
          actual,
          `${route}: attestation says no dynamic export, but found dynamic = '${actual}'`,
        ).toBeNull();
      } else {
        expect(
          actual,
          `${route}: missing or unparseable \`export const dynamic = '...'\` — attestation expects '${expected}'`,
        ).not.toBeNull();
        if (actual !== null) {
          expect(
            actual,
            `${route}: dynamic = '${actual}' but attestation expects '${expected}'`,
          ).toBe(expected);
        }
      }
    });
  }

  // ── Per-route RUNTIME value lock ────────────────────────────────

  for (const route of [...ALL_ROUTES].sort()) {
    const expected = RUNTIME_EXPORT_VALUE[route];
    const label =
      expected === null
        ? `${route}: must NOT export const runtime`
        : `${route}: runtime === '${expected}'`;
    it(`R49(i) — ${label}`, () => {
      const stripped = readStripped(route);
      const actual = extractRuntime(stripped);
      if (expected === null) {
        expect(
          actual,
          `${route}: attestation says no runtime export, but found runtime = '${actual}'`,
        ).toBeNull();
      } else {
        expect(
          actual,
          `${route}: missing or unparseable \`export const runtime = '...'\` — attestation expects '${expected}'`,
        ).not.toBeNull();
        if (actual !== null) {
          expect(
            actual,
            `${route}: runtime = '${actual}' but attestation expects '${expected}'`,
          ).toBe(expected);
        }
      }
    });
  }

  // ── Anti-vacuous-pass tripwires ─────────────────────────────────

  it('at least one attested DYNAMIC value uses CANONICAL_DYNAMIC (catalog not vacuous)', () => {
    const count = Object.values(DYNAMIC_EXPORT_VALUE).filter(
      (v) => v === CANONICAL_DYNAMIC,
    ).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('at least one attested DYNAMIC value is null (redirect routes are represented)', () => {
    // If this drops to zero the redirect-only branch of R48(b) is
    // also vacuous; surfacing here means the catalogs evolve in
    // sync.
    const count = Object.values(DYNAMIC_EXPORT_VALUE).filter(
      (v) => v === null,
    ).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('at least one attested RUNTIME value uses CANONICAL_RUNTIME', () => {
    const count = Object.values(RUNTIME_EXPORT_VALUE).filter(
      (v) => v === CANONICAL_RUNTIME,
    ).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('at least one attested RUNTIME value is null', () => {
    const count = Object.values(RUNTIME_EXPORT_VALUE).filter(
      (v) => v === null,
    ).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // ── Cross-catalog consistency with R42(c) ───────────────────────

  it('DYNAMIC_EXPORT_VALUE === null implies route is in NON_CACHEABLE redirect-only strategy', () => {
    // R48(b)'s `redirect-only` strategy is the only attestation
    // that requires the absence of `dynamic`. This audit's
    // null-attestation must align with that strategy.
    // The implication test: every null-DYNAMIC route appears in
    // the redirect-only strategy bucket of CACHE_CONTROL_ATTESTATION.
    //
    // We do this in the simplest-possible way: import the strategy
    // map directly and intersect. If R48(b)'s catalog grows a new
    // strategy type that ALSO opts out of `dynamic`, this lock
    // surfaces the new alignment requirement explicitly.
    const nullDynamicRoutes = Object.entries(DYNAMIC_EXPORT_VALUE)
      .filter(([, v]) => v === null)
      .map(([r]) => r);
    const misaligned = nullDynamicRoutes.filter(
      (r) =>
        CACHE_CONTROL_ATTESTATION[r] !== 'redirect-only' &&
        // version is in CACHEABLE_VERSION, not NON_CACHEABLE — handled separately
        r !== 'app/api/version/route.ts',
    );
    expect(
      misaligned,
      `routes with null DYNAMIC_EXPORT_VALUE must be 'redirect-only' (R48(b)), found mismatches: ${JSON.stringify(misaligned)}`,
    ).toEqual([]);
  });
});
