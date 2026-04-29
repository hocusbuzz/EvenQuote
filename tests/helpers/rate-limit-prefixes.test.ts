// R48(a) — Tests for the shared rate-limit prefix registry.
//
// The registry is data + tiny pure helpers. These tests lock:
//   1. KNOWN_PREFIXES has no duplicates and matches PREFIX_SHAPE_RE.
//   2. KNOWN_PREFIX_SET is the same logical set (no drift between
//      array and set forms).
//   3. Every `prefix: '...'` string used by a real production caller
//      (route.ts files + server actions in lib/actions/*) is in
//      KNOWN_PREFIXES. A new route can't land a fresh prefix without
//      claiming a namespace here.
//   4. `isKnownPrefix` matches `KNOWN_PREFIX_SET.has`.
//   5. `assertKnownPrefixesUnique` and `assertKnownPrefixShape` pass
//      on the canonical registry.
//
// Layering note: this audit DOES touch the filesystem (it walks
// app/api/**/route.ts and lib/actions/*.ts looking for prefix
// literals). The registry module itself stays I/O-free; the I/O is
// confined to the audit.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  KNOWN_PREFIXES,
  KNOWN_PREFIX_SET,
  PREFIX_SHAPE_RE,
  isKnownPrefix,
  assertKnownPrefixesUnique,
  assertKnownPrefixShape,
} from './rate-limit-prefixes';
import { stripCommentsAndStringsPreservingPositions } from './source-walker';

const APP_API_DIR = path.resolve(process.cwd(), 'app/api');
const LIB_ACTIONS_DIR = path.resolve(process.cwd(), 'lib/actions');

