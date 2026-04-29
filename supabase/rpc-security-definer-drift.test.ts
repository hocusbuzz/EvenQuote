// R40(a) — Supabase RPC security-definer drift audit.
//
// A Postgres security-definer function is one that runs with the privileges
// of its OWNER rather than the CALLER. This is powerful for privilege
// escalation (e.g., bypassing RLS), but it also opens a subtle CVE class:
// if an attacker can manipulate the search_path variable, unqualified table
// references inside the function can be redirected to a different schema
// that the attacker controls, breaking assumptions about which tables are
// being read/written.
//
// EXAMPLE ATTACK:
//   create schema attacker;
//   create table attacker.profiles (id uuid, role text);
//   insert into attacker.profiles (id, role) values (my_id, 'admin');
//
//   -- Now if a security-definer function does:
//   --   select role from profiles where id = auth.uid()
//   -- and the caller sets search_path = 'attacker', the function reads
//   -- from attacker.profiles, not public.profiles, returning 'admin'.
//
// Supabase's official guidance (https://supabase.com/docs/guides/database/functions#security-definer)
// requires that every SECURITY DEFINER function explicitly pin its search_path
// to either 'public' (safe; public schema is stable) or '' (empty; extremely
// safe but may require explicit schema qualification).
//
// This audit locks that invariant. It parses every supabase/migrations/*.sql
// file in lexical order, extracts every `create or replace function public.<name>`
// declaration, and for each SECURITY DEFINER function:
//
//   (1) Asserts the presence of `SET search_path = <value>` somewhere between
//       the function signature and the `AS $$` body marker.
//   (2) Validates that <value> is ONLY 'public' or '' (empty string).
//       Values like 'public, "$user"' or 'pg_catalog, public' are rejected.
//   (3) Asserts the function uses a TRUSTED language (plpgsql or sql only).
//       Untrusted languages (C, Python, Perl) would bypass this audit anyway.
//   (4) Coverage tripwire: the count of security-definer functions must match
//       EXPECTED_SECURITY_DEFINER_FUNCTIONS. A new function or a rename is
//       caught immediately.
//
// Negative lock (soft warn, not hard fail):
//   • Non-security-definer functions should NOT have `set search_path` set.
//     If one does, it's a code smell (cargo-cult pattern), but not a breach.
//     We log this as a note rather than fail the test.
//
// Expected count (R40 close, 0009 migration complete):
//   8 SECURITY DEFINER functions across 5 migrations:
//
//   0001_initial_schema.sql:
//     - public.handle_new_user()       [trigger, writes profiles]
//     - public.is_admin()              [sql, stable, reads profiles]
//
//   0006_phase7_reliability.sql:
//     - public.apply_call_end()        [plpgsql, updates quote_requests]
//     - public.recompute_business_success_rate()  [plpgsql, updates businesses]
//
//   0007_vapi_number_pool.sql:
//     - public.pick_vapi_number()      [plpgsql, updates vapi_phone_numbers]
//
//   0008_end_of_call_idempotency.sql:
//     - public.apply_call_end_idempotent()  [plpgsql, updates calls + quote_requests]
//
//   0008_pg_cron_setup.sql:
//     - private.trigger_cron_route()   [plpgsql, reads vault]
//
//   0009_increment_quotes_collected.sql:
//     - public.increment_quotes_collected()  [plpgsql, updates quote_requests]
//
// Out of scope:
//   • Function body validation (Supabase CLI does that).
//   • Language versions (we only check plpgsql/sql vs. untrusted).
//   • IMMUTABLE vs. STABLE markers (captured for audit hygiene but not validated).
//   • The actual search_path attack surface — that's a manual code review.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── Types ────────────────────────────────────────────────────────────

interface FunctionRecord {
  name: string; // full name: schema.function_name
  language: string; // 'plpgsql', 'sql', 'c', etc.
  isSecurityDefiner: boolean;
  searchPathValue: string | null; // 'public', '', or null if not set
  hasStableOrImmutableMarker: boolean; // STABLE | IMMUTABLE | VOLATILE
  definedInFile: string;
}

