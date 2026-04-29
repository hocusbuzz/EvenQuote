// R45(d) — Zod shared-primitive drift audit.
//
// Four shared zod primitives live in `lib/forms/moving-intake.ts` and
// must be used consistently across every file that validates the same
// kind of input:
//
//   EmailSchema      — `z.string().trim().toLowerCase().email(...)`
//   ZipSchema        — `z.string().trim().regex(/^\d{5}(-\d{4})?$/, ...)`
//   UsStateSchema    — `z.enum(US_STATES)` (50 states + DC)
//   PhoneSchema      — `z.string().trim().min(10).max(20).regex(...)`
//
// WHY THIS MATTERS
// ────────────────
// Drift here is silent and causes real production bugs:
//
//   (1) An email field that chains `.email()` BEFORE `.trim()` rejects
//       any pasted email with surrounding whitespace — users blame
//       "the form is broken" and bounce.
//
//   (2) A ZIP field with a looser regex (e.g. `z.string().min(5)`)
//       accepts "abcde" and downstream geo-radius RPC calls fail.
//
//   (3) A state field that uses `z.string()` instead of `z.enum(US_STATES)`
//       silently accepts "XX" or "New York" (not a 2-letter code), and
//       the businesses_within_radius RPC returns zero rows.
//
//   (4) A phone field without the regex accepts `"hello"` and the Vapi
//       call fails with a cryptic phone-format error.
//
// HOW THE AUDIT WORKS
// ───────────────────
// (A) Asserts each primitive is exported from moving-intake.ts with
//     the expected shape (regex literal, enum identifier, method
//     chain). Uses source-level grep (not runtime import) because
//     runtime importing zod would require fewer caveats around
//     TypeScript transformer config in the test harness.
//
// (B) Asserts cleaning-intake.ts imports + re-exports each primitive
//     so downstream callers can import either module and get the same
//     symbol. Prevents a silent "forked" cleaning-intake primitive.
//
// (C) Scans lib/ and app/ for inline duplicates of the canonical
//     signatures — any inline `z.string().trim().toLowerCase().email`
//     or inline ZIP regex `/^\d{5}(-\d{4})?$/` outside of the canonical
//     file fails. The audit lists two allow-listed exceptions:
//       • `lib/env.ts` uses `z.string().email()` for env-var validation
//         (loose, deliberate — server-side env can be an absolute URL
//         OR an email; we don't normalize whitespace).
//       • `lib/actions/auth.ts` uses a chain-reordered `.email().toLowerCase()
//         .trim()` with a different error message for the magic-link
//         login form. Different UX context, consciously not shared.
//     If a new duplicate appears, either add it to the allow list
//     with a reason or refactor to import from moving-intake.ts.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  stripCommentsPreservingPositions,
  stripCommentsAndStringsPreservingPositions,
} from '../../tests/helpers/source-walker';

const MOVING_INTAKE = path.resolve(process.cwd(), 'lib/forms/moving-intake.ts');
const CLEANING_INTAKE = path.resolve(process.cwd(), 'lib/forms/cleaning-intake.ts');
const LIB_DIR = path.resolve(process.cwd(), 'lib');
const APP_DIR = path.resolve(process.cwd(), 'app');

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (!fs.existsSync(cur)) continue;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

// Files allow-listed to use inline variants of the canonical email
// chain. Each entry is { file, reason } — reason is documentation for
// future readers.
//
// R46(b): lib/env.ts was previously here because it used inline
// `z.string().email()`. It now imports the shared `EnvEmailSchema`
// primitive from moving-intake.ts (also deliberately loose — no trim,
// no toLowerCase). The exception is gone; the loose chain is now a
// proper named primitive with its own attestation test below.
const EMAIL_ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: 'lib/actions/auth.ts',
    reason:
      'Magic-link login form uses a reordered chain and custom error copy. Deliberately kept separate from intake because the UX context (login flow) is different.',
  },
];

// Canonical regex literal exactly as written in ZipSchema.
const ZIP_REGEX_LITERAL = String.raw`/^\d{5}(-\d{4})?$/`;

// Files allow-listed to duplicate the ZIP regex literal. None today;
// adding an entry requires a justification comment.
const ZIP_REGEX_ALLOWLIST: { file: string; reason: string }[] = [];

// Canonical phone regex literal.
const PHONE_REGEX_LITERAL = String.raw`/^[+\d][\d\s\-().]*$/`;

const PHONE_REGEX_ALLOWLIST: { file: string; reason: string }[] = [];

// Inline US_STATES array literal (any duplicate of the 51-element
// 2-letter array would be drift).
const US_STATES_FIRST_ENTRIES = "'AL', 'AK', 'AZ', 'AR', 'CA'";

