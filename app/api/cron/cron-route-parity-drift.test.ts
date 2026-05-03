// R43(b) — Cron route handler POST/GET parity drift audit.
//
// All routes under `app/api/cron/**` are designed to be callable by
// EITHER of two schedulers:
//
//   • pg_cron (via pg_net.http_post) — POST-only, supplies
//     `Authorization: Bearer <CRON_SECRET>`.
//   • Vercel Cron — GET-only fallback, supplies
//     `x-cron-secret: <CRON_SECRET>`.
//
// If POST and GET ever diverge — e.g. a refactor adds body parsing to
// POST but not GET, or GET starts skipping an auth check "because it's
// just a manual curl" — the two schedulers start producing different
// results for nominally the same work. This audit locks the parity
// invariant at the SOURCE level:
//
//   1. Every cron route exports BOTH `GET` and `POST`.
//   2. Both methods share a single delegate (a `handle(req)` call,
//      no inline logic duplication).
//   3. The delegate is a local function (not re-imported), and the
//      GET/POST bodies do nothing other than `return handle(req)`.
//   4. The delegate starts by calling `assertCronAuth(req)` and
//      returning immediately on deny — auth MUST come before any
//      downstream work.
//   5. `assertCronAuth` is imported from `@/lib/security/cron-auth`.
//   6. `export const dynamic = 'force-dynamic'` is present (cron routes
//      must never be statically cached).
//   7. `export const runtime = 'nodejs'` is present (supabase admin +
//      resend require Node — `edge` would break them at runtime).
//
// This is a posterity lock. All three existing cron routes are
// already compliant. New cron routes added under `app/api/cron/**`
// must follow the same shape or this audit fails.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsAndStringsPreservingPositions, stripCommentsOnlyRegex } from '@/tests/helpers/source-walker';

const CRON_DIR = join(process.cwd(), 'app/api/cron');

function discoverCronRoutes(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(CRON_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(CRON_DIR, entry.name, 'route.ts');
    try {
      readFileSync(p, 'utf8');
      out.push(p);
    } catch {
      // No route.ts in this dir — ignore.
    }
  }
  return out.sort();
}

const ROUTES = discoverCronRoutes();