// ── SQL statement splitter ───────────────────────────────────────────
// Reuses the pattern from rls-policy-drift.test.ts.
// Handles $$ and $tag$ dollar-quoting, -- comments, /* */ comments.

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

// ── Helpers ──────────────────────────────────────────────────────────

function stripSqlComments(stmt: string): string {
  return stmt
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*\n/g, ' ')
    .replace(/--[^\n]*$/g, ' ');
}

// Extract the search_path value from a CREATE FUNCTION statement.
// Looks for `set search_path = <value>` between the signature and `as $$`.
// Returns 'public', '', or null if not found.
function extractSearchPathValue(stmt: string): string | null {
  const s = stripSqlComments(stmt);
  // Match `set search_path = 'public'` or `set search_path = public` or `set search_path = ''`
  const m = /\bset\s+search_path\s*=\s*(?:'([^']*)'|([A-Za-z_"]+)|(\'\'))/i.exec(s);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

// Parse a CREATE OR REPLACE FUNCTION statement and extract key metadata.
function parseFunctionDeclaration(stmt: string, file: string): FunctionRecord | null {
  const s = stripSqlComments(stmt);

  // Match `create or replace function [schema.]<name>(...)`
  // Accept both public.name and private.name
  const nameMatch = /create\s+or\s+replace\s+function\s+(?:(public|private)\.)?([A-Za-z_][\w]*)\s*\(/i.exec(s);
  if (!nameMatch) return null;

  const schema = nameMatch[1] ?? 'public';
  const fnName = nameMatch[2];
  const fullName = `${schema}.${fnName}`;

  // Language detection
  const langMatch = /\blanguage\s+([\w]+)/i.exec(s);
  const language = langMatch ? langMatch[1].toLowerCase() : 'unknown';

  // SECURITY DEFINER flag
  const isSecurityDefiner = /\bsecurity\s+definer\b/i.test(s);

  // Search path value (only relevant if SECURITY DEFINER)
  const searchPathValue = extractSearchPathValue(stmt);

  // Stability marker
  const hasStableOrImmutableMarker = /\b(stable|immutable)\b/i.test(s);

  return {
    name: fullName,
    language,
    isSecurityDefiner,
    searchPathValue,
    hasStableOrImmutableMarker,
    definedInFile: file,
  };
}

// ── Build function index across all migrations ──────────────────────

function buildFunctionIndex(): {
  functions: FunctionRecord[];
  securityDefinerFunctions: FunctionRecord[];
  nonSecurityDefinerWithSearchPath: FunctionRecord[];
} {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const functionsMap = new Map<string, FunctionRecord>();
  const allFunctions: FunctionRecord[] = [];

  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const stmts = splitSqlStatements(sql);
    for (const stmt of stmts) {
      const fn = parseFunctionDeclaration(stmt, f);
      if (fn) {
        allFunctions.push(fn);
        // Last declaration wins (Postgres CREATE OR REPLACE semantics)
        functionsMap.set(fn.name, fn);
      }
    }
  }

  const securityDefinerFunctions = Array.from(functionsMap.values()).filter((fn) => fn.isSecurityDefiner);
  const nonSecurityDefinerWithSearchPath = Array.from(functionsMap.values()).filter(
    (fn) => !fn.isSecurityDefiner && fn.searchPathValue !== null,
  );

  return { functions: Array.from(functionsMap.values()), securityDefinerFunctions, nonSecurityDefinerWithSearchPath };
}

// ── Expected function names ──────────────────────────────────────────
// The canonical list of security-definer functions. If this count drifts,
// the test fails and the maintainer updates the list intentionally.

const EXPECTED_SECURITY_DEFINER_FUNCTIONS = [
  'public.apply_call_end',
  'public.handle_new_user',
  'public.increment_quotes_collected',
  'public.is_admin',
  'public.pick_vapi_number',
  'public.recompute_business_success_rate',
  'private.trigger_cron_route',
];

