// R45(b) — RLS policy LIFECYCLE drift audit.
//
// Sibling to R39(a) `rls-policy-drift.test.ts` and R41(a)
// `rls-policy-predicate-drift.test.ts`.
//
// What the earlier audits cover:
//   • R39 — which tables are RLS-enabled; per-table policy NAMES and
//     COMMANDS; hasWithCheck boolean.
//   • R41 — per-policy USING / WITH CHECK normalized predicate-body
//     strings; forbidden `using (true)` / `1=1` shapes; coverage
//     tripwire that every discovered policy has an EXPECTED entry.
//
// What they deliberately DON'T cover:
//
//   1. `alter policy` statements — would silently rewrite a policy's
//      predicate without updating EXPECTED_PREDICATES. R41's parser
//      only matches `create policy`, so an `alter policy` that widens
//      `using (auth.uid() = id)` to `using (true)` would slip past.
//
//   2. `drop policy` statements — would remove a policy entirely.
//      R41's "no ghost entries" tripwire fires only if the policy
//      was NEVER created; a drop-after-create would leave the map
//      pointing at a non-existent policy, but R41 catches THAT via
//      coverage check only if the EXPECTED entry still exists.
//      Either way, `drop policy` is too dangerous to allow silently.
//
//   3. `disable row level security` — turns RLS off entirely. Every
//      row becomes visible to every authenticated user. Catastrophic.
//
//   4. `force row level security` without explicit documentation —
//      changes owner-bypass behavior. Our posture is "don't force,
//      rely on service-role for privileged access". If we ever DO
//      force, it must be a conscious decision that updates this
//      audit's FORCE_RLS_ALLOWED set.
//
//   5. Orphan-RLS tables — a table with RLS enabled but NO policies
//      is a "deny-all except service role" pattern. We use it
//      deliberately for `waitlist_signups`, `vapi_phone_numbers`,
//      `csp_violations`. If a future migration RLS-enables a new
//      table and forgets to add policies, that table should either
//      be added to NO_POLICIES_SERVICE_ROLE_ONLY or have policies
//      defined. This audit forces that decision.
//
// This audit is the LIFECYCLE ceiling around R41's predicate FLOOR.
// Together: R39 locks names+commands, R41 locks predicate bodies,
// R45(b) locks that only `create policy` (not alter/drop) and only
// `enable row level security` (not disable/force) ever appear.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// Expected RLS-enabled tables, split by policy-bearing class.
//
// WITH_POLICIES: tables where RLS is enabled AND at least one
// `create policy` exists. Must equal R41's per-table policy-bearer
// set.
//
// NO_POLICIES_SERVICE_ROLE_ONLY: tables where RLS is enabled AND
// NO `create policy` exists. These are "deny-all to client roles;
// service role bypasses RLS as designed". Writes/reads happen via
// admin client only.
const WITH_POLICIES = new Set<string>([
  'public.profiles',
  'public.service_categories',
  'public.businesses',
  'public.quote_requests',
  'public.calls',
  'public.quotes',
  'public.payments',
  'public.quote_contact_releases',
]);

const NO_POLICIES_SERVICE_ROLE_ONLY = new Set<string>([
  'public.waitlist_signups',
  'public.vapi_phone_numbers',
  'public.csp_violations',
  // 2026-05-04 — coupons table; redemption via redeem_coupon() SECURITY
  // DEFINER RPC, mint via admin client in scripts/mint-coupons.ts.
  'public.coupons',
]);

// Any table permitted to use `force row level security`. Empty today
// — we rely on no-one-impersonates-the-owner + service-role-for-admin.
// Adding a table here requires a conscious decision.
const FORCE_RLS_ALLOWED = new Set<string>([]);

// ── SQL statement splitter (shared pattern from R41) ─────────────────

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

function stripSqlComments(stmt: string): string {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*\n/g, ' ')
    .replace(/--[^\n]*$/g, ' ');
}

// ── Discovery ────────────────────────────────────────────────────────

interface RlsFacts {
  // Tables with `alter table X enable row level security` seen.
  rlsEnabled: Set<string>;
  // Tables with `alter table X force row level security` seen.
  rlsForced: Set<string>;
  // Tables with `alter table X disable row level security` seen.
  rlsDisabled: Set<string>;
  // Tables with at least one `create policy`.
  tablesWithCreatePolicy: Set<string>;
  // Total `create policy` count across migrations.
  createPolicyCount: number;
  // Total `alter policy` count — must be 0.
  alterPolicyCount: number;
  // Total `drop policy` count — must be 0.
  dropPolicyCount: number;
  // Locations per forbidden-token class, for diagnostic messages.
  alterPolicyLocations: string[];
  dropPolicyLocations: string[];
  disableRlsLocations: string[];
  forceRlsLocations: string[];
}

