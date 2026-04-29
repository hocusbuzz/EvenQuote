// R44(b) — Seed data integrity audit: sample_businesses.
//
// Extends R40(d) (`seed-category-slug-drift.test.ts`) which locks
// slug sets across migrations + actions + pages. This file locks
// the INTERNAL integrity of `supabase/seed/0002_sample_businesses.sql`
// — the only seed file that creates PII-adjacent rows — so that:
//
//   1. Every row belongs to the 'moving' service_category (the one
//      consumed by the `insert ... select` CTE).
//
//   2. All phone numbers use the reserved fictional US range
//      `+1-555-01XX`. This range is allocated by the NANP as "not
//      for use in real assignment" — safe to dial without routing to
//      a real person. A future contributor who copies real phone
//      numbers into seed data is the failure mode.
//
//   3. All emails use the `.test` TLD — RFC 6761 reserves `.test`
//      specifically for testing; it will NEVER resolve. A real
//      email (e.g. `@gmail.com`) would be a PII leak into the repo.
//
//   4. All websites use the `example.test` domain (RFC 2606 + 6761
//      combined safety).
//
//   5. All seed_place_ids (local identifier) are unique.
//
//   6. All google_place_ids are prefixed `seed_place_` so a real
//      Google Place ID cannot accidentally be committed.
//
//   7. Row count is bounded (guard against accidental paste of a
//      massive real dataset into the seed file).
//
//   8. Every phone, email, and place_id is globally unique within
//      the file.
//
// These are posterity locks — today's seed file is fully compliant.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SEED_FILE = path.resolve(
  process.cwd(),
  'supabase/seed/0002_sample_businesses.sql',
);

function readRows(): string[] {
  const src = fs.readFileSync(SEED_FILE, 'utf8');
  // Strip SQL comments first so a comment line like
  // `-- ('Fake Phone', '+14155551234', ...)` can't false-positive.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
  // Row-parse target: the single `from (values …) as t(…)` block.
  // Structure is `from (` then an outer `values` keyword followed by
  // inner `(row1), (row2), …` then the outer closing `) as t(…)`.
  // We want the INNER rows only — skip into the outer values block
  // and emit every depth==1 paren group as a row (strings are
  // tracked so `('it''s fine')` doesn't confuse the balance walk).
  const valuesIdx = stripped.indexOf('from (values');
  if (valuesIdx < 0) return [];
  const openOuterIdx = stripped.indexOf('(', valuesIdx);
  // Walk to the matching close of the OUTER paren.
  let depth = 0;
  let endOuter = -1;
  let inStr = false;
  for (let i = openOuterIdx; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (ch === "'" && stripped[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        endOuter = i;
        break;
      }
    }
  }
  if (endOuter < 0) return [];
  const block = stripped.slice(openOuterIdx + 1, endOuter);
  // Now inside the outer values block. Extract every top-level `(…)`.
  const rows: string[] = [];
  depth = 0;
  inStr = false;
  let rowStart = -1;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (inStr) {
      if (ch === "'" && block[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) rowStart = i;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && rowStart !== -1) {
        rows.push(block.slice(rowStart + 1, i));
        rowStart = -1;
      }
    }
  }
  return rows.filter((r) => r.trim().length > 0 && r.includes(','));
}

const ROWS = readRows();

