// R45(c) — Supabase migration idempotency drift audit.
//
// Every DDL statement in an INCREMENTAL migration should be safe to
// re-run. Supabase applies migrations once in order, but this audit
// covers the realistic failure modes:
//
//   (a) A fresh preview DB applies 0001…N in sequence. If 0003 ships
//       `alter table X add column Y` and a hotfix backport to staging
//       re-runs 0003, the lack of `if not exists` crashes the retry.
//   (b) Disaster-recovery restores from a logical dump and re-runs
//       all migrations over the restored baseline. Naked CREATE TABLE
//       statements fail.
//   (c) A developer locally applies the latest N migrations on top of
//       a partial DB. Naked CREATE INDEX fails.
//
// Scope:
//
//   FOUNDATIONAL (0001_initial_schema.sql) — tolerated as naked
//   CREATEs. This is the base migration; re-running it is not a
//   supported workflow.
//
//   INCREMENTAL (0002+) — every DDL statement must be idempotent:
//
//     create table            → must use `if not exists`
//     create index            → must use `if not exists`
//     create unique index     → must use `if not exists`
//     alter table add column  → must use `if not exists`
//     create extension        → must use `if not exists`
//     create schema           → must use `if not exists`
//     create function         → must use `create or replace`
//     create trigger          → must be preceded (same file) by
//                               `drop trigger if exists` on the same
//                               trigger name+table OR use
//                               `create or replace trigger`.
//     create policy           → must be preceded (same file) by
//                               `drop policy if exists` on the same
//                               policy name+table. (Postgres pre-15
//                               has no `create policy if not exists`.)
//
//   Destructive DDL:
//     drop table / drop column / drop function / drop trigger /
//     drop index / drop policy  — must have `if exists`.
//
// Out of scope:
//   • CHECK constraints added via `alter table add constraint`.
//     Postgres doesn't support `add constraint if not exists` — a
//     hand-written DO $$ block is required. We have none today.
//   • The RUN_IN_PROD_SQL_EDITOR.sql convenience file. That's a
//     paste-into-SQL-editor helper, not a versioned migration.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const FOUNDATIONAL_FILE = '0001_initial_schema.sql';

// ── Splitter + stripper (shared pattern) ─────────────────────────────

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

// ── Per-file idempotency classification ──────────────────────────────

interface FileFindings {
  file: string;
  nakedCreateTable: string[]; // table name
  nakedCreateIndex: string[]; // index name
  nakedCreateExtension: string[]; // extension name
  nakedCreateSchema: string[]; // schema name
  nakedAddColumn: string[]; // "table.column"
  nakedCreateFunction: string[]; // function name (qualified if given)
  // create trigger without preceding `drop trigger if exists` or `create or replace trigger`
  nakedCreateTrigger: string[];
  // create policy without preceding `drop policy if exists` or `if not exists`
  nakedCreatePolicy: string[];
  nakedDropTable: string[];
  nakedDropColumn: string[];
  nakedDropFunction: string[];
  nakedDropTrigger: string[];
  nakedDropIndex: string[];
  nakedDropPolicy: string[];
}