function discover(): RlsFacts {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const facts: RlsFacts = {
    rlsEnabled: new Set(),
    rlsForced: new Set(),
    rlsDisabled: new Set(),
    tablesWithCreatePolicy: new Set(),
    createPolicyCount: 0,
    alterPolicyCount: 0,
    dropPolicyCount: 0,
    alterPolicyLocations: [],
    dropPolicyLocations: [],
    disableRlsLocations: [],
    forceRlsLocations: [],
  };

  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const stmts = splitSqlStatements(sql);
    for (const stmt of stmts) {
      const s = stripSqlComments(stmt).trim();
      if (s.length === 0) continue;

      // alter table X enable|disable|force row level security
      const alterRls =
        /^alter\s+table\s+(?:public\.)?([A-Za-z_][\w]*)\s+(enable|disable|force)\s+row\s+level\s+security\b/i.exec(
          s,
        );
      if (alterRls) {
        const table = `public.${alterRls[1]}`;
        const verb = alterRls[2].toLowerCase();
        if (verb === 'enable') facts.rlsEnabled.add(table);
        else if (verb === 'disable') {
          facts.rlsDisabled.add(table);
          facts.disableRlsLocations.push(`${f}: ${table}`);
        } else if (verb === 'force') {
          facts.rlsForced.add(table);
          facts.forceRlsLocations.push(`${f}: ${table}`);
        }
        continue;
      }

      // create policy
      const cp =
        /^create\s+policy\s+(?:"([^"]+)"|[A-Za-z_][\w]*)\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(
          s,
        );
      if (cp) {
        facts.createPolicyCount++;
        facts.tablesWithCreatePolicy.add(`public.${cp[2]}`);
        continue;
      }

      // alter policy
      if (/^alter\s+policy\b/i.test(s)) {
        facts.alterPolicyCount++;
        facts.alterPolicyLocations.push(`${f}: ${s.slice(0, 80).replace(/\s+/g, ' ')}…`);
        continue;
      }

      // drop policy — NAKED only. `drop policy if exists` is allowed
      // because it's the canonical idempotency guard for `create
      // policy` (Postgres < 15 has no `create policy if not exists`).
      // Drop-if-exists still leaves R41's predicate-body lock as the
      // backstop against silent mutation: if a policy is dropped and
      // not recreated, R41's coverage check fires. If it is recreated
      // with a changed predicate, R41's predicate assertion fires.
      if (/^drop\s+policy\b/i.test(s) && !/^drop\s+policy\s+if\s+exists\b/i.test(s)) {
        facts.dropPolicyCount++;
        facts.dropPolicyLocations.push(`${f}: ${s.slice(0, 80).replace(/\s+/g, ' ')}…`);
        continue;
      }
    }
  }
  return facts;
}

const facts = discover();

// ── Tests ────────────────────────────────────────────────────────────

