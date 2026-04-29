// R39(a) — Supabase RLS (Row Level Security) policy drift audit.
//
// Highest-blast-radius regression surface in the codebase. A silent
// `drop policy` or an accidentally-removed `alter table ... enable row
// level security` would open every row on a PII-bearing table to any
// authenticated user. The app-level shape tests (R27-R38) don't see
// RLS because they mock Supabase — the mock doesn't enforce policies.
// The real DB applies them at query time. So RLS drift only surfaces
// at preview-deploy against a real Postgres.
//
// This audit closes that gap. It parses every supabase/migrations/*.sql
// file in lexical order, builds the cumulative RLS state
// (table → {rlsEnabled, policies}), and compares against an explicit
// `EXPECTED_RLS` map naming every table the app depends on for
// user-scoped access.
//
// Coverage matrix (R39 close):
//
//   public.profiles               RLS ON — 3 policies (self read,
//                                   admin read all, self update).
//                                   WITH CHECK prevents role escalation.
//   public.service_categories     RLS ON — 1 policy (public read active).
//   public.businesses             RLS ON — 1 policy (authenticated
//                                   read active). Is_active + auth.uid()
//                                   NOT NULL is the conjunction.
//   public.quote_requests         RLS ON — 1 policy (owner read).
//                                   CLIENT-WRITE DENY: no INSERT/UPDATE/
//                                   DELETE policy exists; writes happen
//                                   server-side with the service role
//                                   which bypasses RLS.
//   public.calls                  RLS ON — 1 policy (owner read via
//                                   request join). No client writes.
//   public.quotes                 RLS ON — 1 policy (owner read via
//                                   request join). No client writes.
//   public.payments               RLS ON — 1 policy (owner read).
//                                   No client writes.
//   public.quote_contact_releases RLS ON — 2 policies (owner read,
//                                   admin read all). No client writes.
//   public.waitlist_signups       RLS ON — 0 policies (deliberate;
//                                   service-role-only, documented in
//                                   0005_multi_vertical.sql header).
//   public.vapi_phone_numbers     RLS ON — 0 policies (deliberate;
//                                   service-role-only).
//   public.csp_violations         RLS ON — 0 policies (deliberate;
//                                   service-role-only).
//
// INVARIANTS LOCKED BY THIS AUDIT
// ───────────────────────────────
// (1) RLS ENABLED for every table in EXPECTED_RLS. A stray migration
//     that drops the `alter table ... enable row level security` call
//     is caught at CI time instead of at preview-deploy against real
//     customer data.
// (2) POLICY COUNT per table matches the expected count. Adding a
//     policy "just to fix local dev" would silently widen access to
//     authenticated users; removing a policy would silently BLOCK
//     authenticated users from legitimate reads.
// (3) POLICY NAMES match the expected set per table. Names are
//     stable across migrations because they're the handle
//     `alter policy` / `drop policy` operate on.
// (4) POLICY COMMANDS (for select | for insert | for update | for
//     delete | for all) match the expected per-policy command. A
//     "self read" policy accidentally promoted to "for all" would
//     silently grant UPDATE + DELETE on profiles.
// (5) NO UNEXPECTED WRITE POLICIES on the PII-bearing tables. Every
//     customer-writable table (quote_requests, quotes, calls,
//     payments, quote_contact_releases) should have ZERO client-
//     facing INSERT / UPDATE / DELETE policies — all writes go
//     through server actions using the service role. A migration
//     that introduces, say, a `"quote_requests: self insert"`
//     policy would re-open the client-write surface we deliberately
//     closed and should land as a PR red flag.
// (6) IS_ADMIN() HELPER is present and SECURITY DEFINER. The helper
//     is what prevents infinite recursion between the profiles RLS
//     and the is_admin lookup. If a future refactor removes the
//     SECURITY DEFINER flag, profile reads start infinite-looping
//     against RLS.
// (7) NO ALTER POLICY / DROP POLICY ever appears in migrations.
//     Every policy is CREATEd once in its origin migration. If one
//     needs to change, the right pattern is (drop + recreate) in a
//     single transaction — and the audit should be extended to
//     recognize that pattern before merging.
//
// Intentionally out of scope:
//   • Migration-level validation that policies compile (the Supabase
//     CLI does that). We check syntax-shape only.
//   • Helper function bodies beyond `is_admin()`. The R36+R37
//     migrations-drift + rpc-args-type-drift audits cover those.
//   • The `with check` clauses on UPDATE policies beyond locking
//     their presence. The profiles "self update" `with check`
//     prevents role escalation; future policies with WITH CHECK get
//     their presence asserted but not their exact predicate.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── Types ────────────────────────────────────────────────────────────
type PolicyCommand = 'select' | 'insert' | 'update' | 'delete' | 'all';