function analyzeFile(fileName: string, sql: string): FileFindings {
  const findings: FileFindings = {
    file: fileName,
    nakedCreateTable: [],
    nakedCreateIndex: [],
    nakedCreateExtension: [],
    nakedCreateSchema: [],
    nakedAddColumn: [],
    nakedCreateFunction: [],
    nakedCreateTrigger: [],
    nakedCreatePolicy: [],
    nakedDropTable: [],
    nakedDropColumn: [],
    nakedDropFunction: [],
    nakedDropTrigger: [],
    nakedDropIndex: [],
    nakedDropPolicy: [],
  };

  const stmts = splitSqlStatements(sql).map(stripSqlComments).map((s) => s.trim());

  // Build a prefix-set of drop-if-exists trigger/policy pairs seen
  // earlier in THIS file so the per-trigger / per-policy check can ask
  // "was this name dropped-if-exists before create?".
  const droppedTriggersBefore: Set<string> = new Set(); // key: "triggerName|tableName"
  const droppedPoliciesBefore: Set<string> = new Set(); // key: "policyName|tableName"

  for (const s of stmts) {
    if (s.length === 0) continue;

    // create table
    {
      const m = /^create\s+table\s+(if\s+not\s+exists\s+)?(?:public\.)?([A-Za-z_][\w]*)/i.exec(s);
      if (m) {
        if (!m[1]) findings.nakedCreateTable.push(m[2]);
        continue;
      }
    }

    // create unique|index
    {
      const m = /^create\s+(?:unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?([A-Za-z_][\w]*)/i.exec(
        s,
      );
      if (m) {
        if (!m[2]) findings.nakedCreateIndex.push(m[3]);
        continue;
      }
    }

    // create extension
    {
      const m = /^create\s+extension\s+(if\s+not\s+exists\s+)?("[^"]+"|[A-Za-z_][\w]*)/i.exec(s);
      if (m) {
        if (!m[1]) findings.nakedCreateExtension.push(m[2]);
        continue;
      }
    }

    // create schema
    {
      const m = /^create\s+schema\s+(if\s+not\s+exists\s+)?([A-Za-z_][\w]*)/i.exec(s);
      if (m) {
        if (!m[1]) findings.nakedCreateSchema.push(m[2]);
        continue;
      }
    }

    // alter table X add column Y [...]
    //
    // One `alter table` statement can carry multiple add-column
    // clauses. We split on `add column` to inspect each one.
    {
      const alter = /^alter\s+table\s+(?:only\s+)?(?:public\.)?([A-Za-z_][\w]*)\s+([\s\S]*)$/i.exec(
        s,
      );
      if (alter) {
        const tableName = alter[1];
        const body = alter[2];
        // alter body may be comma-separated clauses; match add column clauses
        const addMatches = body.match(/add\s+column\s+(if\s+not\s+exists\s+)?([A-Za-z_][\w]*)/gi);
        if (addMatches) {
          for (const m of addMatches) {
            const sub = /add\s+column\s+(if\s+not\s+exists\s+)?([A-Za-z_][\w]*)/i.exec(m)!;
            if (!sub[1]) findings.nakedAddColumn.push(`${tableName}.${sub[2]}`);
          }
        }
        // alter table X drop column Y — require "if exists"
        const dropMatches = body.match(/drop\s+column\s+(if\s+exists\s+)?([A-Za-z_][\w]*)/gi);
        if (dropMatches) {
          for (const m of dropMatches) {
            const sub = /drop\s+column\s+(if\s+exists\s+)?([A-Za-z_][\w]*)/i.exec(m)!;
            if (!sub[1]) findings.nakedDropColumn.push(`${tableName}.${sub[2]}`);
          }
        }
        continue;
      }
    }

    // create [or replace] function
    {
      const m =
        /^create\s+(or\s+replace\s+)?function\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)/i.exec(
          s,
        );
      if (m) {
        if (!m[1]) findings.nakedCreateFunction.push(m[2]);
        continue;
      }
    }

    // drop trigger if exists <name> on <table>
    {
      const m = /^drop\s+trigger\s+if\s+exists\s+([A-Za-z_][\w]*)\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(
        s,
      );
      if (m) {
        droppedTriggersBefore.add(`${m[1]}|${m[2]}`);
        continue;
      }
    }
    // drop trigger <name> on <table> — naked destructive
    {
      const m = /^drop\s+trigger\s+([A-Za-z_][\w]*)\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(s);
      if (m) {
        findings.nakedDropTrigger.push(`${m[1]} on ${m[2]}`);
        continue;
      }
    }

    // drop policy if exists <name> on <table>
    {
      const m = /^drop\s+policy\s+if\s+exists\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(
        s,
      );
      if (m) {
        droppedPoliciesBefore.add(`${m[1] ?? m[2]}|${m[3]}`);
        continue;
      }
    }
    // drop policy <name> on <table> — naked destructive
    {
      const m = /^drop\s+policy\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(
        s,
      );
      if (m) {
        findings.nakedDropPolicy.push(`${m[1] ?? m[2]} on ${m[3]}`);
        continue;
      }
    }

    // create [or replace] trigger <name> on <table>
    {
      const m =
        /^create\s+(or\s+replace\s+)?trigger\s+([A-Za-z_][\w]*)\s+(?:before|after|instead\s+of)[\s\S]*?\s+on\s+(?:public\.|auth\.)?([A-Za-z_][\w]*)/i.exec(
          s,
        );
      if (m) {
        const hasOrReplace = !!m[1];
        const triggerName = m[2];
        const tableName = m[3];
        if (!hasOrReplace && !droppedTriggersBefore.has(`${triggerName}|${tableName}`)) {
          findings.nakedCreateTrigger.push(`${triggerName} on ${tableName}`);
        }
        continue;
      }
    }

    // create policy <name> on <table>
    {
      const m =
        /^create\s+policy\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\s+on\s+(?:public\.)?([A-Za-z_][\w]*)/i.exec(
          s,
        );
      if (m) {
        const policyName = m[1] ?? m[2];
        const tableName = m[3];
        // Postgres 15+ supports `create policy if not exists` — detect it.
        const hasIfNotExists = /create\s+policy\s+if\s+not\s+exists/i.test(s);
        if (!hasIfNotExists && !droppedPoliciesBefore.has(`${policyName}|${tableName}`)) {
          findings.nakedCreatePolicy.push(`${policyName} on ${tableName}`);
        }
        continue;
      }
    }

    // drop table [if exists]
    {
      const m = /^drop\s+table\s+(if\s+exists\s+)?(?:public\.)?([A-Za-z_][\w]*)/i.exec(s);
      if (m) {
        if (!m[1]) findings.nakedDropTable.push(m[2]);
        continue;
      }
    }
    // drop function [if exists]
    {
      const m = /^drop\s+function\s+(if\s+exists\s+)?(?:(?:"[^"]+"|[A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)/i.exec(
        s,
      );
      if (m) {
        if (!m[1]) findings.nakedDropFunction.push(m[2]);
        continue;
      }
    }
    // drop index [if exists]
    {
      const m = /^drop\s+index\s+(if\s+exists\s+)?([A-Za-z_][\w]*)/i.exec(s);
      if (m) {
        if (!m[1]) findings.nakedDropIndex.push(m[2]);
        continue;
      }
    }
  }

  return findings;
}

