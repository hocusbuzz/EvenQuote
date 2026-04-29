// R46(a) — Google Places proxy rate-limit drift audit.
//
// Both `/api/places/autocomplete` and `/api/places/details` proxy a
// PAID Google API behind a server-only key. Without throttling, a
// single bot spamming the autocomplete endpoint can:
//
//   • Burn our daily Places API quota (Google bills us per call OR,
//     if quota-capped, blocks autocomplete for real users for the
//     rest of the day).
//   • Hide behind a single IP because each call is cheap from the
//     attacker's side and we don't currently signal back-pressure.
//
// R45 close flagged this and R46(a) added `assertRateLimit(...)` to
// the GET handler in both routes. This audit locks the call so a
// future refactor can't silently remove it. Mirrors the pattern in
// `lib/actions/actions-rate-limit-audit.test.ts` for server actions.
//
// What we lock:
//   1. Both route files import `assertRateLimit` from
//      `@/lib/security/rate-limit-auth`.
//   2. Each `GET(req)` body invokes `assertRateLimit(req, ...)` BEFORE
//      any other call (env-key reads and Google fetches are forbidden
//      ahead of the rate-limit check — otherwise a spammer can drain
//      quota with malformed requests).
//   3. The `prefix` is the documented per-route namespace string
//      (`places-autocomplete` / `places-details`) — namespaces are the
//      unit of bucket isolation, so a typo silently fuses both buckets.
//   4. The deny path is `if (deny) return deny;` — i.e. a 429 short-
//      circuit, not a logged-and-continued no-op.
//   5. A numeric `limit` and `windowMs` are passed (no defaults — the
//      defaults from `lib/rate-limit.ts` are 10/min which would break
//      legitimate keystroke-driven autocomplete).
//   6. Documented limit bands per route — autocomplete is keystroke-
//      driven so its budget is generous; details is one-per-pick so
//      it's tighter. Bands rather than exact values to avoid tuning
//      churn breaking the audit.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  stripCommentsPreservingPositions,
  extractExportedAsyncFunctionBody,
} from '../../../tests/helpers/source-walker';
import { isKnownPrefix } from '../../../tests/helpers/rate-limit-prefixes';

const APP_DIR = path.resolve(process.cwd(), 'app');

type RouteLock = {
  file: string;
  prefix: string;
  /** Limit is allowed to be in this inclusive range. */
  limitMin: number;
  limitMax: number;
  /** WindowMs is allowed to be in this inclusive range. */
  windowMsMin: number;
  windowMsMax: number;
};

const EXPECTED_ROUTES: RouteLock[] = [
  {
    file: 'api/places/autocomplete/route.ts',
    prefix: 'places-autocomplete',
    // Generous: a real user firing 12 keystrokes across three address
    // inputs is well under 60. A bot scripting many lookups crosses
    // the budget within seconds and gets a clean 429.
    limitMin: 30,
    limitMax: 120,
    windowMsMin: 30_000,
    windowMsMax: 120_000,
  },
  {
    file: 'api/places/details/route.ts',
    prefix: 'places-details',
    // Tighter: details is called once per address pick, so a real
    // user re-typing several times still stays well under 30.
    limitMin: 10,
    limitMax: 60,
    windowMsMin: 30_000,
    windowMsMax: 120_000,
  },
];

function readRoute(rel: string): string {
  return fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
}

