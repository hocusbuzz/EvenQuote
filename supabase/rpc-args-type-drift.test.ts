// R37(b) RPC argument TYPE drift audit.
//
// R36(d) (`supabase/rpc-args-drift.test.ts`) locks RPC argument
// NAMES: every name passed by `.rpc(...)` must exist in the
// signature, every required arg must be supplied, etc. It does
// NOT lock TYPES — a migration that silently changes
// `p_request_id` from `uuid` to `text` would pass every existing
// audit today but break the runtime when the app's zod-validated
// UUID gets rejected by a narrower column constraint, or worse,
// fails silently.
//
// This file extends the R36(d) parser to also capture the raw
// TYPE token for each arg, normalizes via `canonicalizeType()`
// (the same canonicalizer used by R36(b) column-type audit in
// `supabase/migrations-drift.test.ts`), and locks expected types
// for every RPC the app relies on.
//
// Scope:
//
//   • Locks arg TYPE for every required arg in every public RPC
//     the app calls (apply_call_end, recompute_business_success_rate,
//     businesses_within_radius, pick_vapi_number,
//     increment_quotes_collected).
//
//   • Optional-arg types (DEFAULT-carrying) are locked too when
//     present — a silent widening of `p_daily_cap int` to `text`
//     would break the single-arg caller in select-vapi-number.ts
//     because the DEFAULT expression `75` wouldn't coerce.
//
// Out of scope:
//
//   • RETURN types (covered by R37(a)).
//   • `IN`/`OUT`/`INOUT` modifiers — all public RPCs use
//     default-mode (IN). If an OUT arg shows up later, extend
//     the parser.
//
// Remediation when this fires:
//
//   (a) restore the original arg type in a new migration, OR
//   (b) update EXPECTED_ARG_TYPES below AND the call-site
//       zod-validated shape to match the new type.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── SQL comment stripper + canonicalizer (lifted from
//    supabase/migrations-drift.test.ts R36 block to keep the
//    vocabulary consistent across audits) ────────────────────────
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, '');
}

function canonicalizeType(raw: string): string {
  const t = raw.trim().toLowerCase();
  const noParen = t.replace(/\(.*?\)/g, '').trim();
  if (noParen === 'integer' || noParen === 'int' || noParen === 'int4') return 'int';
  if (noParen === 'bigint' || noParen === 'int8') return 'bigint';
  if (noParen === 'smallint' || noParen === 'int2') return 'smallint';
  if (noParen === 'timestamptz' || noParen === 'timestamp with time zone') return 'timestamptz';
  if (noParen === 'timestamp' || noParen === 'timestamp without time zone') return 'timestamp';
  if (noParen === 'numeric' || noParen === 'decimal') return 'numeric';
  if (noParen === 'text' || noParen === 'varchar' || noParen === 'character varying') return 'text';
  if (noParen === 'citext') return 'citext';
  if (noParen === 'boolean' || noParen === 'bool') return 'boolean';
  if (noParen === 'jsonb') return 'jsonb';
  if (noParen === 'json') return 'json';
  if (noParen === 'uuid') return 'uuid';
  const enumNames = new Set([
    'user_role',
    'quote_request_status',
    'call_status',
    'payment_status',
  ]);
  if (enumNames.has(noParen)) return `enum:${noParen}`;
  return noParen;
}

// ── Signature parser extended to capture TYPE per arg ─────────────
type TypedArg = {
  name: string;
  type: string; // canonicalized
  rawType: string; // pre-canonicalization — useful for drift messages
  hasDefault: boolean;
};
type TypedRpcSignature = {
  fnName: string;
  args: TypedArg[];
  definedInFile: string;
};

