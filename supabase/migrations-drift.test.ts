// R35 supabase/ migrations drift-check.
//
// The app/ and lib/ test suites lock the SHAPE of every webhook insert,
// every cron query, and every server-action DML — column names,
// idempotency-key columns, RPC parameter sets. Those tests run against
// MOCKED Supabase clients, so the assertions never actually hit the
// migration DDL. If a future migration drops a column or renames it,
// every app-level shape test still passes (the mock returns whatever
// you ask for) and the drift only surfaces at preview-deploy time
// when the real DB rejects the insert.
//
// This file closes that gap. It parses every supabase/migrations/*.sql
// file in lexical order, simulates the cumulative DDL state (initial
// table creates + later ALTER ADD COLUMN calls), and asserts that
// every column the app DEPENDS ON is present in the final schema.
//
// The DEPENDENCY SET is explicit and minimal — only the columns that
// app-level invariant tests actually lock. Adding a column to a
// migration without adding it here is fine; the drift-check only
// fires when a column the app needs goes missing. Conversely,
// REMOVING a column from the dependency set without removing the
// app-level reference is a code smell — the audit assumes the two
// move together.
//
// R36 extension: type drift.
//   • TYPE drift is now covered — `TYPE_SCHEMA` is built alongside
//     the name-only `SCHEMA` and compared against `TYPE_DEPENDENCIES`
//     below. The type extractor is conservative: it canonicalizes
//     `numeric(9,6)` → `numeric`, `integer`/`int4` → `int`, and maps
//     the four enum types (user_role/quote_request_status/
//     call_status/payment_status) to `enum:<name>`. Columns whose
//     type the app doesn't depend on can be omitted from
//     TYPE_DEPENDENCIES without triggering the audit — the check is
//     one-directional, dependency-set → migration.
//
// Still out of scope:
//   • RPC argument drift (`apply_call_end`, `increment_quotes_collected`
//     and friends). The per-route drift suites (R26/R30/R31/R32)
//     already lock RPC signatures at the app side; a migration-side
//     equivalent would require parsing CREATE FUNCTION bodies,
//     which is a much bigger lift. R36(d) addresses this in a
//     separate audit file.
//   • Constraint drift (CHECK, FOREIGN KEY). App tests catch
//     constraint violations indirectly via the 23505 swallow paths.
//
// If a column is added to the dependency set below but no migration
// provides it, the drift-check fires with a clear "missing column"
// error and the maintainer can either add the migration or update
// the app reference. Both are explicit; no silent pass.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

// ── Migration parser ─────────────────────────────────────────────────
// Builds a map of `<schema>.<table>` → Set<column>. We restrict to
// the `public` schema; the app never references auth.* directly.
type Schema = Map<string, Set<string>>;

function stripComments(sql: string): string {
  // Drop -- line comments and /* … */ block comments. Keep the
  // overall character count roughly stable so byte offsets in error
  // messages stay sensible.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, '');
}