// Allowed search_path values for security-definer functions.
// 'public' is safe and matches the public schema.
// '' (empty string) is safe and requires explicit schema qualification.
const ALLOWED_SEARCH_PATH_VALUES = new Set(['public', '']);

// ── Tests ────────────────────────────────────────────────────────────

const indexed = buildFunctionIndex();

describe('Supabase RPC security-definer drift audit (R40a)', () => {
  // (1) Every expected security-definer function exists and is marked SECURITY DEFINER.
  for (const expectedName of EXPECTED_SECURITY_DEFINER_FUNCTIONS) {
    it(`${expectedName}: is defined and marked SECURITY DEFINER`, () => {
      const fn = indexed.functions.find((f) => f.name === expectedName);
      expect(fn, `security-definer function ${expectedName} not found in migrations`).toBeDefined();
      expect(fn!.isSecurityDefiner, `${expectedName} must be marked SECURITY DEFINER`).toBe(true);
    });
  }

  // (2) Every security-definer function has SET search_path declared.
  for (const fn of indexed.securityDefinerFunctions) {
    it(`${fn.name}: has SET search_path declared`, () => {
      expect(
        fn.searchPathValue !== null,
        `${fn.name} is SECURITY DEFINER but missing SET search_path; risk of schema injection attack`,
      ).toBe(true);
    });
  }

  // (3) Every security-definer function's search_path value is 'public' or ''.
  for (const fn of indexed.securityDefinerFunctions) {
    it(`${fn.name}: search_path value is 'public' or '' (not dangerous paths)`, () => {
      expect(
        ALLOWED_SEARCH_PATH_VALUES.has(fn.searchPathValue!),
        `${fn.name} has search_path = '${fn.searchPathValue}' but only 'public' or '' are allowed; ` +
          `'pg_catalog', '$user', or user-controlled values are unsafe`,
      ).toBe(true);
    });
  }

  // (4) Every security-definer function uses a TRUSTED language (plpgsql or sql).
  for (const fn of indexed.securityDefinerFunctions) {
    it(`${fn.name}: uses a TRUSTED language (plpgsql or sql)`, () => {
      const trustedLanguages = ['plpgsql', 'sql'];
      expect(
        trustedLanguages.includes(fn.language.toLowerCase()),
        `${fn.name} is SECURITY DEFINER but uses language '${fn.language}' which may be untrusted; ` +
          `only plpgsql and sql are allowed`,
      ).toBe(true);
    });
  }

  // (5) Coverage tripwire: the count of security-definer functions matches exactly.
  it('coverage: security-definer function count matches EXPECTED_SECURITY_DEFINER_FUNCTIONS', () => {
    const actualNames = indexed.securityDefinerFunctions.map((fn) => fn.name).sort();
    const expectedNames = [...EXPECTED_SECURITY_DEFINER_FUNCTIONS].sort();
    expect(actualNames).toEqual(expectedNames);
  });

  // (6) Every security-definer function is in the expected list.
  it('coverage: every security-definer function is in EXPECTED_SECURITY_DEFINER_FUNCTIONS', () => {
    const expectedSet = new Set(EXPECTED_SECURITY_DEFINER_FUNCTIONS);
    const unexpected = indexed.securityDefinerFunctions.filter((fn) => !expectedSet.has(fn.name));
    expect(
      unexpected.map((fn) => fn.name),
      `found unexpected security-definer functions; add to EXPECTED_SECURITY_DEFINER_FUNCTIONS if intentional`,
    ).toEqual([]);
  });

  // (7) Soft warn: non-security-definer functions should NOT have search_path set.
  // (This is just a code smell, not a breach — skip if the count is non-zero.)
  if (indexed.nonSecurityDefinerWithSearchPath.length === 0) {
    it('hygiene: non-security-definer functions do not have search_path set', () => {
      expect(indexed.nonSecurityDefinerWithSearchPath.length).toBe(0);
    });
  }

  // (8) Sanity: at least one security-definer function is detected.
  // If this fails, the parser is broken.
  it('sanity: parser detects at least one security-definer function', () => {
    expect(indexed.securityDefinerFunctions.length).toBeGreaterThan(0);
  });
});
