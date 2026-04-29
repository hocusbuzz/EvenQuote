// R38(c) — Zod-schema vs migration-column type drift audit.
//
// Several zod schemas in `lib/actions/*.ts` validate user-supplied
// form data that is then inserted into (or used to look up rows in)
// Postgres tables. A silent divergence between the zod field type
// and the actual column type manifests as either:
//
//   • A runtime insert failure (a caller-facing 500 with no zod
//     error at the boundary), or worse —
//   • A silent coercion, where a field that zod calls a `string`
//     becomes whatever Postgres will cast it to (text → uuid is
//     a FATAL coercion; text → citext is a SILENT coercion).
//
// This audit cross-checks a curated SCHEMA_FIELD_MAP naming each
// (schema, field) → (table, column) mapping, and asserts:
//
//   1. The zod field's declared type is COMPATIBLE with the migration
//      column type (using the R36-canonicalized vocabulary —
//      `canonicalizeType()` in migrations-drift.test.ts).
//   2. Every locked (table, column) actually exists in the current
//      migration schema (drift-catches a rename/drop of the column
//      the schema was mapped to).
//   3. Every schema field we lock is present in the schema source
//      (drift-catches a rename of the zod field in the action).
//
// Intentionally NOT in scope for this round:
//   • The big `intake_data: jsonb` bag — that's deliberately schemaless
//     Postgres-side; the zod `MovingIntakeSchema` shape change is a
//     handler-layer concern, not a DB drift.
//   • Compound transforms (e.g. `z.string().trim().toLowerCase()`) —
//     we resolve the INNER zod type (`string`) and check against the
//     column. Trim/case normalization are at the app layer.
//   • Custom Postgres enums — classified via the R36 convention
//     `enum:<typename>`. We don't lock any enum fields this round
//     (the only enum in an action-inserted column is `status`, which
//     is hardcoded `'pending_payment'` — no zod-supplied values).
//
// Complements R36 `migrations-drift.test.ts` (column name + type
// inventory) and R35 `lib-reason-types.test.ts` (round-trip on
// capture tag Reason unions). Those two locks protect the DB side
// and the observability side respectively; this lock protects the
// inbound boundary.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsPreservingPositions } from '../../tests/helpers/source-walker';

const ACTIONS_DIR = path.resolve(process.cwd(), 'lib/actions');
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── Inferred zod type — the INNER primitive type after chaining ─────
//
// We intentionally do NOT try to reproduce zod's full type inference.
// We scan the source for `<field>: z.<method>(...)` and classify by
// the FIRST method token (`string`, `number`, `boolean`, `uuid`).
// The chained `.uuid()` call on a string gets special-cased: a
// `z.string().uuid(...)` is treated as `uuid`, because that's what
// actually gets validated at runtime.

type ZodInferred = 'string' | 'uuid' | 'number' | 'boolean' | 'unknown';

// ── Canonical column-type vocabulary (extends R36) ──────────────────
//
// Must stay in sync with the `canonicalizeType()` function in
// `supabase/migrations-drift.test.ts`. If a new Postgres type lands
// in a migration that this audit needs to see, add it to both.

type CanonicalColumnType =
  | 'uuid'
  | 'text'
  | 'citext'
  | 'int'
  | 'numeric'
  | 'boolean'
  | 'jsonb'
  | 'timestamptz'
  | 'date'
  | `enum:${string}`
  | string; // fall-through for unknowns — surfaced by canonicalization test

function canonicalizeType(raw: string): CanonicalColumnType {
  const lc = raw.trim().toLowerCase();
  if (/^int\d?$|^integer$/.test(lc)) return 'int';
  if (/^numeric(\s*\([^)]+\))?$/.test(lc)) return 'numeric';
  if (/^(text|varchar(\s*\([^)]+\))?)$/.test(lc)) return 'text';
  if (lc === 'citext') return 'citext';
  if (lc === 'uuid') return 'uuid';
  if (lc === 'boolean' || lc === 'bool') return 'boolean';
  if (lc === 'jsonb') return 'jsonb';
  if (lc === 'timestamptz' || lc.startsWith('timestamp ')) return 'timestamptz';
  if (lc === 'date') return 'date';
  // Postgres enum types declared as `create type <name> as enum(...)`.
  // We don't introspect here — the migrations-drift.test.ts treats
  // these as `enum:<name>`. Pass through as lowercase for tripwire.
  return lc;
}

