// R40(d) — Service categories slug drift audit.
//
// BLAST RADIUS
// ────────────
// The service category slug is a string key threaded through:
//   1. Database seed files (0001_service_categories.sql,
//      0002_multi_vertical_categories.sql) — inserted as rows.
//   2. Server actions (lib/actions/intake.ts, lib/actions/cleaning-intake.ts)
//      — lookup filter (`.eq('slug', ...)`) to resolve category_id before insert.
//   3. Client intake forms (lib/forms/moving-intake.ts,
//      lib/forms/cleaning-intake.ts) — Zod schema (for reference in headers).
//   4. Page router (app/get-quotes/[category]/page.tsx) — LIVE_FORMS map key
//      determines whether a slug renders a real form or waitlist capture.
//   5. Category picker (app/get-quotes/page.tsx) — LIVE_SLUGS set determines
//      which categories show the live form UI vs. "coming soon".
//   6. Success/checkout pages (app/get-quotes/success/page.tsx,
//      app/get-quotes/checkout/page.tsx) — CATEGORY_NOUN map for display text.
//   7. Dev trigger (app/api/dev/trigger-call/route.ts) — default category slug.
//   8. Quote extraction (lib/calls/extract-quote.ts) — displayName fallback.
//
// A TYPO in any single source creates a silent mismatch:
//   • Seed typo (e.g., 'moving' vs. 'movng'): .eq('slug', 'moving') finds nothing
//     → quote_request.category_id = NULL → extraction fails.
//   • Action typo: .eq('slug', 'movng') returns zero rows → error message to user.
//   • LIVE_FORMS typo: key 'movng' never matched → user sees waitlist instead of form.
//   • LIVE_SLUGS typo: 'movng' missing → category hides from picker.
//   • Display-name map typo: 'movng' not in map → falls back to generic "local pros".
//   • Dev trigger typo: tests fire against wrong category.
//   • Extract-quote fallback: displayName mismatch (only for moving; cleanup is a future refactor).
//
// THE INVARIANT
// ─────────────
// The slug set is DE FACTO: {'moving', 'cleaning', 'handyman', 'lawn-care'}
// (from 0001_service_categories.sql and 0002_multi_vertical_categories.sql).
//
// Only 'moving' and 'cleaning' are LIVE (render real intake forms).
// The other two ('handyman', 'lawn-care') are waitlist-only.
//
// Every source must agree on this set. A slug missing from ANY source signals
// a config drift that goes unnoticed until a user hits it (silent 404,
// missing display text, wrong form rendering).
//
// SOURCE FILES SCANNED (8 files, 11+ surfaces)
// ─────────────────────────────────────────────
//   ✓ supabase/seed/0001_service_categories.sql
//   ✓ supabase/seed/0002_multi_vertical_categories.sql
//   ✓ lib/actions/intake.ts (moving)
//   ✓ lib/actions/cleaning-intake.ts (cleaning)
//   ✓ lib/forms/moving-intake.ts (header reference)
//   ✓ lib/forms/cleaning-intake.ts (header reference)
//   ✓ app/get-quotes/[category]/page.tsx (LIVE_FORMS)
//   ✓ app/get-quotes/page.tsx (LIVE_SLUGS)
//   ✓ app/get-quotes/success/page.tsx (CATEGORY_NOUN display map)
//   ✓ app/get-quotes/checkout/page.tsx (CATEGORY_NOUN display map)
//   ✓ app/api/dev/trigger-call/route.ts (default category slug)
//   ✓ lib/calls/extract-quote.ts (displayName)

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 2026-05-02: junk-removal added (seeded via supabase/migrations/0016_junk_removal_category.sql,
// which lives outside the seed/ dir but is part of the canonical slug set).
// All four "post-launch" verticals now ship live forms (handyman, lawn-care,
// junk-removal joined moving + cleaning), so LIVE_SLUGS_EXPECTED widens to 5.
const CANONICAL_SLUGS = new Set([
  'moving',
  'cleaning',
  'handyman',
  'lawn-care',
  'junk-removal',
] as const);
const LIVE_SLUGS_EXPECTED = new Set([
  'moving',
  'cleaning',
  'handyman',
  'lawn-care',
  'junk-removal',
] as const);

// ─── Helpers ──────────────────────────────────────────────────────────

/** Parse INSERT INTO public.service_categories statements and extract slug values. */
function readSeededSlugs(sqlPath: string): Set<string> {
  const sql = fs.readFileSync(sqlPath, 'utf-8');
  const slugs = new Set<string>();

  // Match: insert into public.service_categories (..., 'slug', ...) values ( ..., '<value>', ...)
  // Look for 'slug' column and extract the corresponding value from the same position in the values clause.
  const insertPattern = /insert\s+into\s+public\.service_categories\s*\(\s*([^)]+)\s*\)\s*values\s*\(\s*([^)]+)\s*\)/gi;
  let match;

  while ((match = insertPattern.exec(sql)) !== null) {
    const columnStr = match[1];
    const valueStr = match[2];
    const columns = columnStr.split(',').map(c => c.trim().toLowerCase().replace(/^'|'$/g, ''));
    const slugIdx = columns.indexOf('slug');

    if (slugIdx !== -1) {
      // Parse values as a simple comma-separated list, handling quoted strings.
      const values: string[] = [];
      let current = '';
      let inQuote = false;
      let i = 0;

      while (i < valueStr.length) {
        const ch = valueStr[i];
        if (ch === "'" && (i === 0 || valueStr[i - 1] !== '\\')) {
          if (!inQuote && current.trim()) {
            values.push(current.trim());
            current = '';
          }
          inQuote = !inQuote;
          if (inQuote) {
            current = ch;
          } else {
            current += ch;
          }
        } else if (ch === ',' && !inQuote) {
          if (current.trim()) values.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
        i++;
      }
      if (current.trim()) values.push(current.trim());

      // Clean up values: remove quotes and whitespace
      const cleanValues = values
        .map(v => v.replace(/^'|'$/g, '').trim())
        .filter(v => v.length > 0);

      if (slugIdx < cleanValues.length) {
        const slugValue = cleanValues[slugIdx];
        if (slugValue && !slugValue.startsWith('jsonb')) {
          slugs.add(slugValue);
        }
      }
    }
  }

  return slugs;
}