function parseCreateTable(stmt: string, schema: Schema): void {
  // create table [if not exists] [public.]<name> ( …columns… );
  const head = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([A-Za-z_][\w]*)\s*\(/i.exec(
    stmt,
  );
  if (!head) return;
  const tableName = head[1];
  // Find the matching close-paren of the column list. Track depth so
  // nested parens (CHECK constraints) don't end the scan early.
  const startIdx = head.index + head[0].length;
  let depth = 1;
  let i = startIdx;
  for (; i < stmt.length && depth > 0; i++) {
    const ch = stmt[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  if (depth !== 0) return; // unbalanced — skip
  const body = stmt.slice(startIdx, i - 1);

  // Split on top-level commas only.
  const parts: string[] = [];
  let cur = '';
  let pdepth = 0;
  for (const ch of body) {
    if (ch === '(') pdepth++;
    else if (ch === ')') pdepth--;
    if (ch === ',' && pdepth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) parts.push(cur);

  const cols = new Set<string>();
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Skip table-level constraints: `constraint <name> ...`,
    // `primary key (...)`, `unique (...)`, `check (...)`,
    // `foreign key (...)`.
    if (/^(?:constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(trimmed)) {
      continue;
    }
    // The column name is the first identifier token. Quoted columns
    // are wrapped in double-quotes; we strip those.
    const colMatch = /^"?([A-Za-z_][\w]*)"?\s/.exec(trimmed);
    if (!colMatch) continue;
    cols.add(colMatch[1]);
  }
  const existing = schema.get(tableName) ?? new Set<string>();
  for (const c of cols) existing.add(c);
  schema.set(tableName, existing);
}

function parseAlterAddColumns(stmt: string, schema: Schema): void {
  // alter table [public.]<name> add column [if not exists] <col> <type>...;
  // Multiple columns can be added in one statement separated by commas
  // when each is prefixed with `add column ...`.
  const head = /alter\s+table\s+(?:public\.)?([A-Za-z_][\w]*)\s+([\s\S]+)/i.exec(stmt);
  if (!head) return;
  const tableName = head[1];
  const tail = head[2];
  const cols = new Set<string>();
  // Match every `add column [if not exists] <name>` in the tail.
  const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z_][\w]*)"?/gi;
  let m: RegExpExecArray | null;
  while ((m = addRe.exec(tail)) !== null) {
    cols.add(m[1]);
  }
  if (cols.size === 0) return;
  const existing = schema.get(tableName) ?? new Set<string>();
  for (const c of cols) existing.add(c);
  schema.set(tableName, existing);
}

function buildSchemaFromMigrations(): Schema {
  const schema: Schema = new Map();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexical = numerical for `00NN_*.sql`
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const sql = stripComments(raw);
    // Split on `;` at top level. Crude but works for our migration
    // style — none of our SQL uses dollar-quoted strings with embedded
    // semicolons that would cross statement boundaries (the trigger
    // function bodies use $$ … $$ but their semicolons stay inside).
    const stmts = splitTopLevelStatements(sql);
    for (const stmt of stmts) {
      const head = stmt.trim().slice(0, 80).toLowerCase();
      if (head.startsWith('create table')) parseCreateTable(stmt, schema);
      else if (head.startsWith('alter table')) parseAlterAddColumns(stmt, schema);
    }
  }
  return schema;
}

// Top-level statement splitter — respects `$$ … $$` dollar-quoting and
// `' … '` string literals. Conservative; falls through naturally on
// unbalanced quoting (which would also break the DB).
function splitTopLevelStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString = false;
  let inDollar = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (!inString && !inDollar && sql.slice(i, i + 2) === '$$') {
      inDollar = true;
      buf += '$$';
      i += 2;
      continue;
    }
    if (inDollar && sql.slice(i, i + 2) === '$$') {
      inDollar = false;
      buf += '$$';
      i += 2;
      continue;
    }
    if (!inDollar && ch === "'") {
      inString = !inString;
      buf += ch;
      i++;
      continue;
    }
    if (!inString && !inDollar && ch === ';') {
      if (buf.trim().length > 0) out.push(buf);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

// ── R36 type extractor ───────────────────────────────────────────────
// For every column captured above, we additionally canonicalize the
// type token that follows the column name and record it in a sibling
// `TYPE_SCHEMA: Map<table, Map<column, type>>`. The existing
// `SCHEMA` (name-only) stays untouched — the R35 tests keep running
// against it unmodified; only the R36 additions consult TYPE_SCHEMA.
type TypeSchema = Map<string, Map<string, string>>;

// Canonicalize a raw SQL type token like `numeric(9,6)`, `integer`,
// `int4`, or `timestamptz` into one of a fixed vocabulary the app
// dependency set can compare against. Unknown tokens are returned
// as-is so they fail-loudly in the type-dependency assertion
// (easier to diagnose than a silent empty-string).
function canonicalizeType(raw: string): string {
  const t = raw.trim().toLowerCase();
  // Strip parameterization: numeric(9,6) → numeric, varchar(255) → varchar.
  const noParen = t.replace(/\(.*?\)/g, '').trim();
  // Integer family.
  if (noParen === 'integer' || noParen === 'int' || noParen === 'int4') return 'int';
  if (noParen === 'bigint' || noParen === 'int8') return 'bigint';
  if (noParen === 'smallint' || noParen === 'int2') return 'smallint';
  // Timestamp family — SQL 'timestamp with time zone' is normalized
  // to timestamptz by Postgres; migrations here use `timestamptz`
  // directly, but canonicalize the spelling just in case.
  if (noParen === 'timestamptz' || noParen === 'timestamp with time zone') return 'timestamptz';
  if (noParen === 'timestamp' || noParen === 'timestamp without time zone') return 'timestamp';
  // Numeric family.
  if (noParen === 'numeric' || noParen === 'decimal') return 'numeric';
  // Text family.
  if (noParen === 'text' || noParen === 'varchar' || noParen === 'character varying') return 'text';
  // citext is a separate extension type; the app depends on
  // case-insensitive comparisons in a few places, so we keep it
  // distinct from plain text.
  if (noParen === 'citext') return 'citext';
  // Booleans.
  if (noParen === 'boolean' || noParen === 'bool') return 'boolean';
  // JSON family.
  if (noParen === 'jsonb') return 'jsonb';
  if (noParen === 'json') return 'json';
  // UUID.
  if (noParen === 'uuid') return 'uuid';
  // Enum types (our four defined in 0001). Any identifier that
  // matches a known enum keeps its enum:<name> canonical form so
  // the audit can lock that a `status` column keeps the right
  // enum rather than drifting to text.
  const enumNames = new Set([
    'user_role',
    'quote_request_status',
    'call_status',
    'payment_status',
  ]);
  if (enumNames.has(noParen)) return `enum:${noParen}`;
  // Fallback: return the unknown token so a drift to an unfamiliar
  // type lands as a visible mismatch rather than a silent pass.
  return noParen;
}

function parseCreateTableTypes(stmt: string, typeSchema: TypeSchema): void {
  const head = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([A-Za-z_][\w]*)\s*\(/i.exec(
    stmt,
  );
  if (!head) return;
  const tableName = head[1];
  const startIdx = head.index + head[0].length;
  let depth = 1;
  let i = startIdx;
  for (; i < stmt.length && depth > 0; i++) {
    const ch = stmt[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  if (depth !== 0) return;
  const body = stmt.slice(startIdx, i - 1);

  // String-literal + paren-depth aware comma split. Fixes the
  // R36 finding where a multi-line `default '…, …'` literal
  // contains a comma that the naive splitter treated as a column
  // separator (producing ghost columns like
  // `service_categories.this = 'is'`).
  const parts: string[] = [];
  let cur = '';
  let pdepth = 0;
  let inString = false;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (ch === "'") {
      // Postgres doubles single quotes to escape (`''`); treat a
      // doubled quote as still-in-string and keep walking.
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

  const tableMap = typeSchema.get(tableName) ?? new Map<string, string>();
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (/^(?:constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(trimmed)) continue;
    // Match: column_name <TYPE_TOKEN>(optional params) ...
    const m = /^"?([A-Za-z_][\w]*)"?\s+([A-Za-z_][\w]*(?:\s*\([^)]*\))?)/.exec(trimmed);
    if (!m) continue;
    const colName = m[1];
    const rawType = m[2];
    tableMap.set(colName, canonicalizeType(rawType));
  }
  typeSchema.set(tableName, tableMap);
}

function parseAlterAddColumnTypes(stmt: string, typeSchema: TypeSchema): void {
  const head = /alter\s+table\s+(?:public\.)?([A-Za-z_][\w]*)\s+([\s\S]+)/i.exec(stmt);
  if (!head) return;
  const tableName = head[1];
  const tail = head[2];
  // Match `add column [if not exists] <name> <TYPE>`.
  const addRe = /add\s+column\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z_][\w]*)"?\s+([A-Za-z_][\w]*(?:\s*\([^)]*\))?)/gi;
  const tableMap = typeSchema.get(tableName) ?? new Map<string, string>();
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = addRe.exec(tail)) !== null) {
    tableMap.set(m[1], canonicalizeType(m[2]));
    any = true;
  }
  if (any) typeSchema.set(tableName, tableMap);
}

function buildTypeSchemaFromMigrations(): TypeSchema {
  const typeSchema: TypeSchema = new Map();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const sql = stripComments(raw);
    const stmts = splitTopLevelStatements(sql);
    for (const stmt of stmts) {
      const head = stmt.trim().slice(0, 80).toLowerCase();
      if (head.startsWith('create table')) parseCreateTableTypes(stmt, typeSchema);
      else if (head.startsWith('alter table')) parseAlterAddColumnTypes(stmt, typeSchema);
    }
  }
  return typeSchema;
}