// ── Compatibility: which canonical Postgres types accept a zod type ─
//
// `string` in zod can map to any textual column (text, citext, and
// even to date/timestamptz if the handler parses — but we forbid
// that implicit coercion here).
// `uuid` in zod (== `z.string().uuid()`) only maps to a uuid column.
// `number` maps to int or numeric.
// `boolean` maps to boolean.
//
// Keep this table explicit — narrower is safer than broader.

const COMPAT: Record<ZodInferred, ReadonlySet<string>> = {
  string: new Set(['text', 'citext']),
  uuid: new Set(['uuid']),
  number: new Set(['int', 'numeric']),
  boolean: new Set(['boolean']),
  unknown: new Set<string>(),
};

// ── Curated field mappings ──────────────────────────────────────────
//
// The audit runs against THIS list. Adding a mapping requires:
//   (1) the zod field exists in the schema source,
//   (2) the column exists in the migration schema,
//   (3) the types are compatible per COMPAT above.
//
// Missing any of those three fires the audit.

type FieldMapping = {
  file: string; // under lib/actions/
  schemaVar: string; // const <name> = z.object({...}) — the var name
  field: string; // field name inside the zod object
  expectedZod: ZodInferred;
  table: string; // Postgres table
  column: string; // column the field lands in
  // Why the mapping exists — documentation only, not asserted.
  reason: string;
};

const FIELD_MAPPINGS: FieldMapping[] = [
  // ── Waitlist: direct field-to-column mapping for TWO of three ────
  // `categorySlug` is a lookup value (slug → service_categories.id),
  // not a column — we assert the LOOKUP target separately below.
  {
    file: 'waitlist.ts',
    schemaVar: 'WaitlistSchema',
    field: 'email',
    expectedZod: 'string',
    table: 'waitlist_signups',
    column: 'email',
    reason:
      'waitlist_signups.email is citext (case-insensitive unique); zod string.email() + toLowerCase() normalizes before insert',
  },
  {
    file: 'waitlist.ts',
    schemaVar: 'WaitlistSchema',
    field: 'zipCode',
    expectedZod: 'string',
    table: 'waitlist_signups',
    column: 'zip_code',
    reason: 'zip_code is text (nullable); schema emits "XXXXX" or "XXXXX-YYYY"',
  },
  // ── Checkout: looks up quote_requests by id ──────────────────────
  {
    file: 'checkout.ts',
    schemaVar: 'Input',
    field: 'requestId',
    expectedZod: 'uuid',
    table: 'quote_requests',
    column: 'id',
    reason: 'checkout.createCheckoutSession looks up quote_requests.id by requestId',
  },
];

// ── Parse zod field type from a schema source span ──────────────────
//
// Given the source of `const <schemaVar> = z.object({ ... })`, extract
// the inner object literal and for each field name, determine the
// inferred zod type by looking at the first `z.<method>(` after the
// field's `:`. If `.uuid(` appears inside the chain (before any `,`
// at depth 0), upgrade `string` → `uuid`.
//
// Returns a map from field name to ZodInferred.
function extractZodFields(
  schemaBodySrc: string,
): Map<string, ZodInferred> {
  const out = new Map<string, ZodInferred>();
  const stripped = stripCommentsPreservingPositions(schemaBodySrc);
  // Very simple walker: find lines like `<ident>: z.<method>(` — for
  // each, capture (ident, method). For `string`, check whether `.uuid(`
  // appears in the same "value" span (before the next depth-0 `,`).
  let i = 0;
  while (i < stripped.length) {
    // Match an identifier at the current depth, followed by `:`.
    const identRe = /[A-Za-z_$][\w$]*/y;
    // Skip whitespace.
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    if (i >= stripped.length) break;
    identRe.lastIndex = i;
    const im = identRe.exec(stripped);
    if (!im || im.index !== i) {
      i++;
      continue;
    }
    const ident = im[0];
    i += ident.length;
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    if (stripped[i] !== ':') {
      continue;
    }
    i++;
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    // Read up to the next depth-0 `,` or end.
    let depth = 0;
    let str: false | "'" | '"' | '`' = false;
    let valStart = i;
    for (; i < stripped.length; i++) {
      const ch = stripped[i];
      if (str) {
        if (ch === str && !isEscaped(stripped, i)) str = false;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        str = ch;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) break;
    }
    const valueSrc = stripped.slice(valStart, i);
    const inferred = classifyZodValue(valueSrc);
    if (inferred !== 'unknown') {
      out.set(ident, inferred);
    }
    if (stripped[i] === ',') i++;
  }
  return out;
}

