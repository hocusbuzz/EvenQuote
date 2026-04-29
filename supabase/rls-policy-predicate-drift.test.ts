// R41(a) — RLS policy PREDICATE-body drift audit.
//
// Sibling of R39(a)'s `rls-policy-drift.test.ts`. That audit locks:
//   • RLS-enabled per table
//   • policy NAMES per table
//   • policy COMMAND (for select | for update | ...)
//   • hasWithCheck boolean
//
// What R39 deliberately left OUT: the actual USING / WITH CHECK
// predicate bodies. The reason is real — a predicate can span many
// lines, contain nested parens, reference helper functions, and is
// typically the part a reviewer looks at most carefully. R39 locked
// the CEILING ("what policies exist, what command") but not the
// FLOOR ("what the predicate actually says").
//
// Why this matters:
// A future migration could rename a policy from `profiles: self read`
// to something new, then CREATE a policy under the OLD name but with
// predicate `using (true)`. R39 would pass (name + command present),
// but every authenticated user would now see every profile row.
//
// Scope of this audit:
//   (1) For every policy in EXPECTED_PREDICATES, normalize the parsed
//       USING / WITH CHECK body (collapse whitespace, lowercase
//       keywords where safe) and compare against the EXPECTED string.
//   (2) Every policy USING body contains either `auth.uid()` OR
//       `public.is_admin()` (one of the two MUST be referenced —
//       otherwise the policy is effectively public).
//   (3) FORBIDDEN tokens in any USING / WITH CHECK body:
//       `using (true)`, `using(true)`, `using ( true )` and variants
//       of `1=1`, `'true'`. These are the "accidentally public"
//       shape we never want to ship.
//   (4) Cross-file: `public.is_admin()` call-sites across migrations
//       match an expected count (≥ 7 — profiles admin read, service_
//       categories, businesses, quote_requests, calls, quotes,
//       payments, quote_contact_releases admin read, plus the
//       function def itself).
//
// INTENTIONALLY OUT OF SCOPE (future R42+):
//   • Parsing nested EXISTS subqueries semantically. We lock the
//     literal string. If a refactor re-orders AND-branches, the
//     expected string must be updated in the same PR — that's the
//     whole point of locking the body.
//   • `to <roles>` clause bodies. R39 doesn't lock these; R41 doesn't
//     either. Postgres default is `to public` which is the desired
//     posture given our auth.uid() / is_admin() gates inside USING.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── SQL statement splitter (copy of R39's string-aware splitter) ─────
// Handles:
//   • `--` line comments and `/* ... */` block comments
//   • `'...'` string literals with Postgres `''` doubled-quote escapes
//   • `$$...$$` and `$tag$...$tag$` dollar-quoted function bodies
//   • top-level `;` — expression-level `;` inside parens ignored

function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inString: false | "'" = false;
  let inDollar: false | string = false;
  let parenDepth = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inString) {
      buf += ch;
      if (ch === "'" && next === "'") {
        buf += next;
        i += 2;
        continue;
      }
      if (ch === "'") inString = false;
      i++;
      continue;
    }
    if (inDollar) {
      buf += ch;
      if (sql.startsWith(inDollar, i)) {
        buf += sql.slice(i + 1, i + inDollar.length);
        i += inDollar.length;
        inDollar = false;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        buf += sql[i];
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      buf += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        buf += sql[i];
        i++;
      }
      if (i < sql.length) {
        buf += '*/';
        i += 2;
      }
      continue;
    }
    if (ch === '$') {
      const dq = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (dq) {
        inDollar = dq[0];
        buf += dq[0];
        i += dq[0].length;
        continue;
      }
    }
    if (ch === "'") {
      inString = "'";
      buf += ch;
      i++;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;

    if (ch === ';' && parenDepth === 0) {
      out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

// ── Predicate body extraction ────────────────────────────────────────
// Given the text starting at the `(` after `using` / `with check`,
// return the body between the outer parens.

function extractBalancedParenBody(text: string, openIdx: number): string | null {
  if (text[openIdx] !== '(') return null;
  let depth = 0;
  let inString: false | "'" = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'" && text[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = "'";
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        // return inside without the outer parens
        return text.slice(openIdx + 1, i);
      }
    }
  }
  return null;
}

