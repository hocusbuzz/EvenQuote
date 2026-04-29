// R48(h) — Dev-route rate-limit defense-in-depth audit.
//
// `/api/dev/*` routes have two-layer auth via `assertDevToken`:
//   1. NODE_ENV gate (404 in prod — no probe signal)
//   2. DEV_TRIGGER_TOKEN constant-time match (401 on mismatch)
//
// R47 close documented the deliberate decision to leave dev routes
// at single-layer rate-limiting (i.e., NONE), reasoning that the
// NODE_ENV gate alone was sufficient. R48(h) adds a third layer:
// `assertRateLimit` AFTER `assertDevToken`. The ORDERING matters —
// putting rate-limit BEFORE the dev-token check would let a flooder
// in prod observe 429 responses (a probe signal) where today they
// only see 404. AFTER the token check, every reject path is still
// 404 in prod; the limiter only kicks in once a token-holding caller
// is already through the gate.
//
// What we lock per dev route:
//   1. The route imports `assertRateLimit` from
//      `@/lib/security/rate-limit-auth`.
//   2. The route ALSO imports `assertDevToken` from
//      `@/lib/security/dev-token-auth` (sanity — the audit applies
//      only to routes already gated by the dev token).
//   3. Inside the exported handler body, `assertDevToken(req)`
//      appears BEFORE `assertRateLimit(req, ...)`. Order-sensitive.
//   4. The `prefix` matches the documented per-route namespace and
//      is registered in `tests/helpers/rate-limit-prefixes.ts`.
//   5. The deny path uses `if (...Deny) return ...Deny;` — i.e. a
//      429 short-circuit after the rate-limit call.
//   6. Numeric `limit` and `windowMs` within documented bands.
//
// Why a posterity lock: the no-probe-in-prod property is a
// fragile-to-the-eye contract. The wrong direction's correction (rate
// limit moves above token check) would silently weaken security; only
// a regression test surfaces it. R47(c)'s pattern of locking ordering
// at the file level applies here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  stripCommentsPreservingPositions,
  extractExportedAsyncFunctionBody,
} from '../../../tests/helpers/source-walker';
import { isKnownPrefix } from '../../../tests/helpers/rate-limit-prefixes';

type DevRouteLock = {
  /** Repo-relative path to the route file. */
  file: string;
  /** Exported handler method (GET / POST / …). */
  method: 'GET' | 'POST';
  /** Documented prefix passed to assertRateLimit. */
  prefix: string;
  /** Limit must be in this inclusive range. */
  limitMin: number;
  limitMax: number;
  /** WindowMs must be in this inclusive range. */
  windowMsMin: number;
  windowMsMax: number;
};

const EXPECTED_ROUTES: DevRouteLock[] = [
  {
    file: 'app/api/dev/trigger-call/route.ts',
    method: 'GET',
    prefix: 'dev-trigger-call',
    limitMin: 10,
    limitMax: 100,
    windowMsMin: 30_000,
    windowMsMax: 120_000,
  },
  {
    file: 'app/api/dev/backfill-call/route.ts',
    method: 'GET',
    prefix: 'dev-backfill-call',
    limitMin: 10,
    limitMax: 100,
    windowMsMin: 30_000,
    windowMsMax: 120_000,
  },
  {
    file: 'app/api/dev/skip-payment/route.ts',
    method: 'POST',
    prefix: 'dev-skip-payment',
    limitMin: 10,
    limitMax: 100,
    windowMsMin: 30_000,
    windowMsMax: 120_000,
  },
];

