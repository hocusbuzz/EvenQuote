// R47(a) — CSP-report rate-limit drift audit.
//
// `/api/csp-report` is a public POST endpoint browsers hit for every
// CSP violation. Without throttling:
//
//   • A single misconfigured page (or a hostile actor) can flood the
//     structured log drain at browser-violation frequency (an ad-heavy
//     page can fire hundreds of reports per load).
//   • When `CSP_VIOLATIONS_PERSIST=true` the same flood becomes
//     browser-frequency writes against the `csp_violations` table.
//
// R47(a) added `assertRateLimit(...)` to the POST handler. This audit
// locks the call so a future refactor can't silently remove it.
// Mirrors the pattern in `app/api/places/places-rate-limit-drift.test.ts`
// (R46(a)) and `lib/actions/actions-rate-limit-audit.test.ts` for
// server actions.
//
// What we lock:
//   1. The route imports `assertRateLimit` from
//      `@/lib/security/rate-limit-auth`.
//   2. The `POST(req)` body invokes `assertRateLimit(req, ...)` BEFORE
//      any other call (no env reads, no body parsing, no admin client
//      construction ahead of the rate-limit check — otherwise a
//      flooder still drains CPU on the body parser before being cut).
//   3. The `prefix` is the documented namespace string `csp-report`.
//      Namespaces are the unit of bucket isolation; a typo silently
//      fuses this bucket with another.
//   4. The deny path is `if (deny) return deny;` — i.e. a 429 short-
//      circuit, not a logged-and-continued no-op.
//   5. A numeric `limit` and `windowMs` are passed (no defaults).
//   6. Documented limit band: 100–500 calls / 30s–120s. CSP report
//      bursts are legitimate during heavy page loads (the limit must
//      be generous enough not to drop real reports), but bounded
//      enough that a flood is cut at the route. Bands rather than
//      exact values to avoid tuning churn breaking the audit.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  stripCommentsPreservingPositions,
  extractExportedAsyncFunctionBody,
} from '../../../tests/helpers/source-walker';
import {
  isKnownPrefix,
  assertKnownPrefixesUnique,
} from '../../../tests/helpers/rate-limit-prefixes';

const ROUTE_FILE = path.resolve(
  process.cwd(),
  'app/api/csp-report/route.ts',
);

type RouteLock = {
  /** Prefix string passed to assertRateLimit. */
  prefix: string;
  /** Limit is allowed to be in this inclusive range. */
  limitMin: number;
  limitMax: number;
  /** WindowMs is allowed to be in this inclusive range. */
  windowMsMin: number;
  windowMsMax: number;
};

const EXPECTED: RouteLock = {
  prefix: 'csp-report',
  // Generous: a heavy page can legitimately fire 50+ reports on one
  // load; a real user reloading rapidly might cross 100. 500 is the
  // ceiling band — beyond that we're protecting browser bugs more
  // than abuse, and the bucket math diverges from the route's
  // intent.
  limitMin: 100,
  limitMax: 500,
  // 60s ± 2x. Browsers don't retry CSP reports, so the window length
  // is purely about how fast a flood is cut. 60s is the canonical
  // value used elsewhere; allow 30–120s for tuning.
  windowMsMin: 30_000,
  windowMsMax: 120_000,
};

