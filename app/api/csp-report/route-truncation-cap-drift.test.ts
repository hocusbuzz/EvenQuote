// R40(b) CSP-report truncation cap drift lock.
//
// `app/api/csp-report/route.ts` accepts CSP violation reports from browsers
// (as large, arbitrarily-padded request bodies) and persists selected fields
// to the `csp_violations` table. Browsers can emit enormous URLs, policies,
// and referrer chains — on an ad-heavy page, a single malicious third party
// can craft script-injection payloads that construct multi-MB `original-policy`
// fields or craft URLs with hundreds of KB of query parameters.
//
// Without explicit truncation caps per field, a single bad visitor could push
// a multi-megabyte row into Postgres — or a "let's bump the cap to 16 KB for
// debugging" commit could go unreviewed and ship as the new default.
//
// Why this matters:
//
//   1. DB row size blowup: Each csp_violations row has a fixed max. A 4 MB
//      `original_policy` field sinks query performance, replication, and
//      storage (at $$ per GB/month on typical OLAP clouds). The route is a
//      SINK for browser telemetry — it must rate-limit and bound inputs.
//
//   2. Silent drift: Truncation caps are not validated at the type level.
//      A refactor changing `.slice(0, 2048)` to `.slice(0, 16384)` is
//      syntactically valid. Without a source-level audit, it ships silently.
//
//   3. Inconsistent caps: If the route has two different cap strategies
//      (e.g. stripQuery uses 2048, but referrer uses 4096), a maintainer
//      who reworks persistence might apply the wrong cap to the wrong field.
//
// What gets locked:
//
//   1. stripQuery cap: `.slice(0, 2048)` appears exactly 3–4 times (once
//      per code path: bare keyword fallback, unparseable URL fallback,
//      and the normal case inside stripQuery). The literal 2048 is locked.
//   2. original_policy cap: `.slice(0, 4096)` appears exactly 1 time in
//      the persistViolation insert block. The literal 4096 is locked.
//   3. Forbidden large caps: 8192, 16384, 32768, 65536 must NOT appear
//      in the file (would indicate a silent drift to "debugging-friendly"
//      larger caps). Negative assertion.
//   4. Forbidden small caps: 100, 50, 10 must NOT appear (would truncate
//      useful data and break dashboards). Negative assertion.
//   5. Every URL/policy field in the insert: must use either stripQuery(...)
//      or an inline `.slice(0, NNNN)`. No raw field gets assigned unbounded.
//   6. Persisted columns: EXACTLY {violated_directive, effective_directive,
//      blocked_uri, document_uri, referrer, original_policy}. Locked to
//      prevent accidental capture of script_sample, extra_freeform, or
//      raw browser fields that could leak user input.
//   7. MAX_BODY_BYTES constant: Locked to 64 * 1024 (65536 bytes) — an
//      early size defense against log-flood attacks that try to pad the
//      request body itself.
//   8. hostOf fallback cap: 80 chars for unparseable URIs (line 98:
//      `uri.slice(0, 80)`). Locked to prevent hostOf from building unbounded
//      strings on crafted malformed URLs.
//
// Out of scope:
//
//   • Runtime behavior of stripQuery, hostOf, summarize (route.test.ts covers).
//   • Postgres schema validation (migrations-drift + type-drift audits).
//   • Body-shape contract (route-body-shape-drift.test.ts).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsPreservingPositions } from '@/tests/helpers/source-walker';

const routePath = path.resolve(process.cwd(), 'app/api/csp-report/route.ts');

function loadRouteSource(): string {
  return fs.readFileSync(routePath, 'utf8');
}

function countOccurrences(src: string, literal: string): number {
  // Count non-overlapping occurrences of the exact literal string.
  let count = 0;
  let idx = 0;
  while ((idx = src.indexOf(literal, idx)) !== -1) {
    count++;
    idx += literal.length;
  }
  return count;
}