// Pre-compute once per suite.
const SCHEMA = buildSchemaFromMigrations();
const TYPE_SCHEMA = buildTypeSchemaFromMigrations();

// ── App-level dependency set ─────────────────────────────────────────
// Only columns referenced by app-level invariant locks. Adding a
// column to a migration WITHOUT adding it here is fine — the drift-
// check is one-directional, app→migrations.
//
// Each entry below names the app reference that depends on it. If
// you remove a column from the app side, prune the matching entry
// here. If you add a NEW column to the app side, add the matching
// entry here at the same time.
const APP_DEPENDENCIES: Record<string, Record<string, string>> = {
  payments: {
    // 8-column insert in app/api/stripe/webhook/route.ts (R27 lock).
    user_id: 'stripe webhook insert + payments_user_idx',
    quote_request_id: 'stripe webhook insert',
    stripe_session_id: 'stripe webhook insert + unique idempotency key',
    stripe_payment_intent_id: 'stripe webhook insert + lib/cron/send-reports refund lookup',
    stripe_event_id: 'stripe webhook insert (R27 idempotency lock, added in 0003)',
    amount: 'stripe webhook insert',
    currency: 'stripe webhook insert',
    status: 'stripe webhook insert + payment_status enum',
    claimed_at: 'lib/actions/post-payment magic-link claim (added in 0003)',
  },
  calls: {
    // 10-column insert in app/api/twilio/sms/route.ts (R32 lock).
    // 8-column update in app/api/vapi/webhook/route.ts (R31 lock).
    quote_request_id: 'twilio sms + vapi webhook + calls_request_idx',
    business_id: 'twilio sms + vapi webhook + calls_business_idx',
    vapi_call_id: 'twilio sms synthetic-id lookup + vapi webhook lookup (R31)',
    status: 'twilio sms + vapi webhook + calls_status_idx + call_status enum',
    started_at: 'twilio sms insert',
    ended_at: 'vapi webhook update (R31 lock)',
    duration_seconds: 'twilio sms + vapi webhook update (R31)',
    transcript: 'twilio sms + vapi webhook update (R31) + lib/calls/extract-quote',
    summary: 'twilio sms + vapi webhook update (R31)',
    cost: 'twilio sms + vapi webhook update (R31)',
    extracted_data: 'vapi webhook update (R31)',
    recording_url: 'vapi webhook update (R31)',
    retry_count: 'lib/cron/retry-failed-calls candidate query',
    last_retry_at: 'lib/cron/retry-failed-calls candidate query (added in 0006)',
    counters_applied_at: 'apply-end-of-call idempotency sentinel (R31, added in 0008)',
  },
  quotes: {
    // 15-column insert in app/api/vapi/webhook/route.ts (R26 lock) and
    // app/api/twilio/sms/route.ts (similar).
    call_id: 'vapi webhook + twilio sms quotes insert + unique backstop (R31)',
    quote_request_id: 'vapi webhook + twilio sms quotes insert + quotes_request_idx',
    business_id: 'vapi webhook + twilio sms quotes insert',
    price_min: 'vapi webhook + twilio sms quotes insert',
    price_max: 'vapi webhook + twilio sms quotes insert',
    price_description: 'vapi webhook + twilio sms quotes insert',
    availability: 'vapi webhook + twilio sms quotes insert',
    includes: 'vapi webhook + twilio sms quotes insert',
    excludes: 'vapi webhook + twilio sms quotes insert',
    notes: 'vapi webhook + twilio sms quotes insert',
    contact_name: 'vapi webhook + twilio sms quotes insert',
    contact_phone: 'vapi webhook + twilio sms quotes insert',
    contact_email: 'vapi webhook + twilio sms quotes insert',
    requires_onsite_estimate: 'vapi webhook + twilio sms quotes insert',
    confidence_score: 'vapi webhook + twilio sms quotes insert',
    contact_released_at: 'phase 8 contact release (added in 0007)',
  },
  quote_requests: {
    // Column set referenced across server actions, success page, and
    // the admin/get-quotes claim route. Not a single-place lock; this
    // is the union of every app reference.
    user_id: 'lib/actions/intake + checkout + various (nullable per 0002)',
    category_id: 'lib/actions/intake + sitemap.ts',
    status: 'lib/actions/intake + cron/send-reports + status enum',
    intake_data: 'lib/actions/intake + claim route (R29 magic-link contact override)',
    city: 'lib/actions/intake (primary location)',
    state: 'lib/actions/intake (primary location)',
    zip_code: 'lib/actions/intake (primary location)',
    stripe_payment_id: 'lib/actions/checkout + post-payment',
    total_businesses_to_call: 'engine.ts plannedCountUpdateFailed (R25)',
    total_calls_made: 'apply-end-of-call counter recompute',
    total_calls_completed: 'apply-end-of-call counter recompute',
    total_quotes_collected: 'increment_quotes_collected RPC + counters',
    report_generated_at: 'cron/send-reports finalStampFailed (R27)',
    report_data: 'cron/send-reports payload persistence',
    report_sent_at: 'cron/send-reports finalStampFailed (R27)',
    vapi_batch_started_at: 'engine.ts batch claim (added in 0004)',
    archived_at: 'lib/actions/admin setRequestArchived (R32, added in 0010)',
  },
  service_categories: {
    // sitemap.ts + intake server actions.
    slug: 'lib/actions/intake category lookup + sitemap.ts',
    is_active: 'lib/actions/intake category filter + sitemap.ts',
    extraction_schema: 'multi-vertical extraction (added in 0005)',
    places_query_template: 'multi-vertical ingest (added in 0005)',
  },
  businesses: {
    source: 'business ingest (added in 0004)',
    ingested_at: 'business ingest (added in 0004)',
  },
};