describe('R47(a) — CSP-report rate-limit drift audit', () => {
  const source = fs.readFileSync(ROUTE_FILE, 'utf8');
  const stripped = stripCommentsPreservingPositions(source);
  const body = extractExportedAsyncFunctionBody(stripped, 'POST') ?? '';

  it('imports assertRateLimit from @/lib/security/rate-limit-auth', () => {
    const importRe =
      /import\s*\{[^}]*\bassertRateLimit\b[^}]*\}\s*from\s*['"]@\/lib\/security\/rate-limit-auth['"]/;
    expect(
      importRe.test(stripped),
      "csp-report/route.ts: missing import { assertRateLimit } from '@/lib/security/rate-limit-auth'",
    ).toBe(true);
  });

  it('POST body invokes assertRateLimit(req, ...) before any other call', () => {
    expect(body.length, 'failed to extract POST body').toBeGreaterThan(0);
    const sigEnd = body.indexOf('{');
    expect(
      sigEnd,
      'csp-report/route.ts: cannot locate POST body open-brace',
    ).toBeGreaterThan(0);
    const inside = body.slice(sigEnd + 1);
    const firstCallRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    let first = '';
    while ((m = firstCallRe.exec(inside)) !== null) {
      const name = m[1];
      // Skip declaration / control-flow keywords (these are not
      // calls). `URL`, `Number`, `Boolean` are constructors — none
      // should appear in an early-reject path before assertRateLimit
      // anyway, but we skip them defensively to mirror Places audit.
      if (
        name === 'if' ||
        name === 'for' ||
        name === 'while' ||
        name === 'switch' ||
        name === 'return' ||
        name === 'const' ||
        name === 'let' ||
        name === 'var' ||
        name === 'function' ||
        name === 'async' ||
        name === 'await' ||
        name === 'try' ||
        name === 'URL' ||
        name === 'Number' ||
        name === 'Boolean'
      ) {
        continue;
      }
      first = name;
      break;
    }
    expect(
      first,
      `csp-report/route.ts: first call in POST body is '${first}', expected 'assertRateLimit'`,
    ).toBe('assertRateLimit');
  });

  it(`uses prefix='${EXPECTED.prefix}'`, () => {
    const prefixRe = new RegExp(
      `prefix\\s*:\\s*['"\`]${EXPECTED.prefix}['"\`]`,
    );
    expect(
      prefixRe.test(body),
      `csp-report/route.ts: missing prefix: '${EXPECTED.prefix}' in POST body`,
    ).toBe(true);
  });

  it('uses `if (deny) return deny;` short-circuit', () => {
    const denyRe = /if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/;
    expect(
      denyRe.test(body),
      "csp-report/route.ts: missing 'if (deny) return deny;' short-circuit",
    ).toBe(true);
  });

  it('passes a numeric `limit` within the documented band', () => {
    // Try resolving from a `RATE_LIMIT` constant first (current shape),
    // then fall back to inline literal in the call.
    const constRe = /\bconst\s+RATE_LIMIT\s*=\s*\{([^}]+)\}/;
    const constMatch = constRe.exec(stripped);
    let resolved = NaN;
    if (constMatch) {
      const inner = constMatch[1];
      const lm = /limit\s*:\s*(\d+)/.exec(inner);
      if (lm) resolved = Number(lm[1]);
    } else {
      const lm = /\blimit\s*:\s*(\d+)/.exec(body);
      if (lm) resolved = Number(lm[1]);
    }
    expect(
      Number.isFinite(resolved) &&
        resolved >= EXPECTED.limitMin &&
        resolved <= EXPECTED.limitMax,
      `csp-report/route.ts: limit ${resolved} not in [${EXPECTED.limitMin}, ${EXPECTED.limitMax}]`,
    ).toBe(true);
  });

  it('passes a numeric `windowMs` within the documented band', () => {
    const constRe = /\bconst\s+RATE_LIMIT\s*=\s*\{([^}]+)\}/;
    const constMatch = constRe.exec(stripped);
    let resolved = NaN;
    if (constMatch) {
      const inner = constMatch[1];
      const wm = /windowMs\s*:\s*([\d_]+)/.exec(inner);
      if (wm) resolved = Number(wm[1].replace(/_/g, ''));
    } else {
      const wm = /windowMs\s*:\s*([\d_]+)/.exec(body);
      if (wm) resolved = Number(wm[1].replace(/_/g, ''));
    }
    expect(
      Number.isFinite(resolved) &&
        resolved >= EXPECTED.windowMsMin &&
        resolved <= EXPECTED.windowMsMax,
      `csp-report/route.ts: windowMs ${resolved} not in [${EXPECTED.windowMsMin}, ${EXPECTED.windowMsMax}]`,
    ).toBe(true);
  });

  it('rate-limit prefix is registered in the shared registry', () => {
    // R48(a) — the canonical KNOWN_PREFIXES list now lives in
    // `tests/helpers/rate-limit-prefixes.ts`. The audit asserts:
    //   (a) `csp-report` IS in the registry (so a removal of the
    //       prefix here is paired with an explicit removal there),
    //   (b) AND that the registry has no duplicates (so two routes
    //       can't collide silently).
    // The collision-detection check is now `assertKnownPrefixesUnique`
    // — duplicates surface in `rate-limit-prefixes.test.ts`.
    expect(
      isKnownPrefix(EXPECTED.prefix),
      `csp-report prefix '${EXPECTED.prefix}' is NOT in KNOWN_PREFIXES — register it in tests/helpers/rate-limit-prefixes.ts before changing the route`,
    ).toBe(true);
    expect(() => assertKnownPrefixesUnique()).not.toThrow();
  });

  it('rate-limit check sits BEFORE the body-size early-reject', () => {
    // Both checks are early-rejects but rate limit is the cheaper of
    // the two AND covers requests with bogus / missing content-length
    // headers (which the size cap silently lets through). Lock the
    // ordering so a future refactor doesn't reverse it.
    const sigEnd = body.indexOf('{');
    const inside = body.slice(sigEnd + 1);
    const rateLimitIdx = inside.indexOf('assertRateLimit');
    const sizeCheckIdx = inside.indexOf('content-length');
    expect(
      rateLimitIdx,
      'csp-report/route.ts: assertRateLimit not found in POST body',
    ).toBeGreaterThanOrEqual(0);
    if (sizeCheckIdx >= 0) {
      expect(
        rateLimitIdx < sizeCheckIdx,
        `csp-report/route.ts: rate-limit (idx ${rateLimitIdx}) must come before content-length size check (idx ${sizeCheckIdx})`,
      ).toBe(true);
    }
  });
});