// `prefix: '<value>'` in a real source file (not a test). The shape
// check is permissive about quote style; the validation step is what
// enforces the kebab-case rule.
const PREFIX_LITERAL_RE = /prefix\s*:\s*['"`]([A-Za-z0-9_\-/]+)['"`]/g;

function walkSourceFiles(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out.sort();
}

function extractPrefixLiteralsFromSource(file: string): string[] {
  const raw = fs.readFileSync(file, 'utf8');
  // Strip comments + string contents EXCEPT we still want to capture
  // string LITERALS used in code (the prefix value IS a string). So we
  // can't use the comment+string stripper directly. Instead just strip
  // comments and run the literal regex over the result.
  const stripped = raw
    // Block comments
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    // Line comments
    .replace(/(^|[^:'"`/])\/\/[^\n]*/g, (m, head) =>
      head + ' '.repeat(m.length - head.length),
    );
  const found: string[] = [];
  for (const match of stripped.matchAll(PREFIX_LITERAL_RE)) {
    found.push(match[1]);
  }
  return found;
}

describe('R48(a) — rate-limit prefix registry', () => {
  it('KNOWN_PREFIXES has no duplicates', () => {
    expect(() => assertKnownPrefixesUnique()).not.toThrow();
    expect(new Set(KNOWN_PREFIXES).size).toBe(KNOWN_PREFIXES.length);
  });

  it('every prefix matches PREFIX_SHAPE_RE (kebab-case)', () => {
    expect(() => assertKnownPrefixShape()).not.toThrow();
    for (const p of KNOWN_PREFIXES) {
      expect(
        PREFIX_SHAPE_RE.test(p),
        `prefix '${p}' does not match ${PREFIX_SHAPE_RE} — use lower kebab-case`,
      ).toBe(true);
    }
  });

  it('KNOWN_PREFIX_SET matches KNOWN_PREFIXES (no drift)', () => {
    expect(KNOWN_PREFIX_SET.size).toBe(KNOWN_PREFIXES.length);
    for (const p of KNOWN_PREFIXES) {
      expect(KNOWN_PREFIX_SET.has(p)).toBe(true);
    }
  });

  it('isKnownPrefix matches KNOWN_PREFIX_SET.has', () => {
    for (const p of KNOWN_PREFIXES) {
      expect(isKnownPrefix(p)).toBe(true);
    }
    expect(isKnownPrefix('not-a-real-prefix-zzz')).toBe(false);
    expect(isKnownPrefix('')).toBe(false);
  });

  it('every production prefix in app/api/**/route.ts is registered', () => {
    const routeFiles = walkSourceFiles(
      APP_API_DIR,
      (p) => p.endsWith('/route.ts'),
    );
    const found: { file: string; prefix: string }[] = [];
    for (const file of routeFiles) {
      for (const prefix of extractPrefixLiteralsFromSource(file)) {
        found.push({ file: path.relative(process.cwd(), file), prefix });
      }
    }
    const unregistered = found.filter((f) => !isKnownPrefix(f.prefix));
    expect(
      unregistered,
      `unregistered rate-limit prefix(es) in app/api/**/route.ts: ${
        unregistered.map((u) => `${u.file} → '${u.prefix}'`).join(', ')
      }`,
    ).toEqual([]);
  });

  it('every production prefix in lib/actions/*.ts is registered', () => {
    const actionFiles = walkSourceFiles(
      LIB_ACTIONS_DIR,
      (p) =>
        p.endsWith('.ts') &&
        !p.endsWith('.test.ts') &&
        !p.endsWith('-audit.ts'),
    );
    const found: { file: string; prefix: string }[] = [];
    for (const file of actionFiles) {
      for (const prefix of extractPrefixLiteralsFromSource(file)) {
        found.push({ file: path.relative(process.cwd(), file), prefix });
      }
    }
    const unregistered = found.filter((f) => !isKnownPrefix(f.prefix));
    expect(
      unregistered,
      `unregistered rate-limit prefix(es) in lib/actions/*.ts: ${
        unregistered.map((u) => `${u.file} → '${u.prefix}'`).join(', ')
      }`,
    ).toEqual([]);
  });

  it('PREFIX_SHAPE_RE rejects underscores, slashes, leading digits, and uppercase', () => {
    expect(PREFIX_SHAPE_RE.test('csp-report')).toBe(true);
    expect(PREFIX_SHAPE_RE.test('places-autocomplete')).toBe(true);
    expect(PREFIX_SHAPE_RE.test('a')).toBe(false); // single char (must end in letter+ — see RE)
    expect(PREFIX_SHAPE_RE.test('CSP-report')).toBe(false);
    expect(PREFIX_SHAPE_RE.test('csp_report')).toBe(false);
    expect(PREFIX_SHAPE_RE.test('csp/report')).toBe(false);
    expect(PREFIX_SHAPE_RE.test('1csp-report')).toBe(false);
    expect(PREFIX_SHAPE_RE.test('csp-')).toBe(false);
    expect(PREFIX_SHAPE_RE.test('-csp')).toBe(false);
  });

  it('source-walker available for downstream audits (smoke check)', () => {
    // The registry module itself is I/O-free; the test file uses
    // source-walker to verify the prefix literal scan parses cleanly.
    // Smoke-asserting the helper is callable means any future change
    // to source-walker that breaks compatibility will surface here.
    const sample = `prefix: 'csp-report' /* not 'fake' */`;
    const stripped = stripCommentsAndStringsPreservingPositions(sample);
    expect(typeof stripped).toBe('string');
    expect(stripped.length).toBe(sample.length);
  });

  // ── R49(b) — negative-coverage extension ───────────────────────────
  //
  // The two positive-coverage tests above prove every `prefix:` literal
  // in the WALKED paths is registered. They do NOT prove that no
  // `assertRateLimit*` call exists outside those paths. A future PR
  // that imports `assertRateLimit` into, say, `lib/calls/engine.ts`
  // and calls it with a fresh prefix would land without registration
  // pressure — neither walked-path audit would notice.
  //
  // R49(b) closes that gap with a negative-coverage lock: scan a
  // broader set of production source paths and assert NONE contain
  // `assertRateLimit*` calls. The narrow allow-list is the rate-limit
  // primitive itself (`lib/security/rate-limit-auth.ts`) plus its
  // exports re-export point. If a new caller emerges, the audit fails
  // and forces the maintainer to either move the call into a walked
  // path OR extend the walker (and registry) explicitly.

  // Production source paths that MUST NOT contain `assertRateLimit*`
  // calls without explicit allow-listing. Each path corresponds to a
  // real top-level directory under lib/ that the positive walker
  // doesn't cover today. (`lib/actions/` IS positively walked above
  // and is intentionally excluded; `lib/security/` is excluded because
  // it houses the rate-limit primitive itself — the allow-list below
  // names the specific file inside it.)
  const NEGATIVE_COVERAGE_DIRS = [
    'lib/calls',
    'lib/cron',
    'lib/email',
    'lib/forms',
    'lib/ingest',
    'lib/observability',
    'lib/queue',
    'lib/stripe',
    'lib/supabase',
    'lib/text',
  ] as const;

  // Allow-list for files where `assertRateLimit*` IS legitimately
  // mentioned (the primitive itself). Today this is exactly one file:
  // `lib/security/rate-limit-auth.ts` defines and exports the
  // function. Anything outside this allow-list adding a call to it
  // is a violation.
  const RATE_LIMIT_CALL_ALLOWLIST = new Set<string>([
    'lib/security/rate-limit-auth.ts',
  ]);

  it('R49(b) — no `assertRateLimit*` call appears outside walked paths or the allow-list', () => {
    const violations: { file: string; line: number; preview: string }[] = [];
    const re = /\bassertRateLimit(?:FromHeaders)?\s*\(/;

    for (const rel of NEGATIVE_COVERAGE_DIRS) {
      const dir = path.resolve(process.cwd(), rel);
      if (!fs.existsSync(dir)) continue;
      const files = walkSourceFiles(
        dir,
        (p) =>
          (p.endsWith('.ts') || p.endsWith('.tsx')) &&
          !p.endsWith('.test.ts') &&
          !p.endsWith('.test.tsx'),
      );
      for (const file of files) {
        const repoRel = path.relative(process.cwd(), file);
        if (RATE_LIMIT_CALL_ALLOWLIST.has(repoRel)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        // Strip comments to avoid false positives on doc snippets.
        const stripped = raw
          .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
          .replace(/(^|[^:'"`/])\/\/[^\n]*/g, (m, head) =>
            head + ' '.repeat(m.length - head.length),
          );
        const lines = stripped.split('\n');
        lines.forEach((line, idx) => {
          if (re.test(line)) {
            violations.push({
              file: repoRel,
              line: idx + 1,
              preview: line.trim().slice(0, 120),
            });
          }
        });
      }
    }

    expect(
      violations,
      `assertRateLimit* call found outside walked paths/allow-list — extend WALKER OR add to RATE_LIMIT_CALL_ALLOWLIST: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it('R49(b) — RATE_LIMIT_CALL_ALLOWLIST entries all exist on disk', () => {
    // A typo in the allow-list silently exempts a non-existent file.
    // Confirm every entry is real.
    const missing: string[] = [];
    for (const rel of RATE_LIMIT_CALL_ALLOWLIST) {
      const full = path.resolve(process.cwd(), rel);
      if (!fs.existsSync(full)) missing.push(rel);
    }
    expect(
      missing,
      `RATE_LIMIT_CALL_ALLOWLIST references nonexistent files: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('R49(b) — every NEGATIVE_COVERAGE_DIRS entry exists on disk', () => {
    // Same shape as above — an entry pointing at a directory that's
    // been renamed or removed silently shrinks the negative-coverage
    // surface.
    const missing: string[] = [];
    for (const rel of NEGATIVE_COVERAGE_DIRS) {
      const full = path.resolve(process.cwd(), rel);
      if (!fs.existsSync(full)) missing.push(rel);
    }
    expect(
      missing,
      `NEGATIVE_COVERAGE_DIRS references nonexistent directories: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