function parseTypedFunctionsInFile(file: string, source: string): TypedRpcSignature[] {
  const out: TypedRpcSignature[] = [];
  const stripped = stripSqlComments(source);
  const re = /create\s+or\s+replace\s+function\s+public\.([A-Za-z_][\w]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const fnName = m[1];
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let i = openIdx + 1;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = stripped.slice(openIdx + 1, i - 1);

    // String-literal + paren-depth aware comma split (reused pattern).
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

    const args: TypedArg[] = [];
    for (const raw of parts) {
      const t = raw.trim();
      if (t.length === 0) continue;
      // `[IN|OUT|INOUT]? <name> <type>( <params>? )? [DEFAULT <expr> | = <expr>]?`.
      // We capture (modifier?) then name then type. Type is one
      // identifier, optionally followed by `(...)` for parameterized
      // types like `numeric(9,2)`.
      const full =
        /^(?:in\s+|out\s+|inout\s+)?([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*(?:\s*\([^)]*\))?)/i.exec(t);
      if (!full) continue;
      const name = full[1];
      const rawType = full[2];
      const hasDefault = /\bdefault\b/i.test(t) || /=\s*[^,)]/.test(t);
      args.push({
        name,
        type: canonicalizeType(rawType),
        rawType,
        hasDefault,
      });
    }
    out.push({ fnName, args, definedInFile: path.basename(file) });
  }
  return out;
}

function buildTypedSignatureIndex(): Map<string, TypedRpcSignature> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const byName = new Map<string, TypedRpcSignature>();
  for (const f of files) {
    const abs = path.join(MIGRATIONS_DIR, f);
    const src = fs.readFileSync(abs, 'utf8');
    for (const sig of parseTypedFunctionsInFile(abs, src)) {
      byName.set(sig.fnName, sig); // later-wins
    }
  }
  return byName;
}

const TYPED_SIG_INDEX = buildTypedSignatureIndex();

// ── EXPECTED_ARG_TYPES ────────────────────────────────────────────
// Drift-locked expected types per RPC. If a migration silently
// widens `p_request_id` from uuid to text, this map fails the audit
// with a specific message.
//
// Only covers the RPCs the app relies on. Helper SQL functions
// (set_updated_at, handle_new_user, is_admin) are not .rpc()-called
// so their arg types aren't locked here.
type ExpectedSig = {
  args: Array<{ name: string; type: string; hasDefault: boolean }>;
};
const EXPECTED_ARG_TYPES: Record<string, ExpectedSig> = {
  apply_call_end: {
    args: [
      { name: 'p_request_id', type: 'uuid', hasDefault: false },
      { name: 'p_call_id', type: 'uuid', hasDefault: false },
      { name: 'p_quote_inserted', type: 'boolean', hasDefault: false },
    ],
  },
  recompute_business_success_rate: {
    args: [
      { name: 'p_business_id', type: 'uuid', hasDefault: false },
      // `p_window integer default 20` — DEFAULT present, canonicalizes to int.
      { name: 'p_window', type: 'int', hasDefault: true },
    ],
  },
  businesses_within_radius: {
    args: [
      { name: 'p_category_id', type: 'uuid', hasDefault: false },
      { name: 'p_lat', type: 'numeric', hasDefault: false },
      { name: 'p_lng', type: 'numeric', hasDefault: false },
      { name: 'p_radius_miles', type: 'numeric', hasDefault: false },
      { name: 'p_limit', type: 'int', hasDefault: false },
    ],
  },
  pick_vapi_number: {
    args: [
      { name: 'p_area_code', type: 'text', hasDefault: false },
      // `p_daily_cap int default 75` — DEFAULT present, canonicalizes to int.
      { name: 'p_daily_cap', type: 'int', hasDefault: true },
    ],
  },
  increment_quotes_collected: {
    args: [{ name: 'p_request_id', type: 'uuid', hasDefault: false }],
  },
};