describe('R46(a) — Google Places proxy rate-limit drift audit', () => {
  for (const lock of EXPECTED_ROUTES) {
    describe(lock.file, () => {
      const source = readRoute(lock.file);
      const stripped = stripCommentsPreservingPositions(source);
      const body =
        extractExportedAsyncFunctionBody(stripped, 'GET') ?? '';

      it('imports assertRateLimit from @/lib/security/rate-limit-auth', () => {
        const importRe =
          /import\s*\{[^}]*\bassertRateLimit\b[^}]*\}\s*from\s*['"]@\/lib\/security\/rate-limit-auth['"]/;
        expect(
          importRe.test(stripped),
          `${lock.file}: missing import { assertRateLimit } from '@/lib/security/rate-limit-auth'`,
        ).toBe(true);
      });

      it('GET body invokes assertRateLimit(req, ...) before any other call', () => {
        expect(body.length, 'failed to extract GET body').toBeGreaterThan(0);
        // The walker returns the FULL span from `export async function
        // GET(...)` through the matching closing `}`. Skip past the
        // signature to find the body's opening `{`, then look for the
        // first identifier-call inside.
        const sigEnd = body.indexOf('{');
        expect(sigEnd, `${lock.file}: cannot locate body open-brace`).toBeGreaterThan(0);
        const inside = body.slice(sigEnd + 1);
        const firstCallRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
        let m: RegExpExecArray | null;
        let first = '';
        while ((m = firstCallRe.exec(inside)) !== null) {
          const name = m[1];
          // Skip declaration / control-flow keywords (these are not
          // calls). `URL` is a constructor — also skipped because it
          // appears AFTER the rate-limit check in our pattern but the
          // existing routes pre-R46 had it first. We want the
          // assertion to fire if assertRateLimit is missing entirely.
          if (
            [
              'if',
              'for',
              'while',
              'switch',
              'return',
              'function',
              'await',
              'new',
              'typeof',
              'URL', // wrapped in `new URL(...)` — not a call site
            ].includes(name)
          ) {
            continue;
          }
          first = name;
          break;
        }
        expect(
          first,
          `${lock.file}: first call in GET body is '${first}', expected 'assertRateLimit'`,
        ).toBe('assertRateLimit');
      });

      it(`uses prefix='${lock.prefix}'`, () => {
        const prefixRe = new RegExp(`prefix\\s*:\\s*['"\`]${lock.prefix}['"\`]`);
        expect(
          prefixRe.test(body),
          `${lock.file}: missing prefix: '${lock.prefix}' in GET body`,
        ).toBe(true);
      });

      it('uses `if (deny) return deny;` short-circuit', () => {
        // Tolerant on whitespace/parens.
        const denyRe = /if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/;
        expect(
          denyRe.test(body),
          `${lock.file}: missing 'if (deny) return deny;' short-circuit`,
        ).toBe(true);
      });

      it('passes a numeric `limit` within the documented band', () => {
        const limitRe = /\blimit\s*:\s*(\d+|RATE_LIMIT\.limit)/g;
        const matches = Array.from(body.matchAll(limitRe));
        expect(
          matches.length,
          `${lock.file}: no \`limit:\` field passed to assertRateLimit`,
        ).toBeGreaterThan(0);
        // If the route uses a RATE_LIMIT constant, resolve it from
        // the file scope.
        const constRe = /\bconst\s+RATE_LIMIT\s*=\s*\{([^}]+)\}/;
        const constMatch = constRe.exec(stripped);
        let resolved = NaN;
        if (constMatch) {
          const inner = constMatch[1];
          const lm = /limit\s*:\s*(\d+)/.exec(inner);
          if (lm) resolved = Number(lm[1]);
        } else {
          resolved = Number(matches[0][1]);
        }
        expect(
          Number.isFinite(resolved) && resolved >= lock.limitMin && resolved <= lock.limitMax,
          `${lock.file}: limit ${resolved} not in [${lock.limitMin}, ${lock.limitMax}]`,
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
            resolved >= lock.windowMsMin &&
            resolved <= lock.windowMsMax,
          `${lock.file}: windowMs ${resolved} not in [${lock.windowMsMin}, ${lock.windowMsMax}]`,
        ).toBe(true);
      });
    });
  }

  it('uses distinct prefixes — buckets must not fuse', () => {
    const prefixes = EXPECTED_ROUTES.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('every prefix is registered in the shared rate-limit registry', () => {
    // R48(a) — places prefixes must appear in
    // `tests/helpers/rate-limit-prefixes.ts` so collision detection
    // and other audits have a canonical list to compare against.
    for (const lock of EXPECTED_ROUTES) {
      expect(
        isKnownPrefix(lock.prefix),
        `places route '${lock.file}' uses prefix '${lock.prefix}' which is NOT in KNOWN_PREFIXES — register it in tests/helpers/rate-limit-prefixes.ts`,
      ).toBe(true);
    }
  });

  it('covers every route under app/api/places/', () => {
    const placesDir = path.join(APP_DIR, 'api/places');
    const found: string[] = [];
    for (const entry of fs.readdirSync(placesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const routePath = path.join(placesDir, entry.name, 'route.ts');
        if (fs.existsSync(routePath)) {
          found.push(`api/places/${entry.name}/route.ts`);
        }
      }
    }
    const locked = new Set(EXPECTED_ROUTES.map((r) => r.file));
    const unlocked = found.filter((f) => !locked.has(f));
    expect(
      unlocked,
      `Unlocked Places proxy route(s): ${unlocked.join(', ')}. Add to EXPECTED_ROUTES.`,
    ).toEqual([]);
  });
});