describe('Supabase RLS policy LIFECYCLE drift audit (R45(b))', () => {
  // (1) Every RLS-enabled table discovered in migrations is classified
  //     in exactly one of WITH_POLICIES or NO_POLICIES_SERVICE_ROLE_ONLY.
  it('every RLS-enabled table is classified (WITH_POLICIES or NO_POLICIES_SERVICE_ROLE_ONLY)', () => {
    const classified = new Set<string>([...WITH_POLICIES, ...NO_POLICIES_SERVICE_ROLE_ONLY]);
    const unclassified = [...facts.rlsEnabled].filter((t) => !classified.has(t));
    expect(
      unclassified,
      `RLS-enabled tables missing from classification: ${JSON.stringify(unclassified)}`,
    ).toEqual([]);
  });

  // (2) No ghost expected-tables — every classified table is actually
  //     RLS-enabled in migrations.
  it('no ghost entries: every classified table exists as RLS-enabled', () => {
    const classified = [...WITH_POLICIES, ...NO_POLICIES_SERVICE_ROLE_ONLY];
    const ghosts = classified.filter((t) => !facts.rlsEnabled.has(t));
    expect(ghosts, `classified but not RLS-enabled: ${JSON.stringify(ghosts)}`).toEqual([]);
  });

  // (3) Tables classified WITH_POLICIES must have ≥1 `create policy`.
  for (const table of WITH_POLICIES) {
    it(`${table} has at least one create policy`, () => {
      expect(
        facts.tablesWithCreatePolicy.has(table),
        `${table} is classified WITH_POLICIES but has no create policy statements`,
      ).toBe(true);
    });
  }

  // (4) Tables classified NO_POLICIES_SERVICE_ROLE_ONLY must have 0
  //     `create policy`. If a policy is ever added, the table must be
  //     reclassified.
  for (const table of NO_POLICIES_SERVICE_ROLE_ONLY) {
    it(`${table} has zero create policy (service-role only)`, () => {
      expect(
        facts.tablesWithCreatePolicy.has(table),
        `${table} is classified NO_POLICIES but a create policy was found — reclassify to WITH_POLICIES`,
      ).toBe(false);
    });
  }

  // (5) No `alter policy` in any migration — alters would silently
  //     rewrite predicates without updating EXPECTED_PREDICATES in
  //     R41's audit.
  it('no `alter policy` statements in any migration', () => {
    expect(
      facts.alterPolicyCount,
      `alter policy statements found — R41 predicate lock bypassed: ${JSON.stringify(facts.alterPolicyLocations)}`,
    ).toBe(0);
  });

  // (6) No NAKED `drop policy` in any migration — drops without
  //     `if exists` would silently remove enforcement on re-apply or
  //     panic the migration if the policy is missing.
  //     `drop policy if exists` IS allowed (idempotency guard for
  //     drop-then-recreate). R41's predicate-body audit is the
  //     backstop if a drop-then-recreate changes the predicate.
  it('no naked `drop policy` statements (drop policy if exists is allowed)', () => {
    expect(
      facts.dropPolicyCount,
      `naked drop policy statements found: ${JSON.stringify(facts.dropPolicyLocations)}`,
    ).toBe(0);
  });

  // (7) No `disable row level security` — catastrophic regression.
  it('no `disable row level security` statements in any migration', () => {
    expect(
      facts.rlsDisabled.size,
      `disable RLS statements found: ${JSON.stringify(facts.disableRlsLocations)}`,
    ).toBe(0);
  });

  // (8) `force row level security` only on tables in FORCE_RLS_ALLOWED.
  //     Currently empty — any `force` trips this.
  it('no unexpected `force row level security` statements', () => {
    const unexpected = [...facts.rlsForced].filter((t) => !FORCE_RLS_ALLOWED.has(t));
    expect(
      unexpected,
      `force RLS on tables not in FORCE_RLS_ALLOWED: ${JSON.stringify(unexpected)}`,
    ).toEqual([]);
  });

  // (9) Exact RLS-enabled table count — tripwire for new RLS-enabled
  //     tables that aren't yet classified.
  it(`discovered ${WITH_POLICIES.size + NO_POLICIES_SERVICE_ROLE_ONLY.size} RLS-enabled tables (exact count)`, () => {
    expect(facts.rlsEnabled.size).toBe(
      WITH_POLICIES.size + NO_POLICIES_SERVICE_ROLE_ONLY.size,
    );
  });

  // (10) Exact policy-bearing table count — cross-check with R41.
  it(`${WITH_POLICIES.size} tables have create policy statements (matches WITH_POLICIES.size)`, () => {
    expect(facts.tablesWithCreatePolicy.size).toBe(WITH_POLICIES.size);
  });

  // (11) Create-policy count matches R41's EXPECTED_PREDICATES count
  //      (11). Catches accidental drop-then-recreate that leaves a
  //      net-new policy name behind.
  it('create policy total count equals 11 (matches R41 EXPECTED_PREDICATES)', () => {
    expect(facts.createPolicyCount).toBe(11);
  });

  // (12) Classification sets are disjoint.
  it('WITH_POLICIES and NO_POLICIES_SERVICE_ROLE_ONLY are disjoint', () => {
    const overlap = [...WITH_POLICIES].filter((t) => NO_POLICIES_SERVICE_ROLE_ONLY.has(t));
    expect(overlap, `tables in both classification sets: ${JSON.stringify(overlap)}`).toEqual(
      [],
    );
  });

  // (13) Every NO_POLICIES table name includes a recognizable
  //      "service-role only" convention comment in the migration
  //      where RLS is enabled. This is a soft check — documentation
  //      discipline so reviewers don't have to guess WHY a table has
  //      no policies.
  it('NO_POLICIES tables are documented with a service-role justification comment', () => {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    const undocumented: string[] = [];
    for (const table of NO_POLICIES_SERVICE_ROLE_ONLY) {
      const tableName = table.replace(/^public\./, '');
      let found = false;
      for (const f of files) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        // Does this file enable RLS on the table?
        if (
          !new RegExp(
            `alter\\s+table\\s+(?:public\\.)?${tableName}\\s+enable\\s+row\\s+level\\s+security`,
            'i',
          ).test(sql)
        ) {
          continue;
        }
        // Search the file for a "service role" or "no user-facing" style justification.
        const justification =
          /service[-\s]role|service\s+role\s+bypass|no\s+user[-\s]facing|no\s+policies\s*=\s*no\s+(access|rows)/i;
        if (justification.test(sql)) found = true;
        break;
      }
      if (!found) undocumented.push(table);
    }
    expect(
      undocumented,
      `NO_POLICIES tables without service-role justification comment: ${JSON.stringify(undocumented)}`,
    ).toEqual([]);
  });
});