interface PolicyRecord {
  name: string;
  table: string; // schema.table
  command: PolicyCommand;
  hasWithCheck: boolean;
  definedInFile: string;
}

interface TableRlsState {
  rlsEnabled: boolean;
  policies: PolicyRecord[];
}

type RlsSchema = Map<string, TableRlsState>; // key: schema.table

// ── SQL statement splitter (reuses the string-aware pattern from R36) ─
// Handles:
//   • `--` line comments and `/* ... */` block comments
//   • `'...'` string literals with Postgres `''` doubled-quote escapes
//   • `$$...$$` and `$tag$...$tag$` dollar-quoted function bodies
// Splits on top-level `;` only.

function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inString: false | "'" = false;
  let inDollar: false | string = false; // the full `$tag$` delimiter
  let parenDepth = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inString) {
      buf += ch;
      if (ch === "'" && next === "'") {
        // Doubled-single-quote escape.
        buf += next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        inString = false;
      }
      i++;
      continue;
    }
    if (inDollar) {
      buf += ch;
      // Try to match the closing $tag$ at position i.
      if (sql.startsWith(inDollar, i)) {
        buf += sql.slice(i + 1, i + inDollar.length);
        i += inDollar.length;
        inDollar = false;
        continue;
      }
      i++;
      continue;
    }

    // `--` line comment.
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        buf += sql[i];
        i++;
      }
      continue;
    }
    // `/* ... */` block comment.
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
    // `$tag$` dollar-quoted string open.
    if (ch === '$') {
      const dq = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (dq) {
        inDollar = dq[0];
        buf += dq[0];
        i += dq[0].length;
        continue;
      }
    }
    // `'` string open.
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

// ── Parsers ──────────────────────────────────────────────────────────

// Strip SQL comments from a statement so leading `-- foo\n` sections
// don't defeat the anchored regex below. Preserves character count is
// NOT required here — the regexes use \s+ tolerantly.
function stripSqlComments(stmt: string): string {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*\n/g, ' ')
    .replace(/--[^\n]*$/g, ' ');
}

function parseEnableRls(stmt: string): string | null {
  // alter table [public.]<name> enable row level security
  const s = stripSqlComments(stmt).trim();
  const m = /^alter\s+table\s+(?:public\.)?([A-Za-z_][\w]*)\s+enable\s+row\s+level\s+security\s*$/is.exec(
    s,
  );
  if (!m) return null;
  return `public.${m[1]}`;
}