/** Extract .eq('slug', 'X') patterns from a source file. */
function readEqLookups(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8');
  const lookups = new Set<string>();
  const eqPattern = /\.eq\s*\(\s*['"]slug['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = eqPattern.exec(src)) !== null) {
    lookups.add(match[1]);
  }
  return lookups;
}

/** Extract keys from LIVE_FORMS: Record<string, ...> object literal. */
function readLiveFormsKeys(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Find the LIVE_FORMS declaration and extract its keys.
  // Match: const LIVE_FORMS: Record<string, ...> = { ... };
  const match = /const\s+LIVE_FORMS\s*:\s*Record<string,\s*[^>]+>\s*=\s*\{([^}]*)\}/s.exec(src);
  if (!match) return new Set();

  const objectBody = match[1];
  const keys = new Set<string>();

  // Extract key: value pairs where key is either a bareword identifier
  // or a quoted string (slugs with hyphens like 'lawn-care' / 'junk-removal'
  // must be quoted to be valid TS object keys).
  const keyPattern = /^\s*(?:(['"])([a-z_][a-z0-9_-]*)\1|([a-z_][a-z0-9_-]*))\s*:/gm;
  let m;
  while ((m = keyPattern.exec(objectBody)) !== null) {
    const key = m[2] || m[3];
    if (key) keys.add(key);
  }

  return keys;
}

/** Extract LIVE_SLUGS = new Set([...]) and return the set contents. */
function readLiveSlugsSet(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8');

  const match = /const\s+LIVE_SLUGS\s*=\s*new\s+Set\s*\(\s*\[(.*?)\]\s*\)/s.exec(src);
  if (!match) return new Set();

  const contentsStr = match[1];
  const slugs = new Set<string>();

  // Extract quoted strings
  const slugPattern = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = slugPattern.exec(contentsStr)) !== null) {
    slugs.add(m[1]);
  }

  return slugs;
}