function analyzeAll(): FileFindings[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return files.map((f) => analyzeFile(f, fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')));
}

const findingsAll = analyzeAll();
const incremental = findingsAll.filter((f) => f.file !== FOUNDATIONAL_FILE);

// ── Tests ────────────────────────────────────────────────────────────

describe('Supabase migration idempotency drift audit (R45(c))', () => {
  // (1) Foundational file exists and is lexically first.
  it(`foundational migration ${FOUNDATIONAL_FILE} exists and is the first`, () => {
    expect(findingsAll[0]?.file).toBe(FOUNDATIONAL_FILE);
  });

  // (2–8) Per-category INCREMENTAL checks.
  it('no naked CREATE TABLE in incremental migrations', () => {
    const hits = incremental
      .filter((f) => f.nakedCreateTable.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreateTable.join(', ')}`);
    expect(hits, `naked CREATE TABLE in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked CREATE INDEX in incremental migrations', () => {
    const hits = incremental
      .filter((f) => f.nakedCreateIndex.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreateIndex.join(', ')}`);
    expect(hits, `naked CREATE INDEX in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked CREATE EXTENSION in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedCreateExtension.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreateExtension.join(', ')}`);
    expect(hits, `naked CREATE EXTENSION in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked CREATE SCHEMA in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedCreateSchema.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreateSchema.join(', ')}`);
    expect(hits, `naked CREATE SCHEMA in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked ADD COLUMN in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedAddColumn.length > 0)
      .map((f) => `${f.file}: ${f.nakedAddColumn.join(', ')}`);
    expect(hits, `naked ADD COLUMN in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked CREATE FUNCTION (must use OR REPLACE) in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedCreateFunction.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreateFunction.join(', ')}`);
    expect(hits, `naked CREATE FUNCTION in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked CREATE TRIGGER in incremental migrations (must be preceded by DROP TRIGGER IF EXISTS, or use OR REPLACE)', () => {
    const hits = incremental
      .filter((f) => f.nakedCreateTrigger.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreateTrigger.join(', ')}`);
    expect(hits, `naked CREATE TRIGGER in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked CREATE POLICY in incremental migrations (must be preceded by DROP POLICY IF EXISTS)', () => {
    const hits = incremental
      .filter((f) => f.nakedCreatePolicy.length > 0)
      .map((f) => `${f.file}: ${f.nakedCreatePolicy.join(', ')}`);
    expect(hits, `naked CREATE POLICY in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  // (9–14) Destructive DDL safety in ANY migration (including 0001).
  it('no naked DROP TABLE in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedDropTable.length > 0)
      .map((f) => `${f.file}: ${f.nakedDropTable.join(', ')}`);
    expect(hits, `naked DROP TABLE in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked DROP COLUMN in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedDropColumn.length > 0)
      .map((f) => `${f.file}: ${f.nakedDropColumn.join(', ')}`);
    expect(hits, `naked DROP COLUMN in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked DROP FUNCTION in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedDropFunction.length > 0)
      .map((f) => `${f.file}: ${f.nakedDropFunction.join(', ')}`);
    expect(hits, `naked DROP FUNCTION in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked DROP TRIGGER in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedDropTrigger.length > 0)
      .map((f) => `${f.file}: ${f.nakedDropTrigger.join(', ')}`);
    expect(hits, `naked DROP TRIGGER in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked DROP INDEX in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedDropIndex.length > 0)
      .map((f) => `${f.file}: ${f.nakedDropIndex.join(', ')}`);
    expect(hits, `naked DROP INDEX in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('no naked DROP POLICY in any migration', () => {
    const hits = findingsAll
      .filter((f) => f.nakedDropPolicy.length > 0)
      .map((f) => `${f.file}: ${f.nakedDropPolicy.join(', ')}`);
    expect(hits, `naked DROP POLICY in: ${JSON.stringify(hits)}`).toEqual([]);
  });

  // (15) Parser-sanity: the statement walker must actually see a
  //      realistic volume of DDL. Guards against a parser regression
  //      (e.g. bad splitter) that would silently return zero
  //      statements and make every audit vacuously pass.
  it('parser coverage: statement walk returns a realistic volume of DDL', () => {
    const allStmts = findingsAll.reduce((acc, f) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f.file), 'utf8');
      return acc + splitSqlStatements(sql).length;
    }, 0);
    expect(allStmts).toBeGreaterThan(50);
    // Foundational 0001 should have ≥7 naked create-tables — sanity
    // check that the parser is actually finding things when it
    // should.
    const foundational = findingsAll.find((f) => f.file === FOUNDATIONAL_FILE)!;
    expect(
      foundational.nakedCreateTable.length,
      'foundational 0001 should contain ≥7 naked create tables (sanity)',
    ).toBeGreaterThanOrEqual(7);
  });

  // (16) Determinism: analyzeAll returns the same shape twice.
  it('analyzeAll is deterministic', () => {
    const a = analyzeAll();
    const b = analyzeAll();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