describe('app/api/cron — POST/GET parity drift (R43(b))', () => {
  it('discovery finds at least one cron route', () => {
    // Guard: if discovery silently returns [], the per-route
    // parameterised checks below would vacuously pass.
    expect(ROUTES.length).toBeGreaterThanOrEqual(1);
  });

  it('discovery catalog matches the expected cron route set', () => {
    // Tripwire: if a new cron route is added, this test fails until
    // the EXPECTED list is updated — forcing a conscious decision.
    const EXPECTED = new Set([
      join(CRON_DIR, 'check-status/route.ts'),
      join(CRON_DIR, 'check-stuck-requests/route.ts'),
      join(CRON_DIR, 'dispatch-scheduled-requests/route.ts'),
      join(CRON_DIR, 'reconcile-calls/route.ts'),
      join(CRON_DIR, 'retry-failed-calls/route.ts'),
      join(CRON_DIR, 'send-reports/route.ts'),
      join(CRON_DIR, 'send-winbacks/route.ts'),
    ]);
    const actual = new Set(ROUTES);
    expect(actual).toEqual(EXPECTED);
  });

  for (const routePath of ROUTES) {
    const label = routePath.replace(process.cwd() + '/', '');
    describe(label, () => {
      const src = readFileSync(routePath, 'utf8');
      // Strip comments + string bodies so doc-block examples like
      // `// export async function GET(...)` don't false-positive.
      const stripped = stripCommentsAndStringsPreservingPositions(src);
      // String-literal-preserving variant for assertions that must
      // match on quoted values (e.g. `'force-dynamic'`, import
      // specifier `'@/lib/security/cron-auth'`). Strips comments
      // only, so doc-block mentions still don't false-positive.
      const strippedComments = stripCommentsOnlyRegex(src);

      it('exports BOTH GET and POST', () => {
        expect(/export\s+async\s+function\s+GET\s*\(/.test(stripped)).toBe(true);
        expect(/export\s+async\s+function\s+POST\s*\(/.test(stripped)).toBe(true);
      });

      it('GET and POST both delegate to a single `handle(req)` function', () => {
        // Extract GET body.
        const getBody = extractMethodBody(stripped, 'GET');
        const postBody = extractMethodBody(stripped, 'POST');
        expect(getBody, `GET body not extractable in ${label}`).not.toBeNull();
        expect(postBody, `POST body not extractable in ${label}`).not.toBeNull();
        // Each body must be essentially `return handle(req)` — one
        // statement, no auth, no work.
        const getTrimmed = getBody!.replace(/\s+/g, ' ').trim();
        const postTrimmed = postBody!.replace(/\s+/g, ' ').trim();
        expect(getTrimmed).toMatch(/^\{\s*return\s+handle\s*\(\s*req\s*\)\s*;?\s*\}$/);
        expect(postTrimmed).toMatch(/^\{\s*return\s+handle\s*\(\s*req\s*\)\s*;?\s*\}$/);
      });

      it('declares a local async `handle(req)` function', () => {
        // The delegate must be locally defined, not re-imported from
        // some sibling route. If someone exports `handle` from a
        // shared module and imports it here, that pattern is fine
        // in principle — but then the parity invariant moves to the
        // shared module, not this file. For now we lock the
        // locally-defined convention.
        expect(/async\s+function\s+handle\s*\(\s*req\s*:\s*Request\s*\)/.test(stripped)).toBe(true);
      });

      it('`handle` calls `assertCronAuth(req)` before any other work', () => {
        const handleBody = extractMethodBody(stripped, 'handle');
        expect(handleBody, `handle body not extractable in ${label}`).not.toBeNull();
        // Find the first non-whitespace statement in `handle`. It
        // must be either `const deny = assertCronAuth(req);` or the
        // equivalent `if` form.
        const firstNonWs = handleBody!
          .replace(/^\{\s*/, '')
          .replace(/\s+/g, ' ')
          .trim();
        // The first statement(s) must reach assertCronAuth BEFORE any
        // other call. Look for `assertCronAuth(` before any other
        // function-call-looking token. Tokens in the allow-list (the
        // `const deny = ` / `if (deny) return deny;` boilerplate) are
        // allowed to precede it.
        const preAuth = firstNonWs.slice(0, firstNonWs.indexOf('assertCronAuth('));
        expect(preAuth).not.toBe(''); // assertCronAuth must be present
        // Nothing before `assertCronAuth(` should look like a function
        // call (parenthesis-with-content pattern), except bare kw/name
        // fragments that are part of its own declaration.
        expect(/\b[A-Za-z_$][\w$]*\s*\([^)]/.test(preAuth)).toBe(false);
      });

      it('imports `assertCronAuth` from `@/lib/security/cron-auth`', () => {
        const importRe = /import\s*\{[^}]*\bassertCronAuth\b[^}]*\}\s*from\s*['"]@\/lib\/security\/cron-auth['"]/;
        expect(importRe.test(strippedComments)).toBe(true);
      });

      it("exports `const dynamic = 'force-dynamic'`", () => {
        expect(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(strippedComments)).toBe(true);
      });

      it("exports `const runtime = 'nodejs'`", () => {
        expect(/export\s+const\s+runtime\s*=\s*['"]nodejs['"]/.test(strippedComments)).toBe(true);
      });
    });
  }
});

// Walk a brace-balanced function body starting from `<name>(` in
// `stripped`. Returns the `{...}` span (inclusive), or null if the
// function isn't found or braces never balance. Uses the comment-
// and string-stripped source so inline `{` or `}` characters inside
// strings/regexes don't throw off the balance walk.
function extractMethodBody(stripped: string, name: string): string | null {
  const headerRe = new RegExp(
    `(?:export\\s+async\\s+function|async\\s+function|function)\\s+${name}\\s*\\(`,
  );
  const m = headerRe.exec(stripped);
  if (!m) return null;
  // Walk to closing paren.
  const openParenIdx = m.index + m[0].length - 1;
  let paren = 1;
  let i = openParenIdx + 1;
  for (; i < stripped.length && paren > 0; i++) {
    if (stripped[i] === '(') paren++;
    else if (stripped[i] === ')') paren--;
  }
  if (paren !== 0) return null;
  // Find opening brace of body.
  let j = i;
  while (j < stripped.length && stripped[j] !== '{') j++;
  if (stripped[j] !== '{') return null;
  let depth = 1;
  let k = j + 1;
  for (; k < stripped.length && depth > 0; k++) {
    if (stripped[k] === '{') depth++;
    else if (stripped[k] === '}') depth--;
  }
  if (depth !== 0) return null;
  return stripped.slice(j, k);
}