// ── R36 TYPE dependency set ──────────────────────────────────────────
// Types the app relies on for specific columns. Minimal and
// surgical — only columns whose TYPE drift would produce a silent
// failure (value-passthrough, hash-mismatch, enum-coercion, etc.).
//
// The canonical type vocabulary lives in `canonicalizeType()`
// above. Entries use canonical values only — `'int'` not
// `'integer'`, `'text'` not `'varchar'`, `'enum:call_status'` not
// `'call_status'`. A mismatch surfaces at the type-drift test.
const TYPE_DEPENDENCIES: Record<string, Record<string, string>> = {
  payments: {
    // Stripe IDs: always text (session ids, payment-intent ids,
    // event ids all come off the Stripe API as strings).
    stripe_session_id: 'text',
    stripe_payment_intent_id: 'text',
    stripe_event_id: 'text',
    // FKs: uuid.
    user_id: 'uuid',
    quote_request_id: 'uuid',
    // Status uses the payment_status enum for CHECK-compatible
    // narrowing. Drift to text would allow 'paid' / 'Paid' /
    // arbitrary ad-hoc values at the DB layer — the whole reason
    // we have the enum.
    status: 'enum:payment_status',
    // Amounts in cents, stored as int.
    amount: 'int',
    // Currency code: text (three-letter ISO).
    currency: 'text',
    // Magic-link claim timestamp.
    claimed_at: 'timestamptz',
  },
  calls: {
    // FKs: uuid.
    quote_request_id: 'uuid',
    business_id: 'uuid',
    // Vapi call id is text — Vapi returns strings, plus app-level
    // synthetic prefixes `sms_` (twilio/sms) and `inbound_`
    // (inbound-callback) are assembled as strings.
    vapi_call_id: 'text',
    // Status uses call_status enum; see payments.status rationale.
    status: 'enum:call_status',
    // Timestamps.
    started_at: 'timestamptz',
    ended_at: 'timestamptz',
    last_retry_at: 'timestamptz',
    counters_applied_at: 'timestamptz',
    // Integers.
    duration_seconds: 'int',
    retry_count: 'int',
    // Transcript/summary are text (free-form strings from Vapi +
    // Anthropic extraction).
    transcript: 'text',
    summary: 'text',
    // Monetary cost: numeric (Vapi returns a decimal cost).
    cost: 'numeric',
    // Extracted_data is the structured Anthropic result — jsonb
    // so it can be queried with -> / ->> operators downstream.
    extracted_data: 'jsonb',
    // URL: text.
    recording_url: 'text',
  },
  quotes: {
    // FKs: uuid.
    call_id: 'uuid',
    quote_request_id: 'uuid',
    business_id: 'uuid',
    // Price fields come back as decimals; we store as numeric.
    price_min: 'numeric',
    price_max: 'numeric',
    // Text fields (extracted natural language).
    price_description: 'text',
    availability: 'text',
    includes: 'text',
    excludes: 'text',
    notes: 'text',
    // PII fields. `contact_email` is citext in the migration
    // (case-insensitive comparison for dedupe); the others are
    // plain text.
    contact_name: 'text',
    contact_phone: 'text',
    contact_email: 'citext',
    // Boolean flag.
    requires_onsite_estimate: 'boolean',
    // Numeric confidence in [0,1].
    confidence_score: 'numeric',
    // Phase-8 contact release.
    contact_released_at: 'timestamptz',
  },
  quote_requests: {
    user_id: 'uuid',
    category_id: 'uuid',
    status: 'enum:quote_request_status',
    intake_data: 'jsonb',
    city: 'text',
    state: 'text',
    zip_code: 'text',
    stripe_payment_id: 'text',
    total_businesses_to_call: 'int',
    total_calls_made: 'int',
    total_calls_completed: 'int',
    total_quotes_collected: 'int',
    report_generated_at: 'timestamptz',
    report_data: 'jsonb',
    report_sent_at: 'timestamptz',
    vapi_batch_started_at: 'timestamptz',
    archived_at: 'timestamptz',
  },
  service_categories: {
    slug: 'text',
    is_active: 'boolean',
    extraction_schema: 'jsonb',
    places_query_template: 'text',
  },
  businesses: {
    source: 'text',
    ingested_at: 'timestamptz',
  },
  profiles: {
    // PII types locked for the PII-type-guard test.
    email: 'text',
    full_name: 'text',
    phone: 'text',
  },
};