const US_STATES_ALLOWLIST: { file: string; reason: string }[] = [];

// ── Tests ────────────────────────────────────────────────────────────

describe('Zod shared-primitive drift audit (R45(d))', () => {
  // ── (1) Shape of each primitive in moving-intake.ts ────────────────

  it('moving-intake.ts exports ZipSchema with the canonical regex chain', () => {
    const src = stripCommentsPreservingPositions(readFile(MOVING_INTAKE));
    expect(
      /export\s+const\s+ZipSchema\s*=\s*z\s*[\s\S]*?\.trim\(\)[\s\S]*?\.regex\(\s*\/\^\\d\{5\}\(-\\d\{4\}\)\?\$\//m.test(
        src,
      ),
      'ZipSchema must chain z.string().trim().regex(/^\\d{5}(-\\d{4})?$/, ...) — no downgrade',
    ).toBe(true);
  });

  it('moving-intake.ts exports PhoneSchema with min/max/regex chain', () => {
    const src = stripCommentsPreservingPositions(readFile(MOVING_INTAKE));
    expect(
      /export\s+const\s+PhoneSchema\s*=\s*z[\s\S]*?\.trim\(\)[\s\S]*?\.min\(\s*10\b[\s\S]*?\.max\(\s*20\b[\s\S]*?\.regex\(/m.test(
        src,
      ),
      'PhoneSchema must chain .trim().min(10).max(20).regex(...) — no downgrade',
    ).toBe(true);
  });

  it('moving-intake.ts exports UsStateSchema = z.enum(US_STATES)', () => {
    const src = stripCommentsPreservingPositions(readFile(MOVING_INTAKE));
    expect(
      /export\s+const\s+UsStateSchema\s*=\s*z\.enum\s*\(\s*US_STATES\s*\)/.test(src),
      'UsStateSchema must be z.enum(US_STATES) — no z.string() downgrade',
    ).toBe(true);
  });

  it('moving-intake.ts exports EmailSchema with the canonical chain order', () => {
    const src = stripCommentsPreservingPositions(readFile(MOVING_INTAKE));
    expect(
      /export\s+const\s+EmailSchema\s*=\s*z\s*[\s\S]*?\.trim\(\)[\s\S]*?\.toLowerCase\(\)[\s\S]*?\.email\(/m.test(
        src,
      ),
      'EmailSchema must chain .trim().toLowerCase().email(...) — order matters so trim+lowercase run before the format check',
    ).toBe(true);
  });

  it('moving-intake.ts exports US_STATES with 51 entries (50 states + DC)', () => {
    const src = stripCommentsPreservingPositions(readFile(MOVING_INTAKE));
    const m = /export\s+const\s+US_STATES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/m.exec(src);
    expect(m, 'US_STATES array literal not found').not.toBeNull();
    const count = (m![1].match(/'[A-Z]{2}'/g) ?? []).length;
    expect(count).toBe(51);
  });

  // ── (2) cleaning-intake.ts re-exports each primitive ───────────────

  it('cleaning-intake.ts imports every shared primitive from moving-intake.ts', () => {
    const src = stripCommentsPreservingPositions(readFile(CLEANING_INTAKE));
    // Normalize the import block so it tolerates different formatting.
    // `[^}]*?` so we don't greedily cross the earlier `import { z } from 'zod'` block.
    const importBlock = /import\s*\{([^}]*?)\}\s*from\s*'\.\/moving-intake'/m.exec(src);
    expect(importBlock, 'cleaning-intake.ts must import from ./moving-intake').not.toBeNull();
    const imports = new Set(
      importBlock![1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    for (const primitive of [
      'ZipSchema',
      'PhoneSchema',
      'UsStateSchema',
      'EmailSchema',
      'HomeSizeSchema',
      'HOME_SIZES',
      'US_STATES',
    ]) {
      expect(imports.has(primitive), `cleaning-intake.ts missing import: ${primitive}`).toBe(
        true,
      );
    }
  });

  it('cleaning-intake.ts re-exports every shared primitive', () => {
    const src = stripCommentsPreservingPositions(readFile(CLEANING_INTAKE));
    for (const primitive of [
      'ZipSchema',
      'PhoneSchema',
      'UsStateSchema',
      'EmailSchema',
      'HomeSizeSchema',
      'HOME_SIZES',
      'US_STATES',
    ]) {
      expect(
        new RegExp(`export\\s*\\{[^}]*?\\b${primitive}\\b[^}]*?\\}`, 'm').test(src),
        `cleaning-intake.ts missing re-export: ${primitive}`,
      ).toBe(true);
    }
  });

  // ── (3) No inline duplicates across lib/ + app/ ────────────────────

  function findDuplicates(
    needle: RegExp,
    allowlist: { file: string; reason: string }[],
    canonicalFiles: string[],
  ): string[] {
    const allFiles = [...walkTs(LIB_DIR), ...walkTs(APP_DIR)];
    const hits: string[] = [];
    for (const f of allFiles) {
      const rel = path.relative(process.cwd(), f);
      if (canonicalFiles.includes(rel)) continue;
      if (allowlist.some((entry) => entry.file === rel)) continue;
      const src = stripCommentsAndStringsPreservingPositions(readFile(f));
      if (needle.test(src)) hits.push(rel);
    }
    return hits;
  }

  it('no inline duplicates of the ZIP regex outside moving-intake.ts', () => {
    // Literal `/^\d{5}(-\d{4})?$/` in source. stripCommentsAndStringsPreservingPositions
    // blanks out string literals but leaves regex literals intact (per
    // R43(a)'s canStartRegex helper), so the match is against real
    // regex syntax, not a string like "'/^\d{5}...'".
    const re = /\/\^\\d\{5\}\(-\\d\{4\}\)\?\$\//;
    const hits = findDuplicates(re, ZIP_REGEX_ALLOWLIST, ['lib/forms/moving-intake.ts']);
    expect(
      hits,
      `Inline ZIP regex duplicates found — import ZipSchema from moving-intake.ts instead: ${JSON.stringify(hits)}`,
    ).toEqual([]);
    // Reference the allowlist so it's not dead code and explicit.
    void ZIP_REGEX_ALLOWLIST;
    void ZIP_REGEX_LITERAL;
  });

  it('no inline duplicates of the phone regex outside moving-intake.ts', () => {
    // `/^[+\d][\d\s\-().]*$/` — same regex-literal-aware scan.
    const re = /\/\^\[\+\\d\]\[\\d\\s\\-\(\)\.\]\*\$\//;
    const hits = findDuplicates(re, PHONE_REGEX_ALLOWLIST, ['lib/forms/moving-intake.ts']);
    expect(
      hits,
      `Inline phone regex duplicates found — import PhoneSchema from moving-intake.ts instead: ${JSON.stringify(hits)}`,
    ).toEqual([]);
    void PHONE_REGEX_ALLOWLIST;
    void PHONE_REGEX_LITERAL;
  });

  it('no inline duplicates of the US_STATES array literal', () => {
    // Scan for the first five entries as a distinctive prefix. We don't
    // use stripCommentsAndStringsPreservingPositions here because the
    // entries ARE string literals — we need them to survive. Instead,
    // strip only comments.
    const allFiles = [...walkTs(LIB_DIR), ...walkTs(APP_DIR)];
    const hits: string[] = [];
    for (const f of allFiles) {
      const rel = path.relative(process.cwd(), f);
      if (rel === 'lib/forms/moving-intake.ts') continue;
      if (US_STATES_ALLOWLIST.some((entry) => entry.file === rel)) continue;
      const src = stripCommentsPreservingPositions(readFile(f));
      if (src.includes(US_STATES_FIRST_ENTRIES)) hits.push(rel);
    }
    expect(
      hits,
      `Inline US_STATES duplicates found — import US_STATES from moving-intake.ts instead: ${JSON.stringify(hits)}`,
    ).toEqual([]);
    void US_STATES_ALLOWLIST;
  });

  it('no inline duplicates of the canonical email chain outside allow-listed files', () => {
    // Canonical chain: z.string().trim().toLowerCase().email(
    // Use stripCommentsPreservingPositions so string literals (which
    // the email error text lives in) remain visible — but that also
    // means a comment "example: z.string().trim().toLowerCase().email()"
    // would false-match, hence the stripping.
    const allFiles = [...walkTs(LIB_DIR), ...walkTs(APP_DIR)];
    const re = /z\s*\.\s*string\s*\(\s*\)\s*\.\s*trim\s*\(\s*\)\s*\.\s*toLowerCase\s*\(\s*\)\s*\.\s*email\s*\(/;
    const hits: string[] = [];
    for (const f of allFiles) {
      const rel = path.relative(process.cwd(), f);
      if (rel === 'lib/forms/moving-intake.ts') continue;
      if (EMAIL_ALLOWLIST.some((entry) => entry.file === rel)) continue;
      const src = stripCommentsPreservingPositions(readFile(f));
      if (re.test(src)) hits.push(rel);
    }
    expect(
      hits,
      `Inline canonical email chain duplicates found — import EmailSchema from moving-intake.ts instead: ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });

  // ── (4) Attestation: known exceptions remain exactly as documented ─

  it('moving-intake.ts exports EnvEmailSchema as the loose env-var primitive', () => {
    // R46(b): Loose chain (no trim, no toLowerCase) — env vars are
    // operator-set, NOT user input. Silent normalization would mask
    // a typo at deploy time. The chain is exactly `z.string().email()`.
    const src = stripCommentsPreservingPositions(readFile(MOVING_INTAKE));
    expect(
      /export\s+const\s+EnvEmailSchema\s*=\s*z\s*\.\s*string\s*\(\s*\)\s*\.\s*email\s*\(\s*\)/m.test(
        src,
      ),
      'EnvEmailSchema must be exactly z.string().email() — no .trim(), no .toLowerCase() (env vars are operator-set, not user input)',
    ).toBe(true);
  });

  it('lib/env.ts imports + uses EnvEmailSchema (no inline z.string().email() chain)', () => {
    // R46(b): lib/env.ts must consume the shared primitive rather than
    // duplicate the chain inline. This locks the env-email validation
    // surface to a single source of truth so a future schema change
    // (e.g., add a max length) propagates everywhere via one edit.
    const src = readFile(path.resolve(process.cwd(), 'lib/env.ts'));
    const stripped = stripCommentsPreservingPositions(src);
    // Positive: import EnvEmailSchema from moving-intake.
    expect(
      /import\s*\{[^}]*\bEnvEmailSchema\b[^}]*\}\s*from\s*['"]@\/lib\/forms\/moving-intake['"]/.test(
        stripped,
      ),
      'lib/env.ts must `import { EnvEmailSchema } from "@/lib/forms/moving-intake"`',
    ).toBe(true);
    // Positive: actually USE EnvEmailSchema somewhere.
    expect(
      /\bEnvEmailSchema\b/.test(stripped.replace(/import[\s\S]*?;/g, '')),
      'lib/env.ts imports EnvEmailSchema but never uses it',
    ).toBe(true);
    // Negative: no inline `z.string().email(` — must go through the
    // shared primitive.
    expect(
      /z\s*\.\s*string\s*\(\s*\)\s*\.\s*email\s*\(/.test(stripped),
      'lib/env.ts must NOT contain inline `z.string().email(` — use EnvEmailSchema instead',
    ).toBe(false);
    // Negative: no canonical user-input chain (would silently
    // normalize operator input).
    expect(
      /z\s*\.\s*string\s*\(\s*\)\s*\.\s*trim\s*\(\s*\)\s*\.\s*toLowerCase\s*\(\s*\)\s*\.\s*email\s*\(/.test(
        stripped,
      ),
      'lib/env.ts must NOT adopt the canonical intake chain — env vars are unnormalized',
    ).toBe(false);
  });

  it('lib/actions/auth.ts uses the allow-listed reordered magic-link email chain', () => {
    const src = readFile(path.resolve(process.cwd(), 'lib/actions/auth.ts'));
    const stripped = stripCommentsPreservingPositions(src);
    // Magic-link chain: `.email(...).toLowerCase().trim()` — .email
    // FIRST. Locks the current state so a drive-by "fix" doesn't
    // silently promote it to the canonical order.
    expect(
      /\.email\s*\([^)]*\)\s*\.\s*toLowerCase\s*\(\s*\)\s*\.\s*trim\s*\(\s*\)/.test(stripped),
      'lib/actions/auth.ts must chain .email(msg).toLowerCase().trim() (current allow-listed exception)',
    ).toBe(true);
  });

  // ── (5) Attestation: allow-list entries map to real files ──────────

  it('every allow-listed file exists', () => {
    const all = [
      ...EMAIL_ALLOWLIST.map((e) => e.file),
      ...ZIP_REGEX_ALLOWLIST.map((e) => e.file),
      ...PHONE_REGEX_ALLOWLIST.map((e) => e.file),
      ...US_STATES_ALLOWLIST.map((e) => e.file),
    ];
    const missing = all.filter((f) => !fs.existsSync(path.resolve(process.cwd(), f)));
    expect(missing, `allow-list entries with no file: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('every allow-list entry has a non-empty reason', () => {
    const all = [
      ...EMAIL_ALLOWLIST,
      ...ZIP_REGEX_ALLOWLIST,
      ...PHONE_REGEX_ALLOWLIST,
      ...US_STATES_ALLOWLIST,
    ];
    for (const entry of all) {
      expect(entry.reason.length, `allow-list entry ${entry.file} has empty reason`).toBeGreaterThan(
        10,
      );
    }
  });
});
