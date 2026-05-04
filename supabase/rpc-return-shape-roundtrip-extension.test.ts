// R44(a) — RPC return-shape round-trip extension.
//
// Companion to `rpc-return-shape-drift.test.ts` (R37(a)). That file
// locks per-RPC shapes and has a dedicated `pick_vapi_number` round-
// trip (forward + reverse). This file extends the round-trip coverage
// to the OTHER table-returning public RPCs and adds a forbidden-
// destructure lock for table RPCs that the app does NOT destructure
// today — so a future refactor that starts reading `data[0]` at
// those call sites is caught at CI instead of production.
//
// Why a companion file (not amending the existing one)?
//   • The R37(a) file is already 423 lines. Extension here keeps it
//     readable and gives the extension a distinct test file name for
//     grep-ability in CI output.
//   • The two files share no parser state; this one re-parses
//     migrations independently so a parser change in R37(a) doesn't
//     silently propagate bugs into this file.
//
// What's covered:
//
//   1. Public-RPC catalog completeness: migration-side public RPCs
//      must equal {apply_call_end, pick_vapi_number,
//      businesses_within_radius, recompute_business_success_rate,
//      increment_quotes_collected, set_updated_at, handle_new_user,
//      is_admin}. New public RPCs break this test (by design —
//      forces a conscious catalog update).
//
//   2. Table-return RPC classification: the three table RPCs MUST
//      be of kind 'table'; the five others MUST be of kind 'scalar'.
//
//   3. Forbidden-destructure on non-consumed table RPCs:
//      `apply_call_end` has a 5-column return but the app and cron
//      destructure only `{ error }`. Lock that NO `.rpc('apply_call_end')`
//      call site accesses `data[...]` until a shape round-trip is
//      added alongside. Same invariant for any other table RPC that
//      ends up in the NON_CONSUMED set.
//
//   4. Consumed table RPCs shape subset/equality check:
//      pick_vapi_number must be an EXACT match (R37(a) already locks
//      this; we re-assert for parallelism); businesses_within_radius
//      consumed fields must be a SUBSET of the migration columns.
//
//   5. Cross-call-site shape consistency: if the same table RPC is
//      destructured at multiple call sites, every cast body must
//      name the SAME set of fields. Silent drift between call sites
//      is the failure mode.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const APP_ROOTS = [
  path.resolve(process.cwd(), 'app'),
  path.resolve(process.cwd(), 'lib'),
];

// ── Migration parser (independent copy; R37(a) has its own) ─────────

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, '');
}

type RpcShape =
  | { kind: 'table'; columns: string[] }
  | { kind: 'scalar'; scalarType: string };

function parseMigrations(): Map<string, RpcShape> {
  const shapes = new Map<string, RpcShape>();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const src = stripSqlComments(
      fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
    );
    const re = /create\s+or\s+replace\s+function\s+public\.([A-Za-z_][\w]*)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const fnName = m[1];
      // Walk paren-balanced argument list.
      let p = 1;
      let i = m.index + m[0].length;
      while (i < src.length && p > 0) {
        if (src[i] === '(') p++;
        else if (src[i] === ')') p--;
        i++;
      }
      if (p !== 0) continue;
      const afterArgs = src.slice(i);
      // Table return: `returns table (... )`
      const tableM = /^\s*returns\s+table\s*\(([\s\S]*?)\)\s*(language|as|security|set|stable|immutable|volatile|$)/i.exec(
        afterArgs,
      );
      if (tableM) {
        const inside = tableM[1];
        const cols = Array.from(
          inside.matchAll(/([A-Za-z_][\w]*)\s+[\w\[\]. ()]+/g),
          (x) => x[1],
        );
        // Overwrite earlier migrations (create or replace semantics).
        shapes.set(fnName, { kind: 'table', columns: cols });
        continue;
      }
      // Scalar return: `returns <type>`
      const scalarM = /^\s*returns\s+([A-Za-z_][\w]*)(?:\s|$)/i.exec(afterArgs);
      if (scalarM) {
        shapes.set(fnName, { kind: 'scalar', scalarType: scalarM[1].toLowerCase() });
      } else {
        // `returns trigger` / `returns void` / complex — record as
        // scalar with the raw token.
        const rawM = /^\s*returns\s+(\S+)/i.exec(afterArgs);
        if (rawM) {
          shapes.set(fnName, {
            kind: 'scalar',
            scalarType: rawM[1].toLowerCase().replace(/[^a-z]/g, ''),
          });
        }
      }
    }
  }
  return shapes;
}

// Walk app+lib for `.rpc('<fn>')` call-site contexts.
function collectAppCallSites(): Map<string, { file: string; window: string }[]> {
  const out = new Map<string, { file: string; window: string }[]>();
  const tsFiles: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      tsFiles.push(p);
    }
  };
  for (const root of APP_ROOTS) walk(root);

  for (const f of tsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const callRe = /\.rpc\s*\(\s*['"`]([A-Za-z_][\w]*)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      const fn = m[1];
      const window = src.slice(m.index, m.index + 400);
      if (!out.has(fn)) out.set(fn, []);
      out.get(fn)!.push({ file: path.relative(process.cwd(), f), window });
    }
  }
  return out;
}