describe('supabase/migrations drift-check (R35)', () => {
  it('parses at least 7 tables out of supabase/migrations/', () => {
    // Sanity check on the parser — current count is ~10 tables in
    // the public schema across all migrations.
    expect(SCHEMA.size).toBeGreaterThanOrEqual(7);
  });

  it('every app-required column on `payments` is present in migrations', () => {
    expectColumns('payments');
  });

  it('every app-required column on `calls` is present in migrations', () => {
    expectColumns('calls');
  });

  it('every app-required column on `quotes` is present in migrations', () => {
    expectColumns('quotes');
  });

  it('every app-required column on `quote_requests` is present in migrations', () => {
    expectColumns('quote_requests');
  });

  it('every app-required column on `service_categories` is present in migrations', () => {
    expectColumns('service_categories');
  });

  it('every app-required column on `businesses` is present in migrations', () => {
    expectColumns('businesses');
  });

  it('idempotency-key columns are present (R27/R31/R32 retry-storm locks)', () => {
    // Four external-webhook surfaces lock specific columns as the
    // idempotency anchor. If any of these vanishes, retry storms
    // would create duplicate rows in production.
    const idempotencyAnchors: Array<[string, string, string]> = [
      ['payments', 'stripe_event_id', 'stripe webhook (R27)'],
      ['calls', 'vapi_call_id', 'vapi webhook + twilio sms + inbound-callback (R31)'],
      ['quotes', 'call_id', 'unique backstop on quotes insert (R31)'],
      ['calls', 'counters_applied_at', 'apply-end-of-call sentinel (R31)'],
    ];
    const violations: string[] = [];
    for (const [table, col, ref] of idempotencyAnchors) {
      const present = SCHEMA.get(table)?.has(col);
      if (!present) {
        violations.push(`${table}.${col} (${ref}) — MISSING from migrations`);
      }
    }
    expect(
      violations,
      `idempotency anchor columns missing: ${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('PII-bearing tables (quotes, profiles) declare their PII columns (regression guard against accidental drop)', () => {
    // We rely on these columns existing for the PII-redaction tests
    // to actually have something to redact. If a migration dropped
    // `contact_email` from quotes, the PII tests would silently keep
    // passing because the column would never be in any query result.
    const piiColumns: Array<[string, string]> = [
      ['quotes', 'contact_name'],
      ['quotes', 'contact_phone'],
      ['quotes', 'contact_email'],
      ['profiles', 'email'],
      ['profiles', 'phone'],
      ['profiles', 'full_name'],
    ];
    const violations: string[] = [];
    for (const [table, col] of piiColumns) {
      if (!SCHEMA.get(table)?.has(col)) {
        violations.push(`${table}.${col} — MISSING (PII column drift)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('parser sanity: no critical table dropped to zero columns', () => {
    // If the parser misses a table entirely (typo in the create-
    // table regex, an unusual whitespace pattern), every column
    // assertion would false-fail with the same root cause. Surface
    // it as a single error with a clearer message instead.
    const required = [
      'profiles',
      'service_categories',
      'businesses',
      'quote_requests',
      'calls',
      'quotes',
      'payments',
    ];
    const missing = required.filter((t) => !SCHEMA.has(t) || SCHEMA.get(t)!.size === 0);
    expect(missing, `parser failed to populate tables: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  // ── R36 type-drift tests ──────────────────────────────────────────
  it('R36 TYPE drift: every TYPE_DEPENDENCIES entry matches the migration type', () => {
    // Core R36 invariant. For every (table, column) pair in
    // TYPE_DEPENDENCIES below, assert the canonicalized type from
    // the migration DDL matches the expected type the app depends
    // on. Catches drift like `payment_intent_id: text → uuid` or
    // `counters_applied_at: timestamptz → timestamp` that the R35
    // name-only check silently allows.
    const mismatches: string[] = [];
    for (const [table, cols] of Object.entries(TYPE_DEPENDENCIES)) {
      const tableTypes = TYPE_SCHEMA.get(table);
      if (!tableTypes) {
        mismatches.push(`${table}: table missing from TYPE_SCHEMA entirely`);
        continue;
      }
      for (const [col, expected] of Object.entries(cols)) {
        const actual = tableTypes.get(col);
        if (actual === undefined) {
          mismatches.push(
            `${table}.${col}: expected type '${expected}' but column missing from TYPE_SCHEMA`,
          );
          continue;
        }
        if (actual !== expected) {
          mismatches.push(
            `${table}.${col}: expected type '${expected}' but migration declares '${actual}'`,
          );
        }
      }
    }
    expect(
      mismatches,
      `migration type drift detected:\n  ${mismatches.join('\n  ')}`,
    ).toEqual([]);
  });

  it('R36 TYPE drift: idempotency anchor columns have the expected types', () => {
    // Sibling to the R35 idempotency-anchor name check. Types of
    // these four columns are load-bearing: `stripe_event_id` MUST
    // be text (Stripe returns event.id as a string), `vapi_call_id`
    // MUST be text (Vapi + synthetic `sms_` + `inbound_` prefixes),
    // `call_id` MUST be uuid (FK to calls.id), `counters_applied_at`
    // MUST be timestamptz (apply-end-of-call sentinel writes
    // now()).
    const anchors: Array<[string, string, string]> = [
      ['payments', 'stripe_event_id', 'text'],
      ['calls', 'vapi_call_id', 'text'],
      ['quotes', 'call_id', 'uuid'],
      ['calls', 'counters_applied_at', 'timestamptz'],
    ];
    const violations: string[] = [];
    for (const [table, col, expected] of anchors) {
      const actual = TYPE_SCHEMA.get(table)?.get(col);
      if (actual !== expected) {
        violations.push(
          `${table}.${col}: expected '${expected}', got '${actual ?? 'MISSING'}'`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('R36 TYPE drift: PII columns are text/citext (regression guard against accidental type widening)', () => {
    // The PII redactor (lib/text/pii.ts) assumes string inputs.
    // If a migration ever changed `contact_email` from text to
    // jsonb (say, to support multiple addresses), the redactor
    // would silently pass the raw object through.
    const piiTypes: Array<[string, string, string]> = [
      ['quotes', 'contact_name', 'text'],
      ['quotes', 'contact_phone', 'text'],
      ['quotes', 'contact_email', 'text'],
      ['profiles', 'email', 'text'],
      ['profiles', 'phone', 'text'],
      ['profiles', 'full_name', 'text'],
    ];
    const violations: string[] = [];
    for (const [table, col, expected] of piiTypes) {
      const actual = TYPE_SCHEMA.get(table)?.get(col);
      if (actual !== expected && actual !== 'citext') {
        violations.push(
          `${table}.${col}: expected '${expected}' or citext, got '${actual ?? 'MISSING'}'`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('R36 TYPE extractor: parses every table the name-only parser finds (parity check)', () => {
    // Sanity: the R36 type-aware parser must cover the same tables
    // the R35 name-only parser covers. If the regex is tighter and
    // silently drops a table, the entire type audit would silently
    // no-op for it.
    const nameOnlyTables = new Set(SCHEMA.keys());
    const typeAwareTables = new Set(TYPE_SCHEMA.keys());
    const dropped: string[] = [];
    for (const t of nameOnlyTables) {
      if (!typeAwareTables.has(t)) dropped.push(t);
    }
    expect(
      dropped,
      `R36 type-aware parser missed tables the R35 name-only parser found: ${dropped.join(', ')}`,
    ).toEqual([]);
  });

  it('R36 TYPE canonicalization: no column falls through to an unrecognized type string', () => {
    // After canonicalization, every type in TYPE_SCHEMA should be
    // one of the known canonical values. If a future migration
    // introduces, say, `inet` or `tsvector`, the canonicalizer
    // falls back to the raw lowercased token — which will appear
    // here as a "new canonical form" and prompts a memo update.
    const knownCanonicals = new Set([
      'uuid',
      'text',
      'citext',
      'boolean',
      'jsonb',
      'json',
      'timestamptz',
      'timestamp',
      'numeric',
      'int',
      'bigint',
      'smallint',
      'enum:user_role',
      'enum:quote_request_status',
      'enum:call_status',
      'enum:payment_status',
    ]);
    const unknowns: string[] = [];
    for (const [table, cols] of TYPE_SCHEMA.entries()) {
      for (const [col, type] of cols.entries()) {
        if (!knownCanonicals.has(type)) {
          unknowns.push(`${table}.${col} → '${type}'`);
        }
      }
    }
    expect(
      unknowns,
      `unrecognized canonical types found — extend canonicalizeType() or knownCanonicals:\n  ${unknowns.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no app-required column appears in the dependency set without a migration source (round-trip lock)', () => {
    // For every entry in APP_DEPENDENCIES, the column must exist in
    // the parsed schema. Any new app reference that hasn't been
    // wired to a migration fires here. This is the core invariant —
    // the round-trip guarantees the dependency set never silently
    // drifts past what the DB can serve.
    const missing: string[] = [];
    for (const [table, cols] of Object.entries(APP_DEPENDENCIES)) {
      const present = SCHEMA.get(table) ?? new Set<string>();
      for (const [col, ref] of Object.entries(cols)) {
        if (!present.has(col)) {
          missing.push(`${table}.${col} (used by: ${ref})`);
        }
      }
    }
    expect(
      missing,
      `app references columns not provided by any migration:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});

function expectColumns(table: string): void {
  const expected = APP_DEPENDENCIES[table];
  if (!expected) {
    throw new Error(`expectColumns: no dependency set declared for ${table}`);
  }
  const present = SCHEMA.get(table) ?? new Set<string>();
  const missing: string[] = [];
  for (const [col, ref] of Object.entries(expected)) {
    if (!present.has(col)) missing.push(`${col} (${ref})`);
  }
  expect(
    missing,
    `migrations missing columns required by app code on ${table}:\n  ${missing.join('\n  ')}`,
  ).toEqual([]);
}