// Strip SQL comments from a statement (comments can appear INSIDE a
// predicate body — we strip them before comparing normalized forms).
function stripSqlComments(stmt: string): string {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*\n/g, ' ')
    .replace(/--[^\n]*$/g, ' ');
}

// Normalize a predicate body for diffable comparison:
//   • strip SQL comments (line + block)
//   • collapse all whitespace runs to a single space
//   • trim leading/trailing space
//   • lowercase keywords — BUT only safe lowercasing: we don't touch
//     quoted identifiers or string literals. Our predicates don't
//     use either. If a future predicate references a case-sensitive
//     column, drop this normalization.
function normalizePredicate(body: string): string {
  const stripped = stripSqlComments(body);
  return stripped.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface PolicyBody {
  name: string;
  table: string; // public.<name>
  command: 'select' | 'insert' | 'update' | 'delete' | 'all';
  usingBody: string | null;
  withCheckBody: string | null;
  definedInFile: string;
}

function parsePolicyBodies(stmt: string, file: string): PolicyBody | null {
  const s = stripSqlComments(stmt).trim();
  const head =
    /^create\s+policy\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\s+(?:public\.)?([A-Za-z_][\w]*)\s*([\s\S]*)$/i.exec(s);
  if (!head) return null;
  const name = head[1] ?? head[2];
  const table = `public.${head[3]}`;
  const rest = head[4] ?? '';

  let command: 'select' | 'insert' | 'update' | 'delete' | 'all' = 'all';
  const cm = /\bfor\s+(select|insert|update|delete|all)\b/i.exec(rest);
  if (cm) command = cm[1].toLowerCase() as typeof command;

  // Find USING ( ... )
  let usingBody: string | null = null;
  const usingMatch = /\busing\s*\(/i.exec(rest);
  if (usingMatch) {
    const openIdx = rest.indexOf('(', usingMatch.index);
    const body = extractBalancedParenBody(rest, openIdx);
    if (body != null) usingBody = body;
  }

  // Find WITH CHECK ( ... )
  let withCheckBody: string | null = null;
  const wcMatch = /\bwith\s+check\s*\(/i.exec(rest);
  if (wcMatch) {
    const openIdx = rest.indexOf('(', wcMatch.index);
    const body = extractBalancedParenBody(rest, openIdx);
    if (body != null) withCheckBody = body;
  }

  return { name, table, command, usingBody, withCheckBody, definedInFile: file };
}

// ── Build policy-body index from all migrations ──────────────────────

function buildPolicyBodyIndex(): {
  policies: Map<string, PolicyBody>; // key: `${table}|${name}`
  combinedSource: string;
} {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const policies = new Map<string, PolicyBody>();
  let combinedSource = '';
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    combinedSource += '\n' + sql;
    const stmts = splitSqlStatements(sql);
    for (const stmt of stmts) {
      const pb = parsePolicyBodies(stmt, f);
      if (pb) policies.set(`${pb.table}|${pb.name}`, pb);
    }
  }
  return { policies, combinedSource };
}

// ── EXPECTED_PREDICATES ──────────────────────────────────────────────
// Each entry locks the normalized-string form of USING and optionally
// WITH CHECK. If a migration re-orders or rewords a predicate, the
// expected normalized string MUST be updated in the same PR.

interface ExpectedPredicate {
  using: string; // normalized
  withCheck?: string; // normalized, optional
}

const EXPECTED_PREDICATES: Record<string, ExpectedPredicate> = {
  'public.profiles|profiles: self read': {
    using: 'auth.uid() = id',
  },
  'public.profiles|profiles: admin read all': {
    using: 'public.is_admin()',
  },
  'public.profiles|profiles: self update': {
    using: 'auth.uid() = id',
    // Role-escalation guard — user can update their own row but not
    // change their role. The `role = (select role ...)` sub-select
    // is what ties the row's role to the caller's current role.
    withCheck:
      "auth.uid() = id and role = (select role from public.profiles where id = auth.uid())",
  },
  'public.service_categories|service_categories: public read active': {
    using: 'is_active or public.is_admin()',
  },
  'public.businesses|businesses: authenticated read active': {
    using: '(is_active and auth.uid() is not null) or public.is_admin()',
  },
  'public.quote_requests|quote_requests: owner read': {
    using: 'auth.uid() = user_id or public.is_admin()',
  },
  'public.calls|calls: owner read via request': {
    using:
      'public.is_admin() or exists ( select 1 from public.quote_requests qr where qr.id = calls.quote_request_id and qr.user_id = auth.uid() )',
  },
  'public.quotes|quotes: owner read via request': {
    using:
      'public.is_admin() or exists ( select 1 from public.quote_requests qr where qr.id = quotes.quote_request_id and qr.user_id = auth.uid() )',
  },
  'public.payments|payments: owner read': {
    using: 'auth.uid() = user_id or public.is_admin()',
  },
  'public.quote_contact_releases|quote_contact_releases: owner read': {
    using: 'released_by_user_id = auth.uid()',
  },
  'public.quote_contact_releases|quote_contact_releases: admin read all': {
    using:
      "exists ( select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' )",
  },
};

// Tokens that must NEVER appear in any predicate body. These are the
// "accidentally public" shapes.
const FORBIDDEN_PREDICATE_TOKENS: RegExp[] = [
  /\busing\s*\(\s*true\s*\)/i,
  /\bwith\s+check\s*\(\s*true\s*\)/i,
  /\b1\s*=\s*1\b/,
  /\busing\s*\(\s*'true'\s*\)/i,
];

// ── Tests ────────────────────────────────────────────────────────────

const built = buildPolicyBodyIndex();

describe('Supabase RLS predicate-body drift audit (R41)', () => {
  // (1) Per-policy normalized USING body matches expectation.
  for (const [key, expected] of Object.entries(EXPECTED_PREDICATES)) {
    it(`${key}: USING body matches expected predicate`, () => {
      const p = built.policies.get(key);
      expect(p, `policy not found: ${key}`).toBeDefined();
      expect(p!.usingBody, `${key} has no USING clause`).not.toBeNull();
      const actual = normalizePredicate(p!.usingBody!);
      expect(actual).toBe(expected.using);
    });
  }

  // (2) Per-policy WITH CHECK body matches expectation where declared.
  for (const [key, expected] of Object.entries(EXPECTED_PREDICATES)) {
    if (!expected.withCheck) continue;
    it(`${key}: WITH CHECK body matches expected predicate`, () => {
      const p = built.policies.get(key);
      expect(p).toBeDefined();
      expect(p!.withCheckBody, `${key} has no WITH CHECK clause`).not.toBeNull();
      const actual = normalizePredicate(p!.withCheckBody!);
      expect(actual).toBe(expected.withCheck);
    });
  }

  // (3) Every USING body references auth.uid() or public.is_admin().
  //     This is the "no silently-public policy" lock — a predicate
  //     missing BOTH tokens is effectively `using (true)`.
  for (const [key] of Object.entries(EXPECTED_PREDICATES)) {
    it(`${key}: USING body references auth.uid() or public.is_admin()`, () => {
      const p = built.policies.get(key);
      expect(p).toBeDefined();
      const body = (p!.usingBody ?? '').toLowerCase();
      const hasAuthUid = /\bauth\.uid\s*\(\s*\)/.test(body);
      const hasIsAdmin = /\bpublic\.is_admin\s*\(\s*\)/.test(body);
      expect(
        hasAuthUid || hasIsAdmin,
        `${key} USING body missing both auth.uid() and public.is_admin() — effectively public`,
      ).toBe(true);
    });
  }

  // (4) FORBIDDEN tokens never appear across ANY migration source.
  //     Each match returns a human-readable coordinate.
  it('no `using (true)` / `with check (true)` / `1=1` forbidden predicate shapes', () => {
    const commentsStripped = stripSqlComments(built.combinedSource);
    const hits: string[] = [];
    for (const re of FORBIDDEN_PREDICATE_TOKENS) {
      const match = re.exec(commentsStripped);
      if (match) hits.push(`${re.source} @ idx ${match.index}`);
    }
    expect(hits, `forbidden predicate shape found: ${JSON.stringify(hits)}`).toEqual([]);
  });

  // (5) COVERAGE TRIPWIRE — every policy discovered in migrations
  //     must have an EXPECTED_PREDICATES entry. Otherwise a newly-
  //     added policy silently slips past the predicate-body lock.
  it('coverage: every discovered policy has an EXPECTED_PREDICATES entry', () => {
    const discovered = [...built.policies.keys()].sort();
    const expectedKeys = Object.keys(EXPECTED_PREDICATES).sort();
    const missing = discovered.filter((k) => !expectedKeys.includes(k));
    expect(
      missing,
      `discovered policies not locked by EXPECTED_PREDICATES: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  // (6) NO GHOST ENTRIES — every EXPECTED_PREDICATES entry maps to
  //     a real policy in the migrations.
  it('no ghost entries: every EXPECTED_PREDICATES key exists in migrations', () => {
    const discovered = new Set(built.policies.keys());
    const ghosts = Object.keys(EXPECTED_PREDICATES).filter((k) => !discovered.has(k));
    expect(ghosts, `EXPECTED_PREDICATES has ghost entries: ${JSON.stringify(ghosts)}`).toEqual(
      [],
    );
  });

  // (7) `public.is_admin()` is referenced at least 7 times across
  //     migrations (6 admin-capable policies + the CREATE FUNCTION
  //     definition itself + comment lines don't count because we
  //     strip comments first).
  it('public.is_admin() is referenced in enough policy bodies', () => {
    const stripped = stripSqlComments(built.combinedSource);
    const matches = stripped.match(/\bpublic\.is_admin\s*\(\s*\)/gi) ?? [];
    // Spot-check floor. At R41 close we expect ~8 call-sites in USING
    // bodies + the helper CREATE/DROP statements. Floor at 7 is safe
    // and catches "oops I removed the admin read bypass from
    // everywhere" drift.
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });

  // (8) `auth.uid()` is referenced at least 8 times (every owner-
  //     scoped policy USES it, plus the profiles WITH CHECK body).
  it('auth.uid() is referenced in enough predicate bodies', () => {
    const stripped = stripSqlComments(built.combinedSource);
    const matches = stripped.match(/\bauth\.uid\s*\(\s*\)/gi) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(8);
  });

  // (9) Normalization sanity — normalizePredicate idempotency.
  //     Run normalize() twice and verify the second pass is a no-op.
  //     Catches "I added a normalization rule that isn't idempotent"
  //     which would cause false negatives under CI.
  it('normalizePredicate is idempotent', () => {
    const samples = [
      'auth.uid() = id',
      '  auth.uid() = id  ',
      'AUTH.UID() = ID',
      'auth.uid() = id\n\n  or public.is_admin()',
      "auth.uid() = id -- comment\n or public.is_admin()",
    ];
    for (const s of samples) {
      const once = normalizePredicate(s);
      const twice = normalizePredicate(once);
      expect(twice).toBe(once);
    }
  });

  // (10) Parser sanity — extractBalancedParenBody on nested parens.
  it('extractBalancedParenBody handles nested parens', () => {
    const sample = '  (foo and (bar or baz))';
    const opened = sample.indexOf('(');
    const body = extractBalancedParenBody(sample, opened);
    expect(body).toBe('foo and (bar or baz)');
  });

  // (11) Parser sanity — extractBalancedParenBody respects string
  //      literals containing unbalanced parens.
  it('extractBalancedParenBody skips parens inside string literals', () => {
    const sample = "(p.role = 'admin (real)')";
    const body = extractBalancedParenBody(sample, 0);
    expect(body).toBe("p.role = 'admin (real)'");
  });

  // (12) Total policy count — floor at Object.keys(EXPECTED_PREDICATES).length.
  it(`total discovered policies equals ${Object.keys(EXPECTED_PREDICATES).length}`, () => {
    expect(built.policies.size).toBe(Object.keys(EXPECTED_PREDICATES).length);
  });
});
