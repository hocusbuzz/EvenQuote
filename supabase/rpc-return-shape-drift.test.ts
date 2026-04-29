// R37(a) RPC RETURN-shape drift audit.
//
// Counterpart to the R36(d) RPC argument round-trip audit
// (`supabase/rpc-args-drift.test.ts`). That file locks the INPUT
// side: arg names passed by `.rpc(...)` must exist in the signature,
// required args must be supplied, etc.
//
// This file locks the OUTPUT side:
//
//   • every `returns table (...)` column declared in a migration is
//     asserted to match the TypeScript row type the app casts the
//     RPC response to (whether via `data[0] as { ... }` or
//     `(data ?? []).map((r: { ... }) => ...)`).
//
//   • every scalar-return RPC (`returns integer`, `returns numeric`,
//     etc.) is recorded so future contributors can't silently widen
//     it to `returns table` without the app-side consumer being
//     audited.
//
// Why this is needed:
//
//   Today, the app-side shapes are inline TS annotations at each
//   .rpc() call site. If a migration drops a column from a table
//   return (e.g. `apply_call_end` loses `total_quotes_collected`),
//   Supabase will happily return whatever columns remain and the
//   TypeScript cast will silently narrow — destructuring an absent
//   field yields `undefined`, which then feeds into downstream
//   counter logic as NaN. The break surfaces only at preview-deploy
//   or production, never in CI.
//
// Out of scope (deliberately):
//
//   • End-to-end shape-against-actual-Postgres type generation —
//     that's the job of `supabase gen types`, which is a human-
//     triggered step.
//   • Column TYPE parity (text vs uuid vs int). R37(b) covers that
//     separately — this file locks column NAMES and SET equality
//     only.
//   • trigger_cron_route + helper SQL functions in `private.`. The
//     app never calls them; pg_cron fires them on schedule.
//
// Remediation when this audit fires:
//
//   (a) add the missing column to the migration's `returns table (...)`
//       body, OR
//   (b) update the app-side TS row annotation to match the new shape
//       if the column was intentionally dropped.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const APP_ROOTS = [
  path.resolve(process.cwd(), 'app'),
  path.resolve(process.cwd(), 'lib'),
];

// ── Migration-side return-shape parser ───────────────────────────────
type RpcReturn =
  | { fnName: string; kind: 'table'; columns: string[]; definedInFile: string }
  | { fnName: string; kind: 'scalar'; scalarType: string; definedInFile: string };

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, '');
}

// Extract every `create or replace function public.<name>(<args>) returns <something>`
// from one migration file. For each, classify as 'table' or 'scalar' and
// extract the relevant shape information.
function parseReturnsInFile(file: string, source: string): RpcReturn[] {
  const out: RpcReturn[] = [];
  const stripped = stripSqlComments(source);
  // Public-schema only; private.trigger_cron_route is pg_cron-only.
  const re = /create\s+or\s+replace\s+function\s+public\.([A-Za-z_][\w]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const fnName = m[1];
    const openIdx = m.index + m[0].length - 1; // position of `(`
    // Balanced-paren walk past the args.
    let depth = 1;
    let i = openIdx + 1;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue;
    // After the args-close paren, the `returns ...` clause follows.
    const tail = stripped.slice(i);
    // Pattern A: `returns table ( col1 type1, col2 type2, ... )`.
    const tblMatch = /^\s*returns\s+table\s*\(/i.exec(tail);
    if (tblMatch) {
      const tblOpenIdx = tblMatch[0].length - 1; // at `(` inside tail
      // Balanced-paren walk over the returns-table body.
      let tdepth = 1;
      let j = tblOpenIdx + 1;
      for (; j < tail.length && tdepth > 0; j++) {
        const ch = tail[j];
        if (ch === '(') tdepth++;
        else if (ch === ')') tdepth--;
      }
      if (tdepth !== 0) continue;
      const body = tail.slice(tblOpenIdx + 1, j - 1);
      // String-literal + paren-depth aware comma split. Mirrors the
      // R36(b) column-type parser in `supabase/migrations-drift.test.ts`
      // and the R36(d) arg parser in `supabase/rpc-args-drift.test.ts`.
      const parts: string[] = [];
      let cur = '';
      let pdepth = 0;
      let inString = false;
      for (let k = 0; k < body.length; k++) {
        const ch = body[k];
        if (ch === "'") {
          if (inString && body[k + 1] === "'") {
            cur += ch;
            cur += body[++k];
            continue;
          }
          inString = !inString;
          cur += ch;
          continue;
        }
        if (!inString) {
          if (ch === '(') pdepth++;
          else if (ch === ')') pdepth--;
          if (ch === ',' && pdepth === 0) {
            parts.push(cur);
            cur = '';
            continue;
          }
        }
        cur += ch;
      }
      if (cur.trim().length > 0) parts.push(cur);
      const columns: string[] = [];
      for (const raw of parts) {
        const t = raw.trim();
        if (t.length === 0) continue;
        const nameMatch = /^([A-Za-z_][\w]*)/.exec(t);
        if (!nameMatch) continue;
        columns.push(nameMatch[1]);
      }
      out.push({ fnName, kind: 'table', columns, definedInFile: path.basename(file) });
      continue;
    }
    // Pattern B: `returns <scalar-type>`. We grab one identifier after
    // `returns` (plus optional parameterized paren body for e.g.
    // numeric(9,2)), stopping at whitespace or EOL. Reject 'table'.
    const scalarMatch = /^\s*returns\s+([A-Za-z_][\w]*)(\s*\([^)]*\))?/i.exec(tail);
    if (scalarMatch) {
      const t = scalarMatch[1].toLowerCase();
      if (t === 'table') continue; // shouldn't happen — pattern A caught it
      out.push({ fnName, kind: 'scalar', scalarType: t, definedInFile: path.basename(file) });
    }
  }
  return out;
}

