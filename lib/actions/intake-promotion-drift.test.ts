// R39(c) — Intake promotion drift audit.
//
// The two intake server actions (`lib/actions/intake.ts` — moving,
// `lib/actions/cleaning-intake.ts` — cleaning) take user-supplied
// intake form data, parse it through a zod schema defined in
// `lib/forms/*-intake.ts`, and then INSERT a `quote_requests` row.
// A SUBSET of parsed fields gets PROMOTED from inside the schema
// out to top-level columns on `quote_requests`:
//
//   Moving:   DestinationSchema.destination_city  → quote_requests.city
//             DestinationSchema.destination_state → quote_requests.state
//             DestinationSchema.destination_zip   → quote_requests.zip_code
//
//   Cleaning: LocationSchema.city  → quote_requests.city
//             LocationSchema.state → quote_requests.state
//             LocationSchema.zip   → quote_requests.zip_code
//
// The rest of the intake payload gets serialized into `intake_data`
// (jsonb), which is deliberately schemaless — zod validates inbound,
// but the DB just stores the bag. The promoted fields matter because
// downstream code (geo business-search, admin dashboard, email
// templates) reads them directly as columns, not via jsonb->>city.
//
// WHY THIS DRIFT MATTERS
// ──────────────────────
// Four failure modes this audit catches:
//
//   (1) The zod schema's field is renamed (e.g., `destination_zip`
//       → `destination_postal`). The action's `zip_code: data.
//       destination_zip` silently becomes `zip_code: undefined`.
//       Every new moving request gets a NULL zip_code; the
//       "businesses within radius" RPC returns zero rows; the user
//       sees an empty dashboard. No zod error fires because the zod
//       chain didn't reject anything — it just emitted a field the
//       action wasn't asking for.
//
//   (2) The column name in quote_requests is renamed (e.g., `zip_code`
//       → `postal_code`). R36's migrations-drift test catches the
//       column-name rename at the app-dependency layer, but that test
//       locks a static list. This audit additionally ties the
//       PROMOTION triplet (zod field → intermediate data.X → column)
//       together, so a rename in any leg fires.
//
//   (3) The zod field type changes (e.g., `UsStateSchema` → `z
//       .string().min(2)`). US_STATES enum was the only thing
//       preventing "New Yrok" style typos from landing in the column.
//       The audit locks that field's zod TYPE so the downgrade is
//       caught.
//
//   (4) The promotion statement is deleted. The column exists, the
//       zod field exists, but nobody is wiring them together. The
//       action lands the default (NULL/empty). Source-level grep
//       catches this.
//
// PATH LOCKED BY THIS AUDIT
// ─────────────────────────
// For each mapping below, the audit asserts:
//
//   (A) The zod source file exists and exports the named schema.
//   (B) The zod schema declares the expected field AT the expected
//       inferred type. For `UsStateSchema` (a z.enum), we classify
//       as 'enum' and require the enum values to be non-empty 2-char
//       strings.
//   (C) The action source file contains the exact promotion statement
//       `<column>: data.<field>` or a recognized variant.
//   (D) The column exists in quote_requests with a compatible
//       Postgres type (text/citext).
//   (E) A `service_category_id` lookup statement (`.eq('slug', ...)`)
//       is present in both actions — guards the promotion of the
//       category selection.
//
// Reuses the canonicalizeType vocabulary from `migrations-drift.test.ts`
// (third usage of the R36 shared vocabulary — columns, RPC arg types,
// zod-schema drift, and now intake promotion).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsPreservingPositions } from '../../tests/helpers/source-walker';

const ACTIONS_DIR = path.resolve(process.cwd(), 'lib/actions');
const FORMS_DIR = path.resolve(process.cwd(), 'lib/forms');
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── Canonical column-type vocabulary (R36 shared) ────────────────────
function canonicalizeType(raw: string): string {
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
  return lc;
}

// ── Zod inferred type (extended with 'enum' for UsStateSchema) ───────
type ZodInferred = 'string' | 'uuid' | 'number' | 'boolean' | 'enum' | 'unknown';