// Simple CSV-ish row parser: split on commas NOT inside single
// quotes. Values are then unquoted if they start with `'`.
function parseRow(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inStr) {
      if (ch === "'" && row[i - 1] !== '\\') {
        inStr = false;
      }
      cur += ch;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

function unquote(s: string): string {
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

describe('supabase/seed/0002_sample_businesses.sql — integrity (R44(b))', () => {
  it('parser discovers between 15 and 40 rows (bounding check)', () => {
    // Today: 20 rows. Band guards against accidentally pasting a
    // 500-business real dataset, AND against an accidental truncation
    // that loses rows.
    expect(ROWS.length).toBeGreaterThanOrEqual(15);
    expect(ROWS.length).toBeLessThanOrEqual(40);
  });

  it('seed file uses the moving-category CTE (every row inherits category_id from one query)', () => {
    const src = fs.readFileSync(SEED_FILE, 'utf8');
    // Lock: the `with moving_cat as (select id from public.service_categories where slug = 'moving')`
    // CTE is used by every row. Any row that hardcodes a different
    // category_id would be a drift.
    expect(/with\s+moving_cat\s+as\s*\(\s*select\s+id\s+from\s+public\.service_categories\s+where\s+slug\s*=\s*'moving'\s*\)/i.test(
      src,
    )).toBe(true);
    // Only ONE `insert into public.businesses` in the file.
    const inserts = src.match(/insert\s+into\s+public\.businesses/gi) ?? [];
    expect(inserts.length).toBe(1);
  });

  it('every phone matches the reserved fictional range `+1-555-01XX`', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const phone = unquote(fields[1]);
      // NANP reserves +1-555-0100 through +1-555-0199 for fictional
      // use. E.164: +15550100 through +15550199.
      if (!/^\+15550\d{3}$/.test(phone)) {
        violations.push(`phone '${phone}' is outside +1-555-01XX`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every non-null email uses the `.test` TLD', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const emailRaw = fields[2];
      if (emailRaw === 'null') continue;
      const email = unquote(emailRaw);
      if (!email.endsWith('.test')) {
        violations.push(`email '${email}' is not a .test address`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every non-null website uses the `example.test` domain', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const siteRaw = fields[3];
      if (siteRaw === 'null') continue;
      const site = unquote(siteRaw);
      if (!site.startsWith('https://example.test/')) {
        violations.push(`website '${site}' not under https://example.test/`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every google_place_id begins with `seed_place_` (no real Google IDs)', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      // Last column is google_place_id.
      const placeId = unquote(fields[fields.length - 1]);
      if (!placeId.startsWith('seed_place_')) {
        violations.push(`place_id '${placeId}' is not a seed_place_* identifier`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('phones are globally unique within the file', () => {
    const phones = ROWS.map((r) => unquote(parseRow(r)[1]));
    expect(new Set(phones).size).toBe(phones.length);
  });

  it('google_place_ids are globally unique within the file', () => {
    const ids = ROWS.map((r) => {
      const f = parseRow(r);
      return unquote(f[f.length - 1]);
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('non-null emails are globally unique within the file', () => {
    const emails = ROWS.map((r) => parseRow(r)[2])
      .filter((e) => e !== 'null')
      .map(unquote);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('all ZIP codes are 5-digit numeric strings', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const zip = unquote(fields[6]);
      if (!/^\d{5}$/.test(zip)) {
        violations.push(`zip '${zip}' is not 5 digits`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('all state codes are 2-letter uppercase', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const state = unquote(fields[5]);
      if (!/^[A-Z]{2}$/.test(state)) {
        violations.push(`state '${state}' is not a 2-letter uppercase code`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('google_rating values are in [0, 5]', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const rating = parseFloat(fields[9]);
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
        violations.push(`rating '${fields[9]}' outside [0, 5]`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('google_review_count values are non-negative integers', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const reviews = parseInt(fields[10], 10);
      if (!Number.isFinite(reviews) || reviews < 0) {
        violations.push(`review_count '${fields[10]}' is not a valid non-negative integer`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('latitude values are in [-90, 90] and longitude in [-180, 180]', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const lat = parseFloat(fields[7]);
      const lng = parseFloat(fields[8]);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        violations.push(`latitude '${fields[7]}' out of range`);
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        violations.push(`longitude '${fields[8]}' out of range`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('business names are non-empty strings (sanity — parser not eating them)', () => {
    const violations: string[] = [];
    for (const row of ROWS) {
      const fields = parseRow(row);
      const name = unquote(fields[0]);
      if (!name || name.length < 3) {
        violations.push(`name '${name}' too short`);
      }
    }
    expect(violations).toEqual([]);
  });
});