describe('R48(h) — dev-route rate-limit drift audit', () => {
  for (const lock of EXPECTED_ROUTES) {
    describe(lock.file, () => {
      const full = path.resolve(process.cwd(), lock.file);
      const source = fs.readFileSync(full, 'utf8');
      const stripped = stripCommentsPreservingPositions(source);
      const body =
        extractExportedAsyncFunctionBody(stripped, lock.method) ?? '';

      it('imports assertDevToken (precondition)', () => {
        expect(
          /import\s+\{\s*assertDevToken\s*\}\s+from\s+['"]@\/lib\/security\/dev-token-auth['"]/.test(
            stripped,
          ),
          `${lock.file}: missing assertDevToken import`,
        ).toBe(true);
      });

      it('imports assertRateLimit', () => {
        expect(
          /import\s+\{\s*assertRateLimit\s*\}\s+from\s+['"]@\/lib\/security\/rate-limit-auth['"]/.test(
            stripped,
          ),
          `${lock.file}: missing assertRateLimit import`,
        ).toBe(true);
      });

      it(`exports async ${lock.method}(req) handler`, () => {
        expect(body.length, `${lock.file}: ${lock.method}(req) not found`)
          .toBeGreaterThan(0);
      });

      it('assertDevToken is invoked BEFORE assertRateLimit (no-probe-in-prod ordering)', () => {
        const tokenIdx = body.indexOf('assertDevToken(');
        const rateIdx = body.indexOf('assertRateLimit(');
        expect(tokenIdx, `${lock.file}: assertDevToken(...) call not found`)
          .toBeGreaterThan(-1);
        expect(rateIdx, `${lock.file}: assertRateLimit(...) call not found`)
          .toBeGreaterThan(-1);
        expect(
          tokenIdx < rateIdx,
          `${lock.file}: assertDevToken MUST come before assertRateLimit — putting rate-limit first leaks a probe signal in prod (404 vs 429)`,
        ).toBe(true);
      });

      it(`uses prefix='${lock.prefix}'`, () => {
        const re = new RegExp(`prefix\\s*:\\s*['"\`]${lock.prefix}['"\`]`);
        expect(
          re.test(body),
          `${lock.file}: missing prefix: '${lock.prefix}' in ${lock.method} body`,
        ).toBe(true);
      });

      it('prefix is registered in the shared rate-limit registry', () => {
        expect(
          isKnownPrefix(lock.prefix),
          `${lock.file}: prefix '${lock.prefix}' is NOT in KNOWN_PREFIXES — register it in tests/helpers/rate-limit-prefixes.ts`,
        ).toBe(true);
      });

      it('uses if-deny-return short-circuit', () => {
        // Permissive — names like rateLimitDeny / rateDeny / deny are
        // all fine. Lock that there's an `if (X) return X;` shape
        // immediately around the assertRateLimit call.
        const re =
          /(?:const|let)\s+(\w+)\s*=\s*assertRateLimit\([\s\S]*?\);\s*if\s*\(\s*\1\s*\)\s*return\s+\1\s*;/;
        expect(
          re.test(body),
          `${lock.file}: assertRateLimit must follow the const X = assertRateLimit(...); if (X) return X; pattern`,
        ).toBe(true);
      });

      it(`limit is within [${lock.limitMin}, ${lock.limitMax}]`, () => {
        const m = /limit\s*:\s*([\d_]+)/.exec(body);
        expect(m, `${lock.file}: no numeric limit found`).not.toBeNull();
        const limit = Number((m![1] || '0').replace(/_/g, ''));
        expect(
          Number.isFinite(limit) &&
            limit >= lock.limitMin &&
            limit <= lock.limitMax,
          `${lock.file}: limit ${limit} not in [${lock.limitMin}, ${lock.limitMax}]`,
        ).toBe(true);
      });

      it(`windowMs is within [${lock.windowMsMin}, ${lock.windowMsMax}]`, () => {
        const m = /windowMs\s*:\s*([\d_]+)/.exec(body);
        expect(m, `${lock.file}: no numeric windowMs found`).not.toBeNull();
        const wm = Number((m![1] || '0').replace(/_/g, ''));
        expect(
          Number.isFinite(wm) &&
            wm >= lock.windowMsMin &&
            wm <= lock.windowMsMax,
          `${lock.file}: windowMs ${wm} not in [${lock.windowMsMin}, ${lock.windowMsMax}]`,
        ).toBe(true);
      });
    });
  }

  it('uses distinct prefixes — buckets must not fuse across dev routes', () => {
    const prefixes = EXPECTED_ROUTES.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('covers every route under app/api/dev/', () => {
    const devDir = path.resolve(process.cwd(), 'app/api/dev');
    const found: string[] = [];
    for (const entry of fs.readdirSync(devDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const routePath = path.join(devDir, entry.name, 'route.ts');
        if (fs.existsSync(routePath)) {
          found.push(`app/api/dev/${entry.name}/route.ts`);
        }
      }
    }
    const locked = new Set(EXPECTED_ROUTES.map((r) => r.file));
    const unlocked = found.filter((f) => !locked.has(f));
    expect(
      unlocked,
      `app/api/dev/* routes not locked by R48(h): ${unlocked.join(', ')}`,
    ).toEqual([]);
  });
});