function classifyZodValue(src: string, allExports: Map<string, string>): ZodInferred {
  // First, try direct `z.<method>(` on this field's RHS.
  const firstCall = /\bz\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src);
  if (firstCall) {
    const method = firstCall[1];
    if (method === 'string') {
      if (/\.\s*uuid\s*\(/.test(src)) return 'uuid';
      return 'string';
    }
    if (method === 'uuid') return 'uuid';
    if (method === 'number') return 'number';
    if (method === 'boolean') return 'boolean';
    if (method === 'enum') return 'enum';
  }
  // Next, check if the RHS references an exported schema (UsStateSchema,
  // ZipSchema, etc.). Resolve to its underlying type.
  const refMatch = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(src);
  if (refMatch) {
    const refName = refMatch[1];
    const refSrc = allExports.get(refName);
    if (refSrc) {
      return classifyZodValue(refSrc, allExports);
    }
  }
  return 'unknown';
}

// ── Parse `const <name> = <rhs>;` across a forms source file to build
//    a name → RHS-text map. The RHS is the expression chain after `=`
//    up to the terminating `;` at depth 0.
function buildExportMap(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = stripCommentsPreservingPositions(src);
  const re = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const start = m.index + m[0].length;
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
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ';' && depth === 0) break;
    }
    out.set(m[1], stripped.slice(start, i));
  }
  return out;
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