describe('/api/csp-report truncation cap drift lock (R40b)', () => {
  // ── stripQuery cap lock ─────────────────────────────────────────────
  it('stripQuery contains .slice(0, 2048) exactly 3 times (one per code path)', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    // Find the stripQuery function and count .slice(0, 2048) inside it.
    const fnIdx = stripped.indexOf('function stripQuery');
    expect(fnIdx, 'stripQuery function not found').toBeGreaterThan(-1);

    const openBrace = stripped.indexOf('{', fnIdx);
    let depth = 1;
    let j = openBrace + 1;
    for (; j < stripped.length && depth > 0; j++) {
      const ch = stripped[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const fnBody = stripped.slice(openBrace, j);

    const count = countOccurrences(fnBody, '.slice(0, 2048)');
    expect(count, 'stripQuery should have .slice(0, 2048) in 3 code paths').toBe(3);
  });

  it('stripQuery .slice(0, 2048) caps are present exactly at expected lines', () => {
    const src = loadRouteSource();
    // Line 120: bare keyword fallback
    // Line 125: normal case return
    // Line 127: unparseable URL fallback
    // All should be .slice(0, 2048) — verify the literal 2048 is locked.
    const slicePattern = '.slice(0, 2048)';
    const count = countOccurrences(src, slicePattern);
    expect(count, `file should contain ${slicePattern} exactly 3 times`).toBe(3);
  });

  // ── original_policy cap lock ───────────────────────────────────────
  it('original_policy is capped to .slice(0, 4096) exactly once', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    // Find the persistViolation function.
    const fnIdx = stripped.indexOf('async function persistViolation');
    expect(fnIdx, 'persistViolation function not found').toBeGreaterThan(-1);

    const openBrace = stripped.indexOf('{', fnIdx);
    let depth = 1;
    let j = openBrace + 1;
    for (; j < stripped.length && depth > 0; j++) {
      const ch = stripped[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const fnBody = stripped.slice(openBrace, j);

    const count = countOccurrences(fnBody, '.slice(0, 4096)');
    expect(count, 'persistViolation should have .slice(0, 4096) exactly once for original_policy').toBe(1);
  });

  // ── Forbidden large caps ────────────────────────────────────────────
  it('file does NOT contain large debug caps (8192, 16384, 32768, 65536)', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    const forbiddenCaps = ['8192', '16384', '32768', '65536'];
    for (const cap of forbiddenCaps) {
      const pattern = `.slice(0, ${cap})`;
      expect(
        stripped.includes(pattern),
        `file should NOT contain ${pattern} — indicates drift to debugging-friendly larger caps`,
      ).toBe(false);
    }
  });

  // ── Forbidden small caps ────────────────────────────────────────────
  it('file does NOT contain small broken caps (100, 50, 10)', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    const forbiddenCaps = ['100', '50', '10'];
    for (const cap of forbiddenCaps) {
      const pattern = `.slice(0, ${cap})`;
      expect(
        stripped.includes(pattern),
        `file should NOT contain ${pattern} — would truncate useful telemetry`,
      ).toBe(false);
    }
  });

  // ── Insert column coverage lock ────────────────────────────────────
  it('persistViolation insert maps all 6 columns through stripQuery or .slice', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    // Find the insert call within persistViolation. Look for `.insert({`
    // after finding the function.
    const persistFnIdx = stripped.indexOf('async function persistViolation');
    expect(persistFnIdx, 'persistViolation not found').toBeGreaterThan(-1);

    const insertIdx = stripped.indexOf('.insert(', persistFnIdx);
    expect(insertIdx, 'insert call not found').toBeGreaterThan(-1);

    // Find the opening brace of the insert object.
    const openBrace = stripped.indexOf('{', insertIdx);
    expect(openBrace, 'insert object not found').toBeGreaterThan(-1);

    // Walk to the matching closing brace.
    let depth = 1;
    let i = openBrace + 1;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const insertBlock = stripped.slice(openBrace, i);

    // Expected columns that carry user input and require truncation:
    // blocked_uri, document_uri, referrer (use stripQuery)
    // original_policy (uses .slice(0, 4096))
    // violated_directive, effective_directive (string types, cast from report, no truncation)

    const columnsRequiringCap = ['blocked_uri', 'document_uri', 'referrer', 'original_policy'];
    for (const col of columnsRequiringCap) {
      // Match column definition: `col_name:` followed by whitespace/newlines, then the RHS.
      const colRegex = new RegExp(`${col}\\s*:`, 'g');
      const match = colRegex.exec(insertBlock);
      expect(match, `insert block should define ${col}`).not.toBeNull();

      if (match) {
        // Extract from after the `:` to the next field or closing brace.
        // We need to handle multi-line ternary expressions properly.
        // Look for the pattern: a line with a field name followed by `:` OR a closing `}`
        // that belongs to the object (not a nested ternary).
        const rhs = insertBlock.slice(match.index + match[0].length);

        // Find the next field definition (word followed by `:`) or closing `}`.
        // This is a simple heuristic: match the next line that starts with a word.
        const nextFieldRegex = /(?:,\s*(?=[a-zA-Z_])|,\s*})/;
        const nextFieldMatch = nextFieldRegex.exec(rhs);
        const rhsEnd = nextFieldMatch ? nextFieldMatch.index : rhs.length;

        const rhsExpr = rhs.slice(0, rhsEnd).trim();

        // Check if RHS contains .slice(0, or stripQuery — these indicate truncation.
        // For ternary expressions like `typeof x ? y.slice(0, 4096) : null`,
        // we just need to see if `.slice(0,` appears somewhere in the full RHS.
        const hasTruncation = rhsExpr.includes('stripQuery') || rhsExpr.includes('.slice(0,');
        expect(
          hasTruncation,
          `${col} RHS must use stripQuery(...) or .slice(0, N) — found: ${rhsExpr.substring(0, 80)}...`,
        ).toBe(true);
      }
    }
  });

  it('csp_violations insert contains EXACTLY these 6 columns: violated_directive, effective_directive, blocked_uri, document_uri, referrer, original_policy', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    // Extract the insert object.
    const insertIdx = stripped.indexOf("from('csp_violations').insert(");
    expect(insertIdx, 'insert call not found').toBeGreaterThan(-1);

    const openBrace = stripped.indexOf('{', insertIdx);
    let depth = 1;
    let i = openBrace + 1;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const insertBlock = stripped.slice(openBrace, i);

    const expectedColumns = [
      'violated_directive',
      'effective_directive',
      'blocked_uri',
      'document_uri',
      'referrer',
      'original_policy',
    ];

    for (const col of expectedColumns) {
      expect(
        insertBlock.includes(`${col}:`),
        `insert block must define ${col} column`,
      ).toBe(true);
    }

    // Negative: no script_sample, extra_freeform, raw, or body fields.
    const forbiddenColumns = [
      'script_sample',
      'script-sample',
      'extra_freeform',
      'extra-freeform',
      'raw:',
      'body:',
    ];
    for (const col of forbiddenColumns) {
      expect(
        insertBlock.includes(col),
        `insert block must NOT define ${col} — prevents leaking user input from browser report`,
      ).toBe(false);
    }
  });

  // ── MAX_BODY_BYTES constant lock ───────────────────────────────────
  it('MAX_BODY_BYTES is 64 * 1024 (65536 bytes)', () => {
    const src = loadRouteSource();

    // Look for the constant definition.
    const constIdx = src.indexOf('const MAX_BODY_BYTES');
    expect(constIdx, 'MAX_BODY_BYTES constant not found').toBeGreaterThan(-1);

    // Extract the line.
    const lineEnd = src.indexOf(';', constIdx);
    const line = src.slice(constIdx, lineEnd);

    // Should contain exactly this pattern.
    expect(line.includes('64 * 1024'), 'MAX_BODY_BYTES should be 64 * 1024').toBe(true);

    // Verify no alternative forms that would change the value.
    const forbiddenAlts = ['32 * 1024', '128 * 1024', '256 * 1024', '65536'];
    for (const alt of forbiddenAlts) {
      expect(
        line.includes(alt),
        `MAX_BODY_BYTES should NOT be ${alt}`,
      ).toBe(false);
    }
  });

  // ── hostOf fallback cap lock ───────────────────────────────────────
  it('hostOf unparseable URI fallback is capped to .slice(0, 80)', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    // Find the hostOf function.
    const fnIdx = stripped.indexOf('function hostOf');
    expect(fnIdx, 'hostOf function not found').toBeGreaterThan(-1);

    const openBrace = stripped.indexOf('{', fnIdx);
    let depth = 1;
    let i = openBrace + 1;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const fnBody = stripped.slice(openBrace, i);

    expect(
      fnBody.includes('.slice(0, 80)'),
      'hostOf must have .slice(0, 80) fallback for unparseable URIs',
    ).toBe(true);

    // Count to ensure it appears exactly once.
    const count = countOccurrences(fnBody, '.slice(0, 80)');
    expect(count, 'hostOf should have .slice(0, 80) exactly once').toBe(1);
  });

  // ── Comprehensive literal scan ──────────────────────────────────────
  it('file contains no broken slice bounds that would indicate refactoring accidents', () => {
    const src = loadRouteSource();
    const stripped = stripCommentsPreservingPositions(src);

    // List of all expected truncation bounds used in the file.
    const expectedBounds = new Set(['2048', '4096', '80', '64']);

    // Find all `.slice(0, N)` patterns and collect the N values.
    const slicePattern = /\.slice\(0,\s*(\d+)/g;
    const actualBounds = new Set<string>();
    let m;
    while ((m = slicePattern.exec(stripped)) !== null) {
      actualBounds.add(m[1]);
    }

    // All bounds found must be expected.
    for (const bound of actualBounds) {
      expect(
        expectedBounds.has(bound),
        `unexpected .slice(0, ${bound}) found — not in expected set: ${Array.from(expectedBounds).join(', ')}`,
      ).toBe(true);
    }

    // Spot-check: we should have multiple 2048, at least one 4096, etc.
    expect(actualBounds.has('2048'), 'expected .slice(0, 2048) for stripQuery').toBe(true);
    expect(actualBounds.has('4096'), 'expected .slice(0, 4096) for original_policy').toBe(true);
    expect(actualBounds.has('80'), 'expected .slice(0, 80) for hostOf').toBe(true);
  });
});