function buildReturnIndex(): Map<string, RpcReturn> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const byName = new Map<string, RpcReturn>();
  for (const f of files) {
    const abs = path.join(MIGRATIONS_DIR, f);
    const src = fs.readFileSync(abs, 'utf8');
    for (const ret of parseReturnsInFile(abs, src)) {
      // create-or-replace = later-wins.
      byName.set(ret.fnName, ret);
    }
  }
  return byName;
}

const RETURN_INDEX = buildReturnIndex();

// ── Tests ────────────────────────────────────────────────────────────
describe('supabase/ RPC return-shape drift audit (R37a)', () => {
  // ── Parser sanity ─────────────────────────────────────────────────
  it('discovers at least 5 RPC return-shapes in migrations (parser sanity)', () => {
    // Public RPCs at R36 close: apply_call_end, pick_vapi_number,
    // businesses_within_radius (table); recompute_business_success_rate,
    // increment_quotes_collected (scalar); plus set_updated_at /
    // handle_new_user / is_admin (scalar/trigger — counted too).
    expect(RETURN_INDEX.size).toBeGreaterThanOrEqual(5);
  });

  it('count band: 5-15 return shapes (drift tripwire)', () => {
    // Same rationale as the R36(d) sanity band.
    expect(RETURN_INDEX.size).toBeGreaterThanOrEqual(5);
    expect(RETURN_INDEX.size).toBeLessThanOrEqual(15);
  });

  // ── apply_call_end: table return ─────────────────────────────────
  it('apply_call_end (post-R31) returns exactly 5 columns in the canonical order', () => {
    // The R31 idempotency migration 0008_end_of_call_idempotency.sql
    // widened apply_call_end from 2-arg to 3-arg. The RETURN shape
    // stayed the same 5-column table that engine.ts / retry-failed-
    // calls.ts / send-reports.ts pipeline depends on.
    //
    // Historically the app didn't destructure the return (it only
    // checks `rpcErr`), but any future consumer that DOES destructure
    // will be reading these names — lock the shape.
    const ret = RETURN_INDEX.get('apply_call_end');
    expect(ret, 'apply_call_end not in return index').toBeDefined();
    if (!ret) return;
    expect(ret.kind).toBe('table');
    if (ret.kind !== 'table') return;
    expect(ret.columns).toEqual([
      'request_id',
      'status',
      'total_calls_completed',
      'total_quotes_collected',
      'total_businesses_to_call',
    ]);
    // Lock source: post-R31 must come from 0008, not the 0006 form.
    expect(ret.definedInFile).toBe('0008_end_of_call_idempotency.sql');
  });

  // ── pick_vapi_number: table return, app DOES destructure ─────────
  it('pick_vapi_number returns { id, twilio_e164, area_code, tier } — matches app-side `data[0] as {…}` cast', () => {
    // The app calls this RPC from `lib/calls/select-vapi-number.ts`
    // and casts `data[0]` to `{ id: string; twilio_e164: string;
    // area_code: string; tier: string }`. If a migration drops any
    // of those columns, the cast silently yields `undefined` for
    // that field and dispatch fails in a hard-to-diagnose way.
    const ret = RETURN_INDEX.get('pick_vapi_number');
    expect(ret, 'pick_vapi_number not in return index').toBeDefined();
    if (!ret) return;
    expect(ret.kind).toBe('table');
    if (ret.kind !== 'table') return;
    expect(new Set(ret.columns)).toEqual(
      new Set(['id', 'twilio_e164', 'area_code', 'tier']),
    );
    expect(ret.columns.length).toBe(4);
  });

  // ── businesses_within_radius: table return, app DOES destructure ──
  it('businesses_within_radius return contains every column the app maps over', () => {
    // `lib/calls/select-businesses.ts` maps the result to
    // `{ id, name, phone, google_rating, zip_code }`. The migration
    // returns 9 columns; the app only consumes 5. That's fine — but
    // the 5 it consumes MUST be present. Lock only the consumed
    // subset with a SUPERSET assertion so future additions to the
    // migration don't break this test.
    const ret = RETURN_INDEX.get('businesses_within_radius');
    expect(ret, 'businesses_within_radius not in return index').toBeDefined();
    if (!ret) return;
    expect(ret.kind).toBe('table');
    if (ret.kind !== 'table') return;
    for (const required of ['id', 'name', 'phone', 'google_rating', 'zip_code']) {
      expect(
        ret.columns,
        `businesses_within_radius missing column '${required}' — lib/calls/select-businesses.ts would silently .map() undefined`,
      ).toContain(required);
    }
  });

  // ── recompute_business_success_rate: scalar return ──────────────
  it('recompute_business_success_rate returns numeric (scalar)', () => {
    // Called from `apply-end-of-call.ts` best-effort. The app
    // ignores the return value (only checks error), but locking
    // the scalar shape guards against a well-meaning "return
    // something useful" refactor that would silently widen this
    // to `returns table` and break the existing destructure-free
    // call site.
    const ret = RETURN_INDEX.get('recompute_business_success_rate');
    expect(ret, 'recompute_business_success_rate not in return index').toBeDefined();
    if (!ret) return;
    expect(ret.kind).toBe('scalar');
    if (ret.kind !== 'scalar') return;
    expect(ret.scalarType).toBe('numeric');
  });

  // ── increment_quotes_collected: scalar return ────────────────────
  it('increment_quotes_collected returns integer (scalar)', () => {
    // Webhook-side counter bump from twilio/sms + vapi/inbound-
    // callback. The app ignores the return (logs bumpErr only).
    // Lock scalar shape so a future migration doesn't silently turn
    // this into a record-returning form that breaks the log-only
    // error check.
    const ret = RETURN_INDEX.get('increment_quotes_collected');
    expect(ret, 'increment_quotes_collected not in return index').toBeDefined();
    if (!ret) return;
    expect(ret.kind).toBe('scalar');
    if (ret.kind !== 'scalar') return;
    expect(ret.scalarType).toBe('integer');
  });

  // ── Parser guard: no phantom 'table' misclassifications ──────────
  it('no RPC appears simultaneously as both a table-return and a scalar-return (parser sanity)', () => {
    // A safety net against a parser change: both pattern A and
    // pattern B running over the same function should be impossible
    // because pattern A has `return table` and pattern B has
    // anything-but-table.
    // We just re-index and validate each function resolved to one
    // shape.
    for (const [fnName, ret] of RETURN_INDEX.entries()) {
      expect(ret.fnName).toBe(fnName);
      if (ret.kind === 'table') {
        expect((ret as unknown as { scalarType?: string }).scalarType).toBeUndefined();
      } else {
        expect((ret as unknown as { columns?: string[] }).columns).toBeUndefined();
      }
    }
  });

  // ── App-side consumer shape round-trip ───────────────────────────
  it('app-side TS row cast for pick_vapi_number matches migration return columns exactly (forward + reverse)', () => {
    // Forward: every app-named field is declared in the migration.
    // Reverse: every migration-returned column is named in the app
    // cast (catches the "migration gained a column, app cast got
    // stale" drift). `pick_vapi_number` is the only RPC where the
    // app destructures the return AND consumes every field; it's
    // the strongest round-trip site in the codebase today.
    const ret = RETURN_INDEX.get('pick_vapi_number');
    expect(ret, 'pick_vapi_number not in return index').toBeDefined();
    if (!ret || ret.kind !== 'table') return;

    const filePath = path.resolve(process.cwd(), 'lib/calls/select-vapi-number.ts');
    const src = fs.readFileSync(filePath, 'utf8');
    // Grab the inline TS type in the `data[0] as { ... }` cast.
    // The shape is stable; this regex just needs to find the body.
    const castMatch = /data\[0\]\s+as\s+\{([^}]+)\}/.exec(src);
    expect(
      castMatch,
      'expected `data[0] as { … }` cast in lib/calls/select-vapi-number.ts',
    ).not.toBeNull();
    if (!castMatch) return;
    const fields = Array.from(
      castMatch[1].matchAll(/([A-Za-z_][\w]*)\s*:/g),
      (m) => m[1],
    );
    expect(new Set(fields)).toEqual(new Set(ret.columns));
  });

  it('app-side TS map body for businesses_within_radius names only columns the migration actually returns', () => {
    // `(data ?? []).map((r: { … }) => ...)`. We enforce the app's
    // fields are a SUBSET of the migration columns (app may consume
    // fewer than the RPC returns — that's fine).
    const ret = RETURN_INDEX.get('businesses_within_radius');
    expect(ret).toBeDefined();
    if (!ret || ret.kind !== 'table') return;
    const filePath = path.resolve(process.cwd(), 'lib/calls/select-businesses.ts');
    const src = fs.readFileSync(filePath, 'utf8');
    // Locate the map body: `.map((r: { ... }) =>`
    const mapMatch = /\.map\s*\(\s*\(\s*r:\s*\{([^}]+)\}\s*\)\s*=>/.exec(src);
    expect(
      mapMatch,
      'expected `.map((r: { … }) =>` in lib/calls/select-businesses.ts',
    ).not.toBeNull();
    if (!mapMatch) return;
    const appFields = Array.from(
      mapMatch[1].matchAll(/([A-Za-z_][\w]*)\s*:/g),
      (m) => m[1],
    );
    const migrationCols = new Set(ret.columns);
    const extra = appFields.filter((f) => !migrationCols.has(f));
    expect(
      extra,
      `app-side map body references columns the migration does NOT return: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  // ── Comprehensive app-RPC-callsite SCALAR forbidden-destructure lock ─
  it('all SCALAR-return RPCs the app calls have no `data[0]` / `data?.[0]` destructure at the call site (forbidden-destructure)', () => {
    // If a future refactor sprinkles `data[0]` at a scalar-return
    // RPC call site, the cast silently yields `undefined` (scalars
    // serialize as a plain value, not an array). Lock.
    //
    // Scan every .ts in app/ + lib/ (excluding tests + d.ts) for
    // `.rpc('<name>'` followed by a block where `data[...]` is
    // accessed. For each scalar-return fnName, fail if the pattern
    // appears in the same function body.
    const scalarFns = Array.from(RETURN_INDEX.values())
      .filter((r): r is Extract<RpcReturn, { kind: 'scalar' }> => r.kind === 'scalar')
      .map((r) => r.fnName);

    const tsFiles: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue;
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

    const violations: string[] = [];
    for (const f of tsFiles) {
      const src = fs.readFileSync(f, 'utf8');
      for (const fn of scalarFns) {
        // Crude but effective: find each .rpc('<fn>' call, then scan
        // the next 400 chars for `data[` OR `data?.[`.
        const callRe = new RegExp(`\\.rpc\\s*\\(\\s*['"\`]${fn}['"\`]`, 'g');
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(src)) !== null) {
          const window = src.slice(m.index, m.index + 400);
          if (/\bdata\s*\[/.test(window) || /\bdata\s*\?\.\s*\[/.test(window)) {
            violations.push(
              `${path.relative(process.cwd(), f)}: .rpc('${fn}') uses data[...] destructure, but ${fn} returns a scalar`,
            );
          }
        }
      }
    }
    expect(
      violations,
      `scalar-return RPCs being destructured like tables:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});