// ── Extract the field map from a `z.object({ ... })` literal in an RHS ─
function extractObjectFields(rhs: string): Map<string, string> {
  // Find `z.object({` and walk to the matching `}`.
  const m = /z\s*\.\s*object\s*\(\s*\{/.exec(rhs);
  if (!m) return new Map();
  const start = m.index + m[0].length - 1; // at the `{`
  let depth = 0;
  let str: false | "'" | '"' | '`' = false;
  let i = start;
  for (; i < rhs.length; i++) {
    const ch = rhs[i];
    if (str) {
      if (ch === str && !isEscaped(rhs, i)) str = false;
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
  const body = rhs.slice(start + 1, i);
  // Walk the body, splitting on depth-0 commas.
  const fields = new Map<string, string>();
  let fieldStart = 0;
  depth = 0;
  str = false;
  for (let k = 0; k <= body.length; k++) {
    const ch = body[k];
    if (str) {
      if (ch === str && !isEscaped(body, k)) str = false;
      continue;
    }
    if (k < body.length) {
      if (ch === "'" || ch === '"' || ch === '`') {
        str = ch;
        continue;
      }
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
    }
    if (k === body.length || (ch === ',' && depth === 0)) {
      const entry = body.slice(fieldStart, k).trim();
      fieldStart = k + 1;
      if (!entry) continue;
      const colonIdx = entry.indexOf(':');
      if (colonIdx < 0) continue;
      const name = entry.slice(0, colonIdx).trim();
      const value = entry.slice(colonIdx + 1).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        fields.set(name, value);
      }
    }
  }
  return fields;
}

// ── Field mappings — the thing we lock ───────────────────────────────
interface PromotionMapping {
  vertical: 'moving' | 'cleaning';
  actionFile: string; // relative to lib/actions
  schemaFile: string; // relative to lib/forms
  subSchemaVar: string; // Origin/Destination/Location schema holding the field
  field: string; // zod field name (e.g., 'destination_zip' / 'zip')
  expectedZod: ZodInferred;
  column: string; // quote_requests column
  expectedColumnType: string; // canonicalized
  // The exact source-level promotion statement expected in the action.
  // Matched as a substring of the action source (stripped).
  promotionPattern: RegExp;
  reason: string;
}

const PROMOTIONS: PromotionMapping[] = [
  // ── Moving (intake.ts) ──
  {
    vertical: 'moving',
    actionFile: 'intake.ts',
    schemaFile: 'moving-intake.ts',
    subSchemaVar: 'DestinationSchema',
    field: 'destination_city',
    expectedZod: 'string',
    column: 'city',
    expectedColumnType: 'text',
    promotionPattern: /city\s*:\s*data\.destination_city/,
    reason:
      'Moving intake: destination city is where the user is moving TO — that is the geographic anchor for business-search, not the origin.',
  },
  {
    vertical: 'moving',
    actionFile: 'intake.ts',
    schemaFile: 'moving-intake.ts',
    subSchemaVar: 'DestinationSchema',
    field: 'destination_state',
    expectedZod: 'enum',
    column: 'state',
    expectedColumnType: 'text',
    promotionPattern: /state\s*:\s*data\.destination_state/,
    reason:
      'Moving intake: destination state is locked to the US_STATES enum (2-letter code). A downgrade to z.string().min(2) would allow typos.',
  },
  {
    vertical: 'moving',
    actionFile: 'intake.ts',
    schemaFile: 'moving-intake.ts',
    subSchemaVar: 'DestinationSchema',
    field: 'destination_zip',
    expectedZod: 'string',
    column: 'zip_code',
    expectedColumnType: 'text',
    promotionPattern: /zip_code\s*:\s*data\.destination_zip/,
    reason:
      'Moving intake: destination zip feeds the businesses-within-radius RPC. ZipSchema enforces 5-digit or ZIP+4 regex.',
  },
  // ── Cleaning (cleaning-intake.ts) ──
  {
    vertical: 'cleaning',
    actionFile: 'cleaning-intake.ts',
    schemaFile: 'cleaning-intake.ts',
    subSchemaVar: 'LocationSchema',
    field: 'city',
    expectedZod: 'string',
    column: 'city',
    expectedColumnType: 'text',
    promotionPattern: /city\s*:\s*data\.city/,
    reason:
      'Cleaning intake: service location city (single-location vertical, no origin/destination split).',
  },
  {
    vertical: 'cleaning',
    actionFile: 'cleaning-intake.ts',
    schemaFile: 'cleaning-intake.ts',
    subSchemaVar: 'LocationSchema',
    field: 'state',
    expectedZod: 'enum',
    column: 'state',
    expectedColumnType: 'text',
    promotionPattern: /state\s*:\s*data\.state/,
    reason:
      'Cleaning intake: US_STATES enum; same protection as moving.',
  },
  {
    vertical: 'cleaning',
    actionFile: 'cleaning-intake.ts',
    schemaFile: 'cleaning-intake.ts',
    subSchemaVar: 'LocationSchema',
    field: 'zip',
    expectedZod: 'string',
    column: 'zip_code',
    expectedColumnType: 'text',
    promotionPattern: /zip_code\s*:\s*data\.zip/,
    reason:
      'Cleaning intake: zip_code column name same as moving, but zod field is called `zip` (no origin/destination prefix).',
  },
];

// ── Build quote_requests column → canonical type map from migrations ─
function buildQuoteRequestsColumnTypes(): Map<string, string> {
  const out = new Map<string, string>();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = fs
      .readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
      .replace(/--[^\n]*/g, '');
    // create table public.quote_requests (...);
    const createRe =
      /create\s+table(?:\s+if\s+not\s+exists)?\s+public\.quote_requests\s*\(([\s\S]*?)\);/gi;
    let cm: RegExpExecArray | null;
    while ((cm = createRe.exec(sql)) !== null) {
      const body = cm[1];
      // Split on depth-0 commas.
      let depth = 0;
      let str: false | "'" = false;
      let start = 0;
      for (let i = 0; i <= body.length; i++) {
        const ch = body[i];
        if (str) {
          if (ch === "'" && body[i + 1] === "'") {
            i++;
            continue;
          }
          if (ch === "'") str = false;
          continue;
        }
        if (i < body.length) {
          if (ch === "'") {
            str = "'";
            continue;
          }
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
        if (i === body.length || (ch === ',' && depth === 0)) {
          const stmt = body.slice(start, i).trim();
          start = i + 1;
          if (!stmt) continue;
          if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(stmt)) continue;
          const colM = /^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*(?:\s*\([^)]+\))?)/.exec(stmt);
          if (colM) out.set(colM[1].toLowerCase(), canonicalizeType(colM[2]));
        }
      }
    }
    // alter table public.quote_requests add column X Y
    const alterRe =
      /alter\s+table\s+public\.quote_requests\s+add\s+column(?:\s+if\s+not\s+exists)?\s+([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*(?:\s*\([^)]+\))?)/gi;
    let am: RegExpExecArray | null;
    while ((am = alterRe.exec(sql)) !== null) {
      out.set(am[1].toLowerCase(), canonicalizeType(am[2]));
    }
  }
  return out;
}