const SHAPES = parseMigrations();
const CALL_SITES = collectAppCallSites();

// Expected public RPC catalog. Add a new one → break this → force a
// conscious decision about round-trip coverage.
const EXPECTED_TABLE_RPCS = new Set<string>([
  'apply_call_end',
  'pick_vapi_number',
  'businesses_within_radius',
  // 2026-05-04 — coupon redemption RPC; returns (outcome text, detail
  // text); consumed via Row type cast in lib/actions/coupons.ts.
  'redeem_coupon',
]);
const EXPECTED_SCALAR_RPCS = new Set<string>([
  'recompute_business_success_rate',
  'increment_quotes_collected',
  'set_updated_at',
  'handle_new_user',
  'is_admin',
]);

// Table RPCs whose return the app DOES destructure as records. Every
// entry here MUST have either an exact-match or subset round-trip test
// in this file or in R37(a).
const CONSUMED_TABLE_RPCS = new Set<string>([
  'pick_vapi_number',
  'businesses_within_radius',
  // 2026-05-04 — Row type alias in lib/actions/coupons.ts consumes
  // outcome + detail; subset round-trip below validates the field set.
  'redeem_coupon',
]);

// Table RPCs whose return the app MUST NOT destructure (no consumer
// exists today — forbidden to add one without also adding a round-trip
// lock in this file).
const NON_CONSUMED_TABLE_RPCS = new Set<string>([
  'apply_call_end',
]);