// Shared primitives from `lib/forms/moving-intake.ts` (R45(d)). When
// a field is `foo: EmailSchema` (with optional `.optional()`/`.or()`
// chain) we resolve the identifier to the primitive's underlying
// inferred type so the drift check still fires on the column side.
const SHARED_PRIMITIVE_INFERRED: Record<string, ZodInferred> = {
  EmailSchema: 'string',
  ZipSchema: 'string',
  PhoneSchema: 'string',
  UsStateSchema: 'string', // z.enum(US_STATES) — string union at runtime
};

function classifyZodValue(src: string): ZodInferred {
  // Fast path — resolve a leading shared-primitive identifier.
  const leadingIdent = /^\s*([A-Za-z_$][\w$]*)\b/.exec(src);
  if (leadingIdent && SHARED_PRIMITIVE_INFERRED[leadingIdent[1]]) {
    return SHARED_PRIMITIVE_INFERRED[leadingIdent[1]];
  }

  // Pull the first `z.<method>(` token. Allow whitespace between
  // `z` and `.` and between `.` and the method — fields often chain
  // across multiple lines like `z\n    .string()\n    .trim()`.
  const firstCall = /\bz\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src);
  if (!firstCall) {
    // `z.union(...)` / `z.literal(...)` / `z.object(...)` — bail.
    if (/\bz\s*\.\s*(union|literal|object|array|record|any|unknown)\b/.test(src)) {
      return 'unknown';
    }
    return 'unknown';
  }
  const method = firstCall[1];
  if (method === 'string') {
    // Upgrade if `.uuid(` is chained on the string.
    if (/\.\s*uuid\s*\(/.test(src)) return 'uuid';
    return 'string';
  }
  if (method === 'uuid') return 'uuid'; // zod v4 standalone `z.uuid()`
  if (method === 'number') return 'number';
  if (method === 'boolean') return 'boolean';
  return 'unknown';
}

function isEscaped(s: string, i: number): boolean {
  let bs = 0;
  let b = i - 1;
  while (b >= 0 && s[b] === '\\') {
    bs++;
    b--;
  }
  return bs % 2 === 1;
}

// ── Parse `const <schemaVar> = z.object({ ... })` body from a source file ─