// ── Pre-compute per-vertical state ───────────────────────────────────
interface VerticalAnalysis {
  actionFile: string;
  actionSrcStripped: string;
  schemaFile: string;
  exports: Map<string, string>;
  subSchemaFields: Map<string, Map<string, string>>; // subSchemaVar → field → value-src
}

// Always merge moving-intake.ts exports (ZipSchema, UsStateSchema,
// PhoneSchema, HomeSizeSchema) — cleaning-intake.ts imports them
// from moving-intake, so classify-by-reference needs the primitives
// resolvable regardless of which schema file we started from.
const SHARED_EXPORTS = buildExportMap(
  fs.readFileSync(path.join(FORMS_DIR, 'moving-intake.ts'), 'utf8'),
);

const verticals = new Map<string, VerticalAnalysis>();
for (const p of PROMOTIONS) {
  if (verticals.has(p.vertical)) continue;
  const actionSrc = fs.readFileSync(path.join(ACTIONS_DIR, p.actionFile), 'utf8');
  const actionSrcStripped = stripCommentsPreservingPositions(actionSrc);
  const schemaSrc = fs.readFileSync(path.join(FORMS_DIR, p.schemaFile), 'utf8');
  const localExports = buildExportMap(schemaSrc);
  // Merge: local exports win over shared (but the field primitives
  // we need — ZipSchema, UsStateSchema — are only in SHARED).
  const exportsMap = new Map<string, string>(SHARED_EXPORTS);
  for (const [k, v] of localExports) exportsMap.set(k, v);
  const subSchemaFields = new Map<string, Map<string, string>>();
  // Extract field maps for every schemaVar we reference in PROMOTIONS
  // for this vertical.
  const schemaVarsForVertical = new Set(
    PROMOTIONS.filter((x) => x.vertical === p.vertical).map((x) => x.subSchemaVar),
  );
  for (const v of schemaVarsForVertical) {
    const rhs = exportsMap.get(v);
    if (!rhs) continue;
    subSchemaFields.set(v, extractObjectFields(rhs));
  }
  verticals.set(p.vertical, {
    actionFile: p.actionFile,
    actionSrcStripped,
    schemaFile: p.schemaFile,
    exports: exportsMap,
    subSchemaFields,
  });
}

const QR_COLUMN_TYPES = buildQuoteRequestsColumnTypes();