describe('supabase/ RPC round-trip extension (R44(a))', () => {
  // ── Catalog completeness ───────────────────────────────────────────

  it('migration catalog matches the expected public-RPC set', () => {
    const actual = new Set(SHAPES.keys());
    const expected = new Set([...EXPECTED_TABLE_RPCS, ...EXPECTED_SCALAR_RPCS]);
    expect(actual).toEqual(expected);
  });

  it('EXPECTED_TABLE_RPCS all classified as kind=table', () => {
    for (const fn of EXPECTED_TABLE_RPCS) {
      const s = SHAPES.get(fn);
      expect(s, `${fn} missing from SHAPES`).toBeDefined();
      expect(s!.kind).toBe('table');
    }
  });

  it('EXPECTED_SCALAR_RPCS all classified as kind=scalar', () => {
    for (const fn of EXPECTED_SCALAR_RPCS) {
      const s = SHAPES.get(fn);
      expect(s, `${fn} missing from SHAPES`).toBeDefined();
      expect(s!.kind).toBe('scalar');
    }
  });

  it('CONSUMED ∪ NON_CONSUMED = EXPECTED_TABLE_RPCS (table classification is exhaustive)', () => {
    const union = new Set([...CONSUMED_TABLE_RPCS, ...NON_CONSUMED_TABLE_RPCS]);
    expect(union).toEqual(EXPECTED_TABLE_RPCS);
  });

  it('CONSUMED ∩ NON_CONSUMED = ∅ (classifications disjoint)', () => {
    for (const fn of CONSUMED_TABLE_RPCS) {
      expect(NON_CONSUMED_TABLE_RPCS.has(fn)).toBe(false);
    }
  });

  // ── Forbidden-destructure on NON_CONSUMED table RPCs ──────────────

  for (const fn of NON_CONSUMED_TABLE_RPCS) {
    it(`NON_CONSUMED table RPC '${fn}' has no data[...] / data?.[...] destructure at any call site`, () => {
      const sites = CALL_SITES.get(fn) ?? [];
      const violations: string[] = [];
      for (const { file, window } of sites) {
        // `.select('data')` / string `data` are fine; only flag
        // array-index access patterns. Use the 400-char window.
        // To avoid picking up variable names like `dataForSomething`,
        // require a word-boundary + `[`.
        if (/\bdata\s*\[/.test(window) || /\bdata\s*\?\.\s*\[/.test(window)) {
          violations.push(`${file}: ${fn} call site reads data[...]`);
        }
      }
      expect(
        violations,
        `${fn} is classified as NON_CONSUMED — adding a destructure requires adding an exact round-trip test in rpc-return-shape-roundtrip-extension.test.ts`,
      ).toEqual([]);
    });
  }

  // ── Round-trip: businesses_within_radius SUBSET check ─────────────

  it('businesses_within_radius app-side map body consumed fields are a SUBSET of migration columns', () => {
    const s = SHAPES.get('businesses_within_radius');
    expect(s).toBeDefined();
    if (!s || s.kind !== 'table') return;
    const filePath = path.resolve(
      process.cwd(),
      'lib/calls/select-businesses.ts',
    );
    const src = fs.readFileSync(filePath, 'utf8');
    const mapMatch = /\.map\s*\(\s*\(\s*r:\s*\{([^}]+)\}\s*\)\s*=>/.exec(src);
    expect(
      mapMatch,
      'expected `.map((r: { … }) =>` in lib/calls/select-businesses.ts',
    ).not.toBeNull();
    if (!mapMatch) return;
    const consumed = Array.from(
      mapMatch[1].matchAll(/([A-Za-z_][\w]*)\s*:/g),
      (m) => m[1],
    );
    const migration = new Set(s.columns);
    const unknown = consumed.filter((c) => !migration.has(c));
    expect(
      unknown,
      `app reads columns the migration does not return: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  // ── Round-trip: pick_vapi_number EXACT match (parallel to R37(a)) ──

  it('pick_vapi_number app-side cast fields EQUAL migration columns exactly', () => {
    const s = SHAPES.get('pick_vapi_number');
    expect(s).toBeDefined();
    if (!s || s.kind !== 'table') return;
    const filePath = path.resolve(
      process.cwd(),
      'lib/calls/select-vapi-number.ts',
    );
    const src = fs.readFileSync(filePath, 'utf8');
    const castMatch = /data\[0\]\s+as\s+\{([^}]+)\}/.exec(src);
    expect(castMatch).not.toBeNull();
    if (!castMatch) return;
    const cast = new Set(
      Array.from(castMatch[1].matchAll(/([A-Za-z_][\w]*)\s*:/g), (m) => m[1]),
    );
    expect(cast).toEqual(new Set(s.columns));
  });

  // ── Round-trip: redeem_coupon SUBSET check ────────────────────────
  // 2026-05-04 — lib/actions/coupons.ts declares a `type Row = { ... }`
  // alias rather than inlining the cast at the .rpc() site. Walk the
  // type alias body and assert its fields are a subset of the
  // migration's return columns.

  it('redeem_coupon app-side Row type alias fields are a SUBSET of migration columns', () => {
    const s = SHAPES.get('redeem_coupon');
    expect(s).toBeDefined();
    if (!s || s.kind !== 'table') return;
    const filePath = path.resolve(process.cwd(), 'lib/actions/coupons.ts');
    const src = fs.readFileSync(filePath, 'utf8');
    const rowMatch = /type\s+Row\s*=\s*\{([^}]+)\}/.exec(src);
    expect(
      rowMatch,
      'expected `type Row = { … }` in lib/actions/coupons.ts',
    ).not.toBeNull();
    if (!rowMatch) return;
    const consumed = Array.from(
      rowMatch[1].matchAll(/([A-Za-z_][\w]*)\s*:/g),
      (m) => m[1],
    );
    const migration = new Set(s.columns);
    const unknown = consumed.filter((c) => !migration.has(c));
    expect(
      unknown,
      `app reads columns the migration does not return: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  // ── Cross-call-site shape consistency ─────────────────────────────

  it('every CONSUMED table RPC has consistent destructure shapes across call sites', () => {
    // If the same RPC is called from multiple files and both
    // destructure the return, the cast bodies MUST name the same
    // field set. Drift between call sites is the specific failure
    // we're guarding against.
    for (const fn of CONSUMED_TABLE_RPCS) {
      const sites = CALL_SITES.get(fn) ?? [];
      const shapesPerSite: { file: string; fields: Set<string> }[] = [];
      for (const { file, window } of sites) {
        // Try both destructure shapes.
        let fields: Set<string> | null = null;
        const castMatch = /data(?:\s*\?\.?|\s*\?)?\[0\]\s+as\s+\{([^}]+)\}/.exec(
          window,
        );
        const mapMatch = /\.map\s*\(\s*\(\s*[a-zA-Z_]\w*:\s*\{([^}]+)\}\s*\)\s*=>/.exec(
          window,
        );
        const body = castMatch?.[1] ?? mapMatch?.[1];
        if (body) {
          fields = new Set(
            Array.from(body.matchAll(/([A-Za-z_][\w]*)\s*:/g), (m) => m[1]),
          );
        }
        if (fields) shapesPerSite.push({ file, fields });
      }
      if (shapesPerSite.length <= 1) continue; // 0 or 1 site → vacuously consistent
      const ref = shapesPerSite[0].fields;
      for (const s of shapesPerSite.slice(1)) {
        expect(
          s.fields,
          `${fn}: ${s.file} destructures a different field set than ${shapesPerSite[0].file}`,
        ).toEqual(ref);
      }
    }
  });

  // ── Sanity: SHAPES is non-empty ──────────────────────────────────

  it('migration parser discovered at least 9 public RPCs', () => {
    // 2026-05-04 — bumped from 8 → 9 with redeem_coupon (0022_coupons.sql).
    expect(SHAPES.size).toBeGreaterThanOrEqual(9);
  });
});