describe('supabase/ RPC arg TYPE drift audit (R37b)', () => {
  // ── Parser sanity ────────────────────────────────────────────────
  it('discovers every RPC in EXPECTED_ARG_TYPES in the typed signature index', () => {
    const missing = Object.keys(EXPECTED_ARG_TYPES).filter(
      (fn) => !TYPED_SIG_INDEX.has(fn),
    );
    expect(
      missing,
      `RPCs in EXPECTED_ARG_TYPES missing from typed signature index: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('extended parser captures at least one non-empty rawType per arg (sanity)', () => {
    const empties: string[] = [];
    for (const [fnName, sig] of TYPED_SIG_INDEX.entries()) {
      for (const arg of sig.args) {
        if (arg.rawType.trim().length === 0) {
          empties.push(`${fnName}.${arg.name}`);
        }
      }
    }
    expect(empties, `args with empty rawType: ${empties.join(', ')}`).toEqual([]);
  });

  // ── Canonicalization soundness: every captured type canonicalizes
  //    to a known vocabulary entry. Unknown tokens get returned as-
  //    is by canonicalizeType(); the knownCanonicals set below must
  //    stay in sync with the canonicalizer. A new Postgres type
  //    (inet, tsvector, etc.) lands as an unknown → test fires →
  //    extend canonicalizeType + add the canonical here.
  it('every parsed arg type canonicalizes to a known vocabulary entry (extend canonicalizeType when this fires)', () => {
    const knownCanonicals = new Set([
      'int',
      'bigint',
      'smallint',
      'timestamptz',
      'timestamp',
      'numeric',
      'text',
      'citext',
      'boolean',
      'jsonb',
      'json',
      'uuid',
      'enum:user_role',
      'enum:quote_request_status',
      'enum:call_status',
      'enum:payment_status',
    ]);
    const unknowns: string[] = [];
    for (const [fnName, sig] of TYPED_SIG_INDEX.entries()) {
      for (const arg of sig.args) {
        if (!knownCanonicals.has(arg.type)) {
          unknowns.push(`${fnName}.${arg.name}=${arg.type}`);
        }
      }
    }
    expect(
      unknowns,
      `unrecognized canonical arg types found — extend canonicalizeType() or knownCanonicals:\n  ${unknowns.join('\n  ')}`,
    ).toEqual([]);
  });

  // ── Per-RPC arg type lock ────────────────────────────────────────
  for (const [fnName, expected] of Object.entries(EXPECTED_ARG_TYPES)) {
    it(`${fnName}: every expected arg name+type matches the current signature`, () => {
      const sig = TYPED_SIG_INDEX.get(fnName);
      expect(sig, `${fnName} missing from typed signature index`).toBeDefined();
      if (!sig) return;
      const byName = new Map(sig.args.map((a) => [a.name, a]));
      const mismatches: string[] = [];
      for (const want of expected.args) {
        const actual = byName.get(want.name);
        if (!actual) {
          mismatches.push(
            `${fnName}: arg '${want.name}' expected (type=${want.type}) but not declared in ${sig.definedInFile}`,
          );
          continue;
        }
        if (actual.type !== want.type) {
          mismatches.push(
            `${fnName}.${want.name}: expected type '${want.type}' but signature declares '${actual.type}' (raw='${actual.rawType}') in ${sig.definedInFile}`,
          );
        }
        if (actual.hasDefault !== want.hasDefault) {
          mismatches.push(
            `${fnName}.${want.name}: expected hasDefault=${want.hasDefault} but signature has hasDefault=${actual.hasDefault} in ${sig.definedInFile}`,
          );
        }
      }
      expect(
        mismatches,
        `arg type drift in ${fnName}:\n  ${mismatches.join('\n  ')}`,
      ).toEqual([]);
    });
  }

  // ── Narrow critical invariants ────────────────────────────────────
  it('apply_call_end: p_request_id and p_call_id stay uuid, p_quote_inserted stays boolean (narrowest lock)', () => {
    // A widening of p_request_id / p_call_id to text would allow the
    // app's UUID zod parse to pass, then the RPC would silently
    // accept anything — including non-existent row IDs — breaking
    // the 0008 idempotency ledger. Narrowest possible lock.
    const sig = TYPED_SIG_INDEX.get('apply_call_end');
    expect(sig).toBeDefined();
    if (!sig) return;
    const byName = new Map(sig.args.map((a) => [a.name, a]));
    expect(byName.get('p_request_id')?.type).toBe('uuid');
    expect(byName.get('p_call_id')?.type).toBe('uuid');
    expect(byName.get('p_quote_inserted')?.type).toBe('boolean');
  });

  it('pick_vapi_number: p_area_code is text, p_daily_cap is int with DEFAULT (single-arg-caller anchor)', () => {
    // `lib/calls/select-vapi-number.ts` only passes p_area_code
    // and relies on p_daily_cap's DEFAULT. A silent int→text widen
    // of p_daily_cap would change the DEFAULT from `75` to require
    // a string and break dispatch.
    const sig = TYPED_SIG_INDEX.get('pick_vapi_number');
    expect(sig).toBeDefined();
    if (!sig) return;
    const byName = new Map(sig.args.map((a) => [a.name, a]));
    const areaCode = byName.get('p_area_code');
    const dailyCap = byName.get('p_daily_cap');
    expect(areaCode?.type).toBe('text');
    expect(areaCode?.hasDefault).toBe(false);
    expect(dailyCap?.type).toBe('int');
    expect(dailyCap?.hasDefault).toBe(true);
  });

  it('increment_quotes_collected: p_request_id stays uuid (webhook retry invariant)', () => {
    // Called from app/api/twilio/sms + app/api/vapi/inbound-callback.
    // A drift to text would cause any non-uuid string to be silently
    // accepted and counter-bump the wrong request_id or error out
    // on cast. Lock.
    const sig = TYPED_SIG_INDEX.get('increment_quotes_collected');
    expect(sig).toBeDefined();
    if (!sig) return;
    expect(sig.args.length).toBe(1);
    expect(sig.args[0].name).toBe('p_request_id');
    expect(sig.args[0].type).toBe('uuid');
    expect(sig.args[0].hasDefault).toBe(false);
  });

  it('businesses_within_radius: all geo args stay numeric, p_limit stays int', () => {
    // Radius search is hot-path during enqueue. Any type drift here
    // breaks the distance-ranked candidate list. Geo args must stay
    // `numeric` (NOT `double precision` or `float8`) so Postgres
    // uses the same precision the app sends.
    const sig = TYPED_SIG_INDEX.get('businesses_within_radius');
    expect(sig).toBeDefined();
    if (!sig) return;
    const byName = new Map(sig.args.map((a) => [a.name, a]));
    expect(byName.get('p_lat')?.type).toBe('numeric');
    expect(byName.get('p_lng')?.type).toBe('numeric');
    expect(byName.get('p_radius_miles')?.type).toBe('numeric');
    expect(byName.get('p_limit')?.type).toBe('int');
    expect(byName.get('p_category_id')?.type).toBe('uuid');
  });

  // ── Forbidden types at anchor positions ──────────────────────────
  it('no RPC arg that the app treats as a UUID is actually declared as text (narrow safety check)', () => {
    // Defense-in-depth against the subtlest drift: anything named
    // `p_*_id` or `p_*_uuid` in the signature should be uuid, not
    // text. Catches a future maintainer who copies a `p_something_id
    // text` column from a different schema as-is.
    const suspicious: string[] = [];
    for (const [fnName, sig] of TYPED_SIG_INDEX.entries()) {
      for (const arg of sig.args) {
        const looksLikeId = /_id$|_uuid$/.test(arg.name);
        if (looksLikeId && arg.type !== 'uuid') {
          suspicious.push(
            `${fnName}.${arg.name}: name suggests uuid but type is '${arg.type}' (raw='${arg.rawType}')`,
          );
        }
      }
    }
    expect(
      suspicious,
      `suspected uuid-shaped arg with non-uuid type:\n  ${suspicious.join('\n  ')}`,
    ).toEqual([]);
  });
});