// ── Tests ────────────────────────────────────────────────────────────
describe('intake promotion drift audit (R39c)', () => {
  for (const p of PROMOTIONS) {
    describe(`${p.vertical}: ${p.subSchemaVar}.${p.field} → quote_requests.${p.column}`, () => {
      const va = verticals.get(p.vertical)!;

      // (A) Sub-schema is exported in the forms module.
      it(`${p.schemaFile}: exports ${p.subSchemaVar}`, () => {
        expect(
          va.exports.has(p.subSchemaVar),
          `${p.schemaFile} is missing 'export const ${p.subSchemaVar} = z.object({...})'.`,
        ).toBe(true);
      });

      // (B) Field exists inside the schema's z.object literal.
      it(`${p.subSchemaVar} declares field '${p.field}'`, () => {
        const fields = va.subSchemaFields.get(p.subSchemaVar);
        expect(fields, `Field-map not extracted for ${p.subSchemaVar}`).toBeDefined();
        if (!fields) return;
        expect(
          fields.has(p.field),
          `${p.subSchemaVar} missing field '${p.field}'. Present: [${[...fields.keys()].join(', ')}]`,
        ).toBe(true);
      });

      // (C) Field has the expected zod inferred type.
      it(`${p.subSchemaVar}.${p.field}: zod inferred type is '${p.expectedZod}'`, () => {
        const fields = va.subSchemaFields.get(p.subSchemaVar);
        if (!fields) return;
        const rhs = fields.get(p.field);
        if (rhs === undefined) return;
        const got = classifyZodValue(rhs, va.exports);
        expect(
          got,
          `${p.subSchemaVar}.${p.field} RHS '${rhs.slice(0, 120)}' classified as '${got}', expected '${p.expectedZod}'.`,
        ).toBe(p.expectedZod);
      });

      // (D) Promotion statement is present in the action source.
      it(`${p.actionFile}: promotion statement present ('${p.column}: data.${p.field}')`, () => {
        const found = p.promotionPattern.test(va.actionSrcStripped);
        expect(
          found,
          `Promotion '${p.column}: data.${p.field}' not found in ${p.actionFile}. Drift in the action-level wiring.`,
        ).toBe(true);
      });

      // (E) Target column exists in quote_requests with the expected type.
      it(`quote_requests.${p.column}: exists with type '${p.expectedColumnType}'`, () => {
        const ty = QR_COLUMN_TYPES.get(p.column);
        expect(
          ty,
          `Column quote_requests.${p.column} not found in migrations.`,
        ).toBeDefined();
        expect(
          ty,
          `quote_requests.${p.column} type '${ty}' !== expected '${p.expectedColumnType}'.`,
        ).toBe(p.expectedColumnType);
      });
    });
  }

  // ── Cross-cutting: service_category_id wiring in both actions ──────
  describe('service_category_id wiring', () => {
    for (const vertical of ['moving', 'cleaning'] as const) {
      const va = verticals.get(vertical)!;
      it(`${va.actionFile}: looks up service_categories.slug → id before insert`, () => {
        // The action pattern is .from('service_categories').select('id...').eq('slug', …)
        const hasFromCategories = /\.from\s*\(\s*['"]service_categories['"]\s*\)/.test(
          va.actionSrcStripped,
        );
        const hasSlugEq = /\.eq\s*\(\s*['"]slug['"]\s*,/.test(va.actionSrcStripped);
        expect(
          hasFromCategories,
          `${va.actionFile} missing .from('service_categories') — category lookup broken.`,
        ).toBe(true);
        expect(
          hasSlugEq,
          `${va.actionFile} missing .eq('slug', …) — category lookup by slug broken.`,
        ).toBe(true);
      });

      it(`${va.actionFile}: inserts category_id into quote_requests`, () => {
        // Lock the promotion `category_id: <something>` into the
        // quote_requests insert payload. Note: the column is named
        // `category_id` (not `service_category_id`) on the
        // quote_requests table, even though it FK-references
        // service_categories.id. See migration 0001_initial_schema.sql.
        const hasPromote = /\bcategory_id\s*:\s*category\.id/.test(va.actionSrcStripped);
        expect(
          hasPromote,
          `${va.actionFile} missing 'category_id: category.id' in quote_requests insert.`,
        ).toBe(true);
      });
    }
  });

  // ── Count-band tripwire ─────────────────────────────────────────────
  it('exactly 6 intake promotions audited (3 moving + 3 cleaning)', () => {
    expect(PROMOTIONS.length).toBe(6);
    const moving = PROMOTIONS.filter((p) => p.vertical === 'moving').length;
    const cleaning = PROMOTIONS.filter((p) => p.vertical === 'cleaning').length;
    expect(moving).toBe(3);
    expect(cleaning).toBe(3);
  });

  // ── UsStateSchema identity ──────────────────────────────────────────
  it('UsStateSchema resolves to z.enum(US_STATES) — 2-letter state code lock', () => {
    const src = fs.readFileSync(path.join(FORMS_DIR, 'moving-intake.ts'), 'utf8');
    const stripped = stripCommentsPreservingPositions(src);
    expect(
      /export\s+const\s+UsStateSchema\s*=\s*z\.enum\s*\(\s*US_STATES\s*\)/.test(stripped),
      'UsStateSchema must be `z.enum(US_STATES)`. A downgrade to z.string() would allow typos like "NEw Yrok".',
    ).toBe(true);
  });

  // ── ZipSchema identity ──────────────────────────────────────────────
  it('ZipSchema enforces 5-digit or ZIP+4 regex — text column protection', () => {
    const src = fs.readFileSync(path.join(FORMS_DIR, 'moving-intake.ts'), 'utf8');
    const stripped = stripCommentsPreservingPositions(src);
    expect(
      /export\s+const\s+ZipSchema\s*=\s*z[\s\S]*?\.regex\s*\(/.test(stripped),
      'ZipSchema must chain `.regex(...)` over `z.string()`. No-regex downgrade would accept any string.',
    ).toBe(true);
  });
});
