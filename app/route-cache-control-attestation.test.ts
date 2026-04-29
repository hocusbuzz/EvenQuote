// R48(b) — Per-route Cache-Control attestation coverage check.
//
// R44(c) (`route-response-headers-exact-shape.test.ts`) locks the
// VALUE of Cache-Control when a NON_CACHEABLE route sets it. A route
// that NEVER sets the header silently passes — relying on
// `dynamic = 'force-dynamic'` (or, for redirect-only routes, on the
// fact that there's no body to cache).
//
// That's mostly fine, but it leaves an attestation gap: a future
// refactor could quietly drop both Cache-Control AND
// `force-dynamic` from a route, and the existing audits would all
// pass. R48(b) closes that gap.
//
// What this audit locks (per NON_CACHEABLE route in route-catalog.ts):
//
//   • If declared 'explicit-no-store' → file MUST contain a
//     `'Cache-Control': '<canonical>'` literal pair.
//   • If declared 'dynamic-only' → file MUST export `dynamic =
//     'force-dynamic'` AND MUST NOT set a Cache-Control header (the
//     value lock in R44(c) wouldn't catch a wrong-strategy choice
//     that just happened to use a CANONICAL value with no dynamic
//     export — that's the case this audit guards).
//   • If declared 'redirect-only' → file MUST NOT set Cache-Control
//     (auth callbacks redirect; cache headers on the redirect itself
//     are misapplied) AND MUST NOT export `dynamic` (R42(c) already
//     locks the absence of dynamic for these — duplicated here so
//     a regression in the strategy layer can't slip past via the
//     R42(c) catalog).
//
// Why a separate audit instead of folding into R44(c): R44(c) speaks
// to "if you set the header, this is the value." This audit speaks
// to "you must address Cache-Control via one of three known
// strategies." Each strategy has a different positive lock; collapsing
// them into one audit confuses two distinct invariants.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsOnlyRegex } from '@/tests/helpers/source-walker';
import {
  NON_CACHEABLE,
  CACHE_CONTROL_ATTESTATION,
  CANONICAL_NO_STORE,
  assertAttestationCovers,
} from '@/tests/helpers/route-catalog';

const CACHE_CONTROL_RE = /['"]Cache-Control['"]\s*:\s*['"]([^'"]+)['"]/;
const DYNAMIC_FORCE_RE = /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/;
const DYNAMIC_ANY_RE = /export\s+const\s+dynamic\s*=\s*['"]/;

function readStripped(rel: string): string {
  const full = join(process.cwd(), rel);
  return stripCommentsOnlyRegex(readFileSync(full, 'utf8'));
}

describe('R48(b) — Cache-Control per-route attestation', () => {
  it('every NON_CACHEABLE route is attested in CACHE_CONTROL_ATTESTATION', () => {
    expect(() => assertAttestationCovers()).not.toThrow();
    expect(Object.keys(CACHE_CONTROL_ATTESTATION).length).toBe(
      NON_CACHEABLE.size,
    );
  });

  it('attestation values are one of the three known strategies', () => {
    const ALLOWED = new Set([
      'explicit-no-store',
      'dynamic-only',
      'redirect-only',
    ]);
    for (const [route, strategy] of Object.entries(CACHE_CONTROL_ATTESTATION)) {
      expect(ALLOWED.has(strategy), `${route}: unknown strategy '${strategy}'`)
        .toBe(true);
    }
  });

  it("at least one route uses each strategy (anti-vacuous-pass tripwire)", () => {
    const counts: Record<string, number> = {
      'explicit-no-store': 0,
      'dynamic-only': 0,
      'redirect-only': 0,
    };
    for (const s of Object.values(CACHE_CONTROL_ATTESTATION)) counts[s]++;
    // If a strategy ever drops to zero, either it's been deprecated
    // (in which case remove from the type union) or this audit goes
    // stale. Forcing per-strategy coverage prevents the latter.
    expect(counts['explicit-no-store']).toBeGreaterThanOrEqual(1);
    expect(counts['dynamic-only']).toBeGreaterThanOrEqual(1);
    expect(counts['redirect-only']).toBeGreaterThanOrEqual(1);
  });

  // Per-strategy locks. Discover routes by strategy and assert each
  // one's source matches the strategy's invariants.

  const byStrategy = (
    s: 'explicit-no-store' | 'dynamic-only' | 'redirect-only',
  ): string[] =>
    Object.entries(CACHE_CONTROL_ATTESTATION)
      .filter(([, strat]) => strat === s)
      .map(([r]) => r)
      .sort();

  for (const route of byStrategy('explicit-no-store')) {
    it(`${route}: explicit-no-store — Cache-Control set to canonical no-store`, () => {
      const stripped = readStripped(route);
      const m = CACHE_CONTROL_RE.exec(stripped);
      expect(
        m !== null,
        `${route}: declared 'explicit-no-store' but no Cache-Control literal found`,
      ).toBe(true);
      // R44(c) locks the value globally; we re-assert here so this
      // audit's per-route message is precise on regression.
      if (m) {
        expect(
          m[1].trim(),
          `${route}: Cache-Control value "${m[1]}" drifts from canonical "${CANONICAL_NO_STORE}"`,
        ).toBe(CANONICAL_NO_STORE);
      }
    });
  }

  for (const route of byStrategy('dynamic-only')) {
    it(`${route}: dynamic-only — exports force-dynamic AND does not set Cache-Control`, () => {
      const stripped = readStripped(route);
      expect(
        DYNAMIC_FORCE_RE.test(stripped),
        `${route}: declared 'dynamic-only' but missing \`export const dynamic = 'force-dynamic'\``,
      ).toBe(true);
      // Setting Cache-Control AND choosing 'dynamic-only' is the
      // strategy mismatch this lock catches: pick a strategy and
      // commit to it. If you genuinely want both, switch the
      // attestation to 'explicit-no-store' (which also requires the
      // canonical value).
      expect(
        CACHE_CONTROL_RE.test(stripped),
        `${route}: declared 'dynamic-only' but route sets Cache-Control — switch attestation to 'explicit-no-store' or remove the header`,
      ).toBe(false);
    });
  }

  for (const route of byStrategy('redirect-only')) {
    it(`${route}: redirect-only — does not set Cache-Control AND does not export dynamic`, () => {
      const stripped = readStripped(route);
      expect(
        CACHE_CONTROL_RE.test(stripped),
        `${route}: declared 'redirect-only' but route sets Cache-Control — caching a redirect is unintended; remove the header`,
      ).toBe(false);
      expect(
        DYNAMIC_ANY_RE.test(stripped),
        `${route}: declared 'redirect-only' but route exports \`dynamic\` — auth redirects don't need force-dynamic; remove the export`,
      ).toBe(false);
    });
  }
});