function extractSchemaBody(src: string, schemaVar: string): string | null {
  const stripped = stripCommentsPreservingPositions(src);
  const headerRe = new RegExp(
    `const\\s+${escapeRe(schemaVar)}\\s*=\\s*z\\.object\\s*\\(\\s*\\{`,
  );
  const m = headerRe.exec(stripped);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // position of `{`
  let depth = 0;
  let str: false | "'" | '"' | '`' = false;
  let i = start;
  for (; i < stripped.length; i++) {
    const ch = stripped[i];
    if (str) {
      if (ch === str && !isEscaped(stripped, i)) str = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return stripped.slice(start + 1, i);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Build a (table, column) → canonicalized-type map from migrations ─
//
// A lightweight re-parser focused on `create table` + `alter table add
// column`. Does NOT replicate every edge case of `migrations-drift.test
// .ts` — this audit only needs to look up specific (table, column)
// pairs listed in FIELD_MAPPINGS.

function buildMigrationTypeMap(): Map<string, Map<string, string>> {
  const tableMap = new Map<string, Map<string, string>>();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Strip -- line comments.
    const cleaned = sql.replace(/--[^\n]*/g, '');
    // Match `create table [if not exists] public.<name> ( ... );`.
    const createRe =
      /create\s+table(?:\s+if\s+not\s+exists)?\s+public\.([A-Za-z_][\w]*)\s*\(([\s\S]*?)\);/gi;
    let cm: RegExpExecArray | null;
    while ((cm = createRe.exec(cleaned)) !== null) {
      const table = cm[1].toLowerCase();
      const body = cm[2];
      const columns = parseColumnLines(body);
      if (!tableMap.has(table)) tableMap.set(table, new Map());
      const t = tableMap.get(table)!;
      for (const [name, type] of columns) {
        t.set(name.toLowerCase(), canonicalizeType(type));
      }
    }
    // Match `alter table public.<name> add column <col> <type> [...]`.
    const alterRe =
      /alter\s+table\s+public\.([A-Za-z_][\w]*)\s+add\s+column(?:\s+if\s+not\s+exists)?\s+([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*(?:\s*\([^)]+\))?)/gi;
    let am: RegExpExecArray | null;
    while ((am = alterRe.exec(cleaned)) !== null) {
      const table = am[1].toLowerCase();
      const col = am[2].toLowerCase();
      const type = am[3];
      if (!tableMap.has(table)) tableMap.set(table, new Map());
      tableMap.get(table)!.set(col, canonicalizeType(type));
    }
  }
  return tableMap;
}

// Parse a `create table public.X (...)` body into [columnName, type] pairs.
// String-literal aware so a default like `'pending, paid'` doesn't split.
function parseColumnLines(body: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const statements = splitTopLevelCommas(body);
  for (const stmt of statements) {
    const s = stmt.trim();
    if (!s) continue;
    // Skip table-level constraints: `constraint ...`, `primary key (...)`,
    // `unique (...)`, `check (...)`, `foreign key (...)`.
    if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(s)) continue;
    // Column line: `<name> <type> [modifiers]`.
    const m = /^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*(?:\s*\([^)]+\))?)/.exec(s);
    if (!m) continue;
    pairs.push([m[1], m[2]]);
  }
  return pairs;
}

function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let str: false | "'" | '"' | '`' = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (str) {
      // Postgres '' escape.
      if (ch === "'" && body[i + 1] === "'") {
        i++;
        continue;
      }
      if (ch === str) str = false;
      continue;
    }
    if (ch === "'") {
      str = "'";
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (start < body.length) out.push(body.slice(start));
  return out;
}

// ── Tests ───────────────────────────────────────────────────────────

const MIGRATION_MAP = buildMigrationTypeMap();