function parseCreatePolicy(stmt: string, file: string): PolicyRecord | null {
  // create policy "<name>" on [public.]<table> [for <cmd>] [to <roles>]
  // [using (<expr>)] [with check (<expr>)]
  //
  // Policy name may be double-quoted or bare identifier. Use a tolerant
  // regex; we only need name, table, command, hasWithCheck. The USING /
  // WITH CHECK bodies can contain parens so we do NOT try to parse
  // them — we just detect whether `with check` appears at top level.

  const s = stripSqlComments(stmt).trim();
  const head = /^create\s+policy\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\s+(?:public\.)?([A-Za-z_][\w]*)\s*([\s\S]*)$/i.exec(
    s,
  );
  if (!head) return null;
  const name = head[1] ?? head[2];
  const table = `public.${head[3]}`;
  const rest = head[4] ?? '';

  // Command. Absent = "for all" per Postgres default. Be explicit.
  let command: PolicyCommand = 'all';
  const cm = /\bfor\s+(select|insert|update|delete|all)\b/i.exec(rest);
  if (cm) command = cm[1].toLowerCase() as PolicyCommand;

  const hasWithCheck = /\bwith\s+check\s*\(/i.test(rest);

  return { name, table, command, hasWithCheck, definedInFile: file };
}

function parseAlterOrDropPolicy(
  stmt: string,
): { op: 'alter' | 'drop'; name: string; table: string } | null {
  // alter policy "<name>" on [public.]<table> ...
  // drop policy [if exists] "<name>" on [public.]<table>
  const s = stripSqlComments(stmt).trim();
  const m = /^(alter|drop)\s+policy\s+(?:if\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(
    s,
  );
  if (!m) return null;
  return {
    op: m[1].toLowerCase() as 'alter' | 'drop',
    name: m[2] ?? m[3],
    table: `public.${m[4]}`,
  };
}

// ── Build cumulative RLS state across all migrations ─────────────────

function buildRlsSchema(): {
  schema: RlsSchema;
  alterOrDropCount: number;
  isAdminDefinerCount: number;
  isAdminCreateCount: number;
} {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const schema: RlsSchema = new Map();
  let alterOrDropCount = 0;
  let isAdminDefinerCount = 0;
  let isAdminCreateCount = 0;

  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const stmts = splitSqlStatements(sql);
    // First pass: collect every `create policy` name+table in THIS file
    // so the second pass can classify `drop policy if exists` as the
    // idempotent "drop-then-recreate" pattern (added R45(c)) — those
    // are safe because the recreate is locked by R41's predicate body
    // audit.
    const createdInFile = new Set<string>(); // "name|public.table"
    for (const stmt of stmts) {
      const p = parseCreatePolicy(stmt, f);
      if (p) createdInFile.add(`${p.name}|${p.table}`);
    }
    for (const stmt of stmts) {
      const enabled = parseEnableRls(stmt);
      if (enabled) {
        const cur = schema.get(enabled) ?? { rlsEnabled: false, policies: [] };
        cur.rlsEnabled = true;
        schema.set(enabled, cur);
        continue;
      }
      const policy = parseCreatePolicy(stmt, f);
      if (policy) {
        const cur = schema.get(policy.table) ?? { rlsEnabled: false, policies: [] };
        cur.policies.push(policy);
        schema.set(policy.table, cur);
        continue;
      }
      const altered = parseAlterOrDropPolicy(stmt);
      if (altered) {
        // Exempt `drop policy if exists X on T` when a matching
        // `create policy X on T` exists in the same file — that's the
        // idempotent drop-then-recreate pattern. `alter policy` is
        // never exempt (it would silently mutate a predicate without
        // updating R41's EXPECTED_PREDICATES).
        const isIdempotentRecreate =
          altered.op === 'drop' &&
          /\bdrop\s+policy\s+if\s+exists\b/i.test(stripSqlComments(stmt)) &&
          createdInFile.has(`${altered.name}|${altered.table}`);
        if (!isIdempotentRecreate) alterOrDropCount++;
        continue;
      }

      // is_admin() helper presence + SECURITY DEFINER check.
      // The helper spans multiple lines; rather than parse the full
      // function body, we test lexical properties of the statement.
      // Strip comments first so a doc-comment like `-- is_admin(): ...`
      // above an unrelated statement doesn't false-match.
      const s = stripSqlComments(stmt);
      if (/create\s+or\s+replace\s+function\s+public\.is_admin\s*\(/i.test(s)) {
        isAdminCreateCount++;
        if (/\bsecurity\s+definer\b/i.test(s)) isAdminDefinerCount++;
      }
    }
  }
  return { schema, alterOrDropCount, isAdminCreateCount, isAdminDefinerCount };
}

// ── Expected state ───────────────────────────────────────────────────

interface ExpectedTable {
  rlsEnabled: true; // always true — all tables must have RLS enabled
  policies: Array<{
    name: string;
    command: PolicyCommand;
    // Whether the policy has a WITH CHECK clause. Only UPDATE / INSERT
    // / ALL policies can have WITH CHECK. SELECT/DELETE cannot.
    hasWithCheck: boolean;
  }>;
  // Explicitly-zero-policies tables (service-role-only) carry a note.
  deliberateZeroPoliciesReason?: string;
}

// Keep expectations ordered by table name for diffability.
const EXPECTED_RLS: Record<string, ExpectedTable> = {
  'public.profiles': {
    rlsEnabled: true,
    policies: [
      { name: 'profiles: self read', command: 'select', hasWithCheck: false },
      { name: 'profiles: admin read all', command: 'select', hasWithCheck: false },
      // The self-update policy carries WITH CHECK to prevent role
      // escalation. Locking the presence of WITH CHECK is the single
      // most important invariant on this table.
      { name: 'profiles: self update', command: 'update', hasWithCheck: true },
    ],
  },
  'public.service_categories': {
    rlsEnabled: true,
    policies: [
      {
        name: 'service_categories: public read active',
        command: 'select',
        hasWithCheck: false,
      },
    ],
  },
  'public.businesses': {
    rlsEnabled: true,
    policies: [
      {
        name: 'businesses: authenticated read active',
        command: 'select',
        hasWithCheck: false,
      },
    ],
  },
  'public.quote_requests': {
    rlsEnabled: true,
    policies: [
      { name: 'quote_requests: owner read', command: 'select', hasWithCheck: false },
    ],
  },
  'public.calls': {
    rlsEnabled: true,
    policies: [
      { name: 'calls: owner read via request', command: 'select', hasWithCheck: false },
    ],
  },
  'public.quotes': {
    rlsEnabled: true,
    policies: [
      { name: 'quotes: owner read via request', command: 'select', hasWithCheck: false },
    ],
  },
  'public.payments': {
    rlsEnabled: true,
    policies: [
      { name: 'payments: owner read', command: 'select', hasWithCheck: false },
    ],
  },
  'public.quote_contact_releases': {
    rlsEnabled: true,
    policies: [
      {
        name: 'quote_contact_releases: owner read',
        command: 'select',
        hasWithCheck: false,
      },
      {
        name: 'quote_contact_releases: admin read all',
        command: 'select',
        hasWithCheck: false,
      },
    ],
  },
  'public.waitlist_signups': {
    rlsEnabled: true,
    policies: [],
    deliberateZeroPoliciesReason:
      'service-role-only; writes via server action bypass RLS, admin reads via dashboard with service role (0005_multi_vertical.sql).',
  },
  'public.vapi_phone_numbers': {
    rlsEnabled: true,
    policies: [],
    deliberateZeroPoliciesReason:
      'service-role-only; pick_vapi_number() RPC runs SECURITY DEFINER, no user-facing surface (0007_vapi_number_pool.sql).',
  },
  'public.csp_violations': {
    rlsEnabled: true,
    policies: [],
    deliberateZeroPoliciesReason:
      'service-role-only; write path is /api/csp-report admin client (gated by CSP_VIOLATIONS_PERSIST), read path is scripts/analyze-csp-reports.ts (0009_csp_violations.sql).',
  },
};

// Tables that must NEVER carry a client-facing write policy. Writes
// to these tables go through server actions using the service role
// which bypasses RLS. A migration that introduces, say,
// `"payments: self insert"` would re-open the client-write surface.
const CLIENT_WRITE_FORBIDDEN_TABLES: string[] = [
  'public.profiles', // profiles self-update is allowed (role-locked)
  'public.quote_requests',
  'public.calls',
  'public.quotes',
  'public.payments',
  'public.quote_contact_releases',
  'public.waitlist_signups',
  'public.vapi_phone_numbers',
  'public.csp_violations',
];

// Special case: profiles allows `for update` (self update with WITH
// CHECK role lock). Every OTHER CLIENT_WRITE_FORBIDDEN_TABLES must
// have zero write policies.
const CLIENT_WRITE_EXCEPTIONS = new Map<string, Set<PolicyCommand>>([
  ['public.profiles', new Set<PolicyCommand>(['update'])],
]);

// ── Tests ────────────────────────────────────────────────────────────

const built = buildRlsSchema();
const schema = built.schema;

describe('Supabase RLS-policy drift audit (R39)', () => {
  // (1) RLS ENABLED for every table we depend on.
  for (const [table, expected] of Object.entries(EXPECTED_RLS)) {
    it(`${table}: RLS is enabled`, () => {
      const actual = schema.get(table);
      expect(actual, `no RLS state found for ${table}`).toBeDefined();
      expect(actual!.rlsEnabled, `${table} missing 'alter table ... enable row level security'`).toBe(
        expected.rlsEnabled,
      );
    });
  }

  // (2) Policy COUNT per table matches expectation.
  for (const [table, expected] of Object.entries(EXPECTED_RLS)) {
    it(`${table}: has exactly ${expected.policies.length} ${expected.policies.length === 1 ? 'policy' : 'policies'}`, () => {
      const actual = schema.get(table);
      expect(actual, `no RLS state for ${table}`).toBeDefined();
      const actualNames = actual!.policies.map((p) => p.name).sort();
      const expectedNames = expected.policies.map((p) => p.name).sort();
      expect(actualNames, `policy set drift on ${table}`).toEqual(expectedNames);
    });
  }

  // (3) Policy COMMAND matches per-policy expectation.
  for (const [table, expected] of Object.entries(EXPECTED_RLS)) {
    for (const exp of expected.policies) {
      it(`${table}: policy "${exp.name}" command is FOR ${exp.command.toUpperCase()}`, () => {
        const actual = schema.get(table);
        expect(actual).toBeDefined();
        const p = actual!.policies.find((x) => x.name === exp.name);
        expect(p, `policy "${exp.name}" not found on ${table}`).toBeDefined();
        expect(p!.command).toBe(exp.command);
      });
    }
  }

  // (4) WITH CHECK presence matches per-policy expectation (role
  //     escalation guard on profiles: self update).
  for (const [table, expected] of Object.entries(EXPECTED_RLS)) {
    for (const exp of expected.policies) {
      it(`${table}: policy "${exp.name}" WITH CHECK ${exp.hasWithCheck ? 'present' : 'absent'}`, () => {
        const actual = schema.get(table);
        expect(actual).toBeDefined();
        const p = actual!.policies.find((x) => x.name === exp.name);
        expect(p).toBeDefined();
        expect(p!.hasWithCheck).toBe(exp.hasWithCheck);
      });
    }
  }

  // (5) NO UNEXPECTED CLIENT-WRITE POLICIES on PII-bearing tables.
  for (const table of CLIENT_WRITE_FORBIDDEN_TABLES) {
    it(`${table}: no unexpected client-write policy (forbidden writes locked)`, () => {
      const actual = schema.get(table);
      expect(actual, `no RLS state for ${table}`).toBeDefined();
      const allowedWrites = CLIENT_WRITE_EXCEPTIONS.get(table) ?? new Set<PolicyCommand>();
      const writePolicies = actual!.policies.filter(
        (p) =>
          (p.command === 'insert' || p.command === 'update' || p.command === 'delete' || p.command === 'all') &&
          !allowedWrites.has(p.command),
      );
      expect(
        writePolicies.map((p) => `${p.command}: ${p.name}`),
        `${table} has unexpected client-write policies. If this is intentional, update CLIENT_WRITE_EXCEPTIONS.`,
      ).toEqual([]);
    });
  }

  // (6) is_admin() helper exists and is SECURITY DEFINER.
  it('is_admin() helper is created and declared SECURITY DEFINER', () => {
    expect(built.isAdminCreateCount, 'expected exactly one create or replace function public.is_admin(…) declaration').toBe(
      1,
    );
    expect(
      built.isAdminDefinerCount,
      'public.is_admin() must be SECURITY DEFINER — otherwise profiles RLS recurses on the helper',
    ).toBe(1);
  });

  // (7) No migration ever uses ALTER POLICY / DROP POLICY in isolation.
  //     This is a convention lock. If a policy needs to change, the
  //     right pattern is drop + recreate in one transaction and this
  //     audit must be extended to recognize the recreate.
  it('no ALTER POLICY / DROP POLICY statements in migrations (convention lock)', () => {
    // If this starts failing, a legitimate migration has altered or
    // dropped a policy. Extend this audit to look at the FINAL state
    // (drop followed by create), and only then bump the count.
    expect(
      built.alterOrDropCount,
      'alter/drop policy found in migrations. If intentional, extend this audit to track net effect before enabling.',
    ).toBe(0);
  });

  // (8) COVERAGE TRIPWIRE — every table with RLS enabled in any
  //     migration must appear in EXPECTED_RLS. A stray `alter table
  //     ... enable row level security` on a new table would silently
  //     go unaudited otherwise.
  it('coverage: every table with RLS enabled is in EXPECTED_RLS', () => {
    const inMigrations = new Set([...schema.keys()]);
    const inExpected = new Set(Object.keys(EXPECTED_RLS));
    const unaudited = [...inMigrations].filter((t) => !inExpected.has(t));
    expect(
      unaudited,
      `tables with RLS enabled but NOT in EXPECTED_RLS: ${JSON.stringify(unaudited)}. Add them to the audit.`,
    ).toEqual([]);
  });

  // (9) NO GHOST ENTRIES — every EXPECTED_RLS entry corresponds to a
  //     real table in the migrations. A rename drift (renaming a
  //     table without updating the audit) should surface here.
  it('no ghost entries: every EXPECTED_RLS table exists in the migrations', () => {
    const inMigrations = new Set([...schema.keys()]);
    const ghosts = Object.keys(EXPECTED_RLS).filter((t) => !inMigrations.has(t));
    expect(
      ghosts,
      `EXPECTED_RLS names tables that don't exist in the migrations: ${JSON.stringify(ghosts)}`,
    ).toEqual([]);
  });

  // (10) Policy name uniqueness per table (Postgres actually enforces
  //      this, but catching it at CI time means the error message
  //      comes from the audit not from a failed deploy).
  for (const [table] of Object.entries(EXPECTED_RLS)) {
    it(`${table}: policy names are unique`, () => {
      const actual = schema.get(table);
      expect(actual).toBeDefined();
      const names = actual!.policies.map((p) => p.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes).toEqual([]);
    });
  }

  // (11) Smoke test: at least one policy references auth.uid() OR
  //      public.is_admin() — catches a future "oops everything is
  //      `using (true)`" drift. We don't parse USING bodies, but
  //      we can grep the migrations for the tokens to sanity-check
  //      presence.
  it('smoke: RLS predicates reference auth.uid() or public.is_admin() somewhere', () => {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f));
    const combined = files.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
    const hasAuthUid = /\bauth\.uid\s*\(\s*\)/i.test(combined);
    const hasIsAdmin = /\bpublic\.is_admin\s*\(\s*\)/i.test(combined);
    expect(hasAuthUid, 'no auth.uid() reference found across migrations').toBe(true);
    expect(hasIsAdmin, 'no public.is_admin() reference found across migrations').toBe(true);
  });

  // (12) Zero-policy tables are INTENTIONAL and documented.
  for (const [table, exp] of Object.entries(EXPECTED_RLS)) {
    if (exp.policies.length === 0) {
      it(`${table}: zero-policy posture is documented (service-role only)`, () => {
        expect(
          exp.deliberateZeroPoliciesReason,
          `${table} has zero policies — document the reason on EXPECTED_RLS`,
        ).toBeTruthy();
        const actual = schema.get(table);
        expect(actual!.rlsEnabled).toBe(true);
        expect(actual!.policies.length).toBe(0);
      });
    }
  }
});