/** Extract keys from a CATEGORY_NOUN: Record<string, string> map. */
function readCategoryNounKeys(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Find CATEGORY_NOUN declaration
  const match = /const\s+CATEGORY_NOUN\s*:\s*Record<string,\s*string>\s*=\s*\{([^}]*)\}/s.exec(src);
  if (!match) return new Set();

  const mapStr = match[1];
  const keys = new Set<string>();

  // Extract 'key', "key", or key (unquoted) followed by colon
  // More robust: match quoted strings or bareword identifiers
  const keyPattern = /(['"])([a-z_][a-z0-9_-]*)\1\s*:|([a-z_][a-z0-9_-]*)\s*:/gi;
  let m;
  while ((m = keyPattern.exec(mapStr)) !== null) {
    // Group 2 is quoted key, group 3 is unquoted
    const key = m[2] || m[3];
    if (key) keys.add(key);
  }

  return keys;
}

/** Extract the default category slug from DEFAULTS map in trigger-call route. */
function readTriggerCallDefaults(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Find DEFAULTS: Record<string, Defaults> and extract its top-level keys.
  // Because DEFAULTS has nested objects, we need to find the opening and match braces.
  const defMatch = /const\s+DEFAULTS\s*:\s*Record<string,\s*\w+>\s*=\s*\{/i.exec(src);
  if (!defMatch) return new Set();

  const startIdx = defMatch.index + defMatch[0].length;
  let depth = 1;
  let i = startIdx;
  const keys = new Set<string>();

  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    i++;
  }

  const mapStr = src.substring(startIdx, i - 1); // -1 to exclude final }

  // Extract top-level keys only (before first nested {)
  // Match: 'key' or "key" or key (bareword) followed by colon and optionally more
  const keyPattern = /(['"])([a-z_][a-z0-9_-]*)\1\s*:|([a-z_][a-z0-9_-]*)\s*:/gi;
  let m;
  while ((m = keyPattern.exec(mapStr)) !== null) {
    const key = m[2] || m[3];
    if (key) {
      // Check this key is at depth 0 relative to current position
      const textBefore = mapStr.substring(0, m.index);
      let relDepth = 0;
      for (let j = 0; j < textBefore.length; j++) {
        if (textBefore[j] === '{') relDepth++;
        if (textBefore[j] === '}') relDepth--;
      }
      if (relDepth === 0) {
        keys.add(key);
      }
    }
  }

  return keys;
}

/** Extract displayName from CategoryContext in extract-quote.ts. */
function readExtractQuoteDisplayNames(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8');

  // Find DEFAULT_CATEGORY object and extract displayName value
  const match = /const\s+DEFAULT_CATEGORY\s*:\s*\w+\s*=\s*\{([^}]*displayName[^}]*)\}/s.exec(src);
  if (!match) return new Set();

  const blockStr = match[1];

  const displayMatch = /displayName\s*:\s*['"]([^'"]+)['"]/i.exec(blockStr);
  if (!displayMatch) return new Set();

  return new Set([displayMatch[1]]);
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('seed-category-slug-drift', () => {
  const cwd = process.cwd();
  const seed0001Path = path.resolve(cwd, 'supabase/seed/0001_service_categories.sql');
  const seed0002Path = path.resolve(cwd, 'supabase/seed/0002_multi_vertical_categories.sql');
  // 2026-05-02: junk-removal lives in a migration (0016) rather than the
  // seed/ dir — the seed file is "post-launch unmaintained" per the
  // migration's own header. Include it in the canonical scan so this
  // audit catches drift on it the same as the original seed slugs.
  const migration0016Path = path.resolve(
    cwd,
    'supabase/migrations/0016_junk_removal_category.sql',
  );
  const intakePath = path.resolve(cwd, 'lib/actions/intake.ts');
  const cleaningIntakePath = path.resolve(cwd, 'lib/actions/cleaning-intake.ts');
  const categoryPagePath = path.resolve(cwd, 'app/get-quotes/[category]/page.tsx');
  const quotesPagePath = path.resolve(cwd, 'app/get-quotes/page.tsx');
  const successPagePath = path.resolve(cwd, 'app/get-quotes/success/page.tsx');
  const checkoutPagePath = path.resolve(cwd, 'app/get-quotes/checkout/page.tsx');
  const triggerCallPath = path.resolve(cwd, 'app/api/dev/trigger-call/route.ts');
  const extractQuotePath = path.resolve(cwd, 'lib/calls/extract-quote.ts');

  describe('seeded slugs', () => {
    it('0001_service_categories.sql contains moving', () => {
      const slugs = readSeededSlugs(seed0001Path);
      expect(slugs).toContain('moving');
    });

    it('0002_multi_vertical_categories.sql contains cleaning, handyman, lawn-care', () => {
      const slugs = readSeededSlugs(seed0002Path);
      expect(slugs).toContain('cleaning');
      expect(slugs).toContain('handyman');
      expect(slugs).toContain('lawn-care');
    });

    it('migration 0016_junk_removal_category.sql contains junk-removal', () => {
      const slugs = readSeededSlugs(migration0016Path);
      expect(slugs).toContain('junk-removal');
    });

    it('combined seeded slugs match CANONICAL_SLUGS exactly', () => {
      const seeds1 = readSeededSlugs(seed0001Path);
      const seeds2 = readSeededSlugs(seed0002Path);
      const seeds3 = readSeededSlugs(migration0016Path);
      const combined = new Set([...seeds1, ...seeds2, ...seeds3]);
      expect(combined).toEqual(CANONICAL_SLUGS);
    });

    it('no unexpected slugs appear in either seed file', () => {
      const seeds1 = readSeededSlugs(seed0001Path);
      const seeds2 = readSeededSlugs(seed0002Path);
      const seeds3 = readSeededSlugs(migration0016Path);
      const combined = new Set([...seeds1, ...seeds2, ...seeds3]);

      for (const slug of combined) {
        expect(CANONICAL_SLUGS).toContain(slug);
      }
    });
  });

  describe('server action lookups', () => {
    it('lib/actions/intake.ts targets moving', () => {
      const lookups = readEqLookups(intakePath);
      expect(lookups).toContain('moving');
    });

    it('lib/actions/intake.ts lookups are subset of CANONICAL_SLUGS', () => {
      const lookups = readEqLookups(intakePath);
      for (const slug of lookups) {
        expect(CANONICAL_SLUGS).toContain(slug);
      }
    });

    it('lib/actions/cleaning-intake.ts targets cleaning', () => {
      const lookups = readEqLookups(cleaningIntakePath);
      expect(lookups).toContain('cleaning');
    });

    it('lib/actions/cleaning-intake.ts lookups are subset of CANONICAL_SLUGS', () => {
      const lookups = readEqLookups(cleaningIntakePath);
      for (const slug of lookups) {
        expect(CANONICAL_SLUGS).toContain(slug);
      }
    });
  });

  describe('LIVE_FORMS in [category]/page.tsx', () => {
    it('LIVE_FORMS keys are exactly LIVE_SLUGS_EXPECTED', () => {
      const keys = readLiveFormsKeys(categoryPagePath);
      expect(keys).toEqual(LIVE_SLUGS_EXPECTED);
    });

    it('LIVE_FORMS keys are all in CANONICAL_SLUGS', () => {
      const keys = readLiveFormsKeys(categoryPagePath);
      for (const key of keys) {
        expect(CANONICAL_SLUGS).toContain(key);
      }
    });
  });

  describe('LIVE_SLUGS in /get-quotes/page.tsx', () => {
    it('LIVE_SLUGS set matches LIVE_SLUGS_EXPECTED', () => {
      const slugs = readLiveSlugsSet(quotesPagePath);
      expect(slugs).toEqual(LIVE_SLUGS_EXPECTED);
    });

    it('LIVE_SLUGS are all in CANONICAL_SLUGS', () => {
      const slugs = readLiveSlugsSet(quotesPagePath);
      for (const slug of slugs) {
        expect(CANONICAL_SLUGS).toContain(slug);
      }
    });
  });

  describe('LIVE_FORMS / LIVE_SLUGS consistency', () => {
    it('LIVE_FORMS keys match LIVE_SLUGS set', () => {
      const liveFormsKeys = readLiveFormsKeys(categoryPagePath);
      const liveSlugs = readLiveSlugsSet(quotesPagePath);
      expect(liveFormsKeys).toEqual(liveSlugs);
    });
  });

  describe('CATEGORY_NOUN display maps', () => {
    // Allowed aliases: 'lawn' is an alias for 'lawn-care'
    const ALLOWED_ALIASES = new Set(['lawn']);

    it('success/page.tsx CATEGORY_NOUN keys are CANONICAL_SLUGS or allowed aliases', () => {
      const keys = readCategoryNounKeys(successPagePath);
      for (const key of keys) {
        const isCanonical = (Array.from(CANONICAL_SLUGS) as string[]).includes(key);
        const isAlias = ALLOWED_ALIASES.has(key);
        expect(isCanonical || isAlias).toBe(true);
      }
    });

    it('checkout/page.tsx CATEGORY_NOUN keys are CANONICAL_SLUGS or allowed aliases', () => {
      const keys = readCategoryNounKeys(checkoutPagePath);
      for (const key of keys) {
        const isCanonical = (Array.from(CANONICAL_SLUGS) as string[]).includes(key);
        const isAlias = ALLOWED_ALIASES.has(key);
        expect(isCanonical || isAlias).toBe(true);
      }
    });

    it('success and checkout CATEGORY_NOUN maps have matching keys', () => {
      const successKeys = readCategoryNounKeys(successPagePath);
      const checkoutKeys = readCategoryNounKeys(checkoutPagePath);
      expect(successKeys).toEqual(checkoutKeys);
    });
  });

  describe('dev trigger defaults', () => {
    it('app/api/dev/trigger-call/route.ts DEFAULTS keys are subset of CANONICAL_SLUGS', () => {
      const keys = readTriggerCallDefaults(triggerCallPath);
      for (const key of keys) {
        expect(CANONICAL_SLUGS).toContain(key);
      }
    });

    it('dev trigger defines at least moving', () => {
      const keys = readTriggerCallDefaults(triggerCallPath);
      expect(keys).toContain('moving');
    });
  });

  describe('extract-quote displayName', () => {
    it('extract-quote DEFAULT_CATEGORY displayName is in CANONICAL_SLUGS', () => {
      const displayNames = readExtractQuoteDisplayNames(extractQuotePath);
      for (const name of displayNames) {
        expect(CANONICAL_SLUGS).toContain(name);
      }
    });
  });

  describe('cross-file consistency', () => {
    it('every CANONICAL_SLUG appears in seeded data', () => {
      const seeds1 = readSeededSlugs(seed0001Path);
      const seeds2 = readSeededSlugs(seed0002Path);
      const seeds3 = readSeededSlugs(migration0016Path);
      const combined = new Set([...seeds1, ...seeds2, ...seeds3]);

      for (const slug of CANONICAL_SLUGS) {
        expect(combined).toContain(slug);
      }
    });

    it('moving is in 0001; cleaning/handyman/lawn-care are in 0002', () => {
      const seeds1 = readSeededSlugs(seed0001Path);
      const seeds2 = readSeededSlugs(seed0002Path);

      // moving only in 0001 (0002 has UPDATE, not INSERT)
      expect(seeds1).toContain('moving');
      expect(seeds2).not.toContain('moving');

      // cleaning, handyman, lawn-care only in 0002
      expect(seeds2).toContain('cleaning');
      expect(seeds2).toContain('handyman');
      expect(seeds2).toContain('lawn-care');
    });
  });

  describe('case and format discipline', () => {
    it('all seeded slugs are lowercase with hyphens', () => {
      const seeds1 = readSeededSlugs(seed0001Path);
      const seeds2 = readSeededSlugs(seed0002Path);
      const combined = new Set([...seeds1, ...seeds2]);

      for (const slug of Array.from(combined)) {
        expect(slug).toBe(slug.toLowerCase());
        expect(/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(slug)).toBe(true);
      }
    });

    it('all action lookups match seeded slugs case-sensitively', () => {
      const seeds1 = readSeededSlugs(seed0001Path);
      const seeds2 = readSeededSlugs(seed0002Path);
      const combined = new Set([...seeds1, ...seeds2]);

      const intakeLookups = readEqLookups(intakePath);
      const cleaningLookups = readEqLookups(cleaningIntakePath);
      const allLookups = new Set([...intakeLookups, ...cleaningLookups]);

      for (const slug of allLookups) {
        expect(Array.from(combined)).toContain(slug);
      }
    });
  });

  describe('form headers reference check', () => {
    it('lib/forms/moving-intake.ts exists', () => {
      expect(fs.existsSync(path.resolve(cwd, 'lib/forms/moving-intake.ts'))).toBe(true);
    });

    it('lib/forms/cleaning-intake.ts exists', () => {
      expect(fs.existsSync(path.resolve(cwd, 'lib/forms/cleaning-intake.ts'))).toBe(true);
    });
  });
});