describe('R38(c) — zod schema vs migration column type drift', () => {
  for (const fm of FIELD_MAPPINGS) {
    describe(`${fm.file}::${fm.schemaVar}.${fm.field} → ${fm.table}.${fm.column}`, () => {
      const src = fs.readFileSync(path.join(ACTIONS_DIR, fm.file), 'utf8');
      const body = extractSchemaBody(src, fm.schemaVar);

      it('schema body is extractable', () => {
        expect(
          body,
          `Couldn't extract body of const ${fm.schemaVar} = z.object({...}) in ${fm.file}. Was the schema renamed or restructured?`,
        ).not.toBeNull();
      });

      const fields = body ? extractZodFields(body) : new Map();

      it('zod schema declares the expected field', () => {
        expect(
          fields.has(fm.field),
          `${fm.schemaVar} in ${fm.file} is missing field '${fm.field}'. Expected fields: ${[...fields.keys()].join(', ')}`,
        ).toBe(true);
      });

      it('zod field has the expected inferred type', () => {
        const got = fields.get(fm.field);
        expect(
          got,
          `${fm.schemaVar}.${fm.field} inferred as '${got ?? 'unknown'}'; expected '${fm.expectedZod}'. Look for type drift in the zod chain (e.g. a maintainer removed .uuid() from z.string()).`,
        ).toBe(fm.expectedZod);
      });

      it('mapped migration column exists with a non-empty type', () => {
        const t = MIGRATION_MAP.get(fm.table);
        expect(t, `Table '${fm.table}' not found in migrations`).toBeDefined();
        if (!t) return;
        const colType = t.get(fm.column);
        expect(
          colType,
          `Column '${fm.column}' not found in table '${fm.table}'. Either the migration renamed it or the mapping is stale.`,
        ).toBeDefined();
      });

      it('zod type is compatible with the canonicalized column type', () => {
        const colType = MIGRATION_MAP.get(fm.table)?.get(fm.column);
        if (!colType) return; // previous test will have failed
        const compat = COMPAT[fm.expectedZod];
        expect(
          compat.has(colType),
          `Drift: zod '${fm.expectedZod}' for ${fm.schemaVar}.${fm.field} is NOT compatible with column ${fm.table}.${fm.column} canonicalized as '${colType}'. Compatible set: [${[...compat].join(', ')}]`,
        ).toBe(true);
      });
    });
  }

  // ── Cross-cutting tripwires ────────────────────────────────────

  it('FIELD_MAPPINGS covers the waitlist + checkout schemas at minimum', () => {
    // These two have the most direct zod→column mapping; a future
    // refactor that removes ALL mappings for one of them (e.g. moves
    // to RPC) should force a deliberate update to this file.
    const covered = new Set(FIELD_MAPPINGS.map((m) => `${m.file}::${m.schemaVar}`));
    expect(covered.has('waitlist.ts::WaitlistSchema')).toBe(true);
    expect(covered.has('checkout.ts::Input')).toBe(true);
  });

  it('FIELD_MAPPINGS count is within documented band', () => {
    // Band forces deliberation: a huge jump probably means intake_data
    // jsonb fields crept in (not in scope for this round).
    expect(FIELD_MAPPINGS.length).toBeGreaterThanOrEqual(3);
    expect(FIELD_MAPPINGS.length).toBeLessThanOrEqual(15);
  });

  it('every mapped expectedZod is present in COMPAT (no unknown leakage)', () => {
    for (const fm of FIELD_MAPPINGS) {
      expect(
        COMPAT[fm.expectedZod],
        `${fm.schemaVar}.${fm.field}: expectedZod '${fm.expectedZod}' has no COMPAT entry`,
      ).toBeDefined();
      expect(COMPAT[fm.expectedZod].size, `COMPAT entry for '${fm.expectedZod}' is empty`).toBeGreaterThan(0);
    }
  });

  it('canonicalizeType stays in sync with known Postgres types used by mappings', () => {
    // Each canonicalized mapped column-type must be a KNOWN canonical
    // vocabulary entry, not an unrecognized raw lowercase fall-through.
    // If a new type lands (e.g. inet, tsvector), this fires — extend
    // the canonicalizeType() function AND COMPAT.
    const known = new Set([
      'uuid',
      'text',
      'citext',
      'int',
      'numeric',
      'boolean',
      'jsonb',
      'timestamptz',
      'date',
    ]);
    for (const fm of FIELD_MAPPINGS) {
      const colType = MIGRATION_MAP.get(fm.table)?.get(fm.column);
      if (!colType) continue;
      if (colType.startsWith('enum:')) continue;
      expect(
        known.has(colType),
        `Column ${fm.table}.${fm.column} canonicalized as '${colType}' — unrecognized. Extend canonicalizeType() + COMPAT.`,
      ).toBe(true);
    }
  });

  it('every mapped table exists in the migrations schema', () => {
    const tables = new Set(FIELD_MAPPINGS.map((m) => m.table));
    for (const t of tables) {
      expect(
        MIGRATION_MAP.has(t),
        `FIELD_MAPPINGS references table '${t}' which is not in any migration file.`,
      ).toBe(true);
    }
  });
});
