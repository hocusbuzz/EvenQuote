// R37(c) CSP-report route body-shape drift lock.
//
// `app/api/csp-report/route.ts` is the telemetry SINK the browser
// POSTs CSP violations to. The R32 attestation locks no-capture
// + response envelope invariants. This file locks one orthogonal
// concern: the JSON body-shape contract the route depends on to
// normalize a violation into its summary/persist columns.
//
// Why this matters:
//
//   If a browser vendor renames `violated-directive` → `directive`
//   in a future spec iteration, today's route would silently drop
//   every report from that vendor — every violation would
//   reach `summarize()` with directive='unknown' and blocked='unknown'
//   and nobody would notice until the CSP rollout window closed
//   and post-analysis found zero rows. This file fires when that
//   drift lands in the `summarize()` implementation.
//
// What gets locked:
//
//   1. The field-name vocabulary the route consumes: the exact set
//      of browser-provided keys that `summarize()` and
//      `persistViolation()` currently read.
//   2. The `stripQuery()` URL-normalization behaviour around known
//      PII-adjacent paths (guest tokens, emails-in-query, etc.).
//   3. The persist-column → report-field mapping so a future
//      maintainer who reshapes the insert payload can't silently
//      drop a column.
//   4. The report-to-vs-report-uri disambiguator — a spec drift in
//      the report-to envelope's `type` / `body` keys would be
//      caught.
//
// Out of scope:
//
//   • No-capture attestation (R32).
//   • Response envelope (R32).
//   • Actual Postgres column existence (R35 migrations-drift +
//     R36 type-drift cover that).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env as Record<string, string | undefined>;

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/observability/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

// Track insert payloads for persist-column drift lock.
const insertedRows: Array<Record<string, unknown>> = [];
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

async function loadRoute() {
  return await import('./route');
}

function postJson(body: unknown) {
  return new Request('https://example.com/api/csp-report', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('/api/csp-report body-shape drift lock (R37c)', () => {
  beforeEach(() => {
    vi.resetModules();
    warn.mockReset();
    insertedRows.length = 0;
    delete env.LOG_FULL_CSP;
    delete env.CSP_VIOLATIONS_PERSIST;
  });

  // ── Field-name vocabulary lock ─────────────────────────────────
  it('report-uri envelope key is exactly "csp-report" (not "csp_report" / "cspReport" / "report")', async () => {
    // Spec has been stable since CSP Level 2. A future rename by
    // any mainstream browser would be accompanied by a spec change;
    // we want to notice the drift in the next audit round, not at
    // preview deploy.
    const { POST } = await loadRoute();

    const goodBody = {
      'csp-report': {
        'violated-directive': 'script-src',
        'blocked-uri': 'https://tracker.example/p.js',
      },
    };
    await POST(postJson(goodBody));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockReset();

    // Drifted envelope keys must NOT match — the route should drop
    // the report (204 + no log) rather than misclassify it as a
    // report-uri body.
    const driftKeys = ['csp_report', 'cspReport', 'report', 'CSP-Report'];
    for (const key of driftKeys) {
      await POST(postJson({ [key]: goodBody['csp-report'] }));
    }
    expect(
      warn,
      `drifted envelope keys unexpectedly triggered the report-uri branch`,
    ).not.toHaveBeenCalled();
  });

  it('report-to envelope requires type==="csp-violation" AND a body object (narrow lock)', async () => {
    const { POST } = await loadRoute();

    // Valid.
    await POST(
      postJson([
        {
          type: 'csp-violation',
          body: { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        },
      ])
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockReset();

    // All of these must be dropped. Each covers one drift vector.
    const driftCases = [
      // Wrong `type` string.
      [{ type: 'csp-report', body: { 'violated-directive': 'x' } }],
      [{ type: 'CSP-Violation', body: { 'violated-directive': 'x' } }],
      [{ type: 'violation', body: { 'violated-directive': 'x' } }],
      // Missing `body`.
      [{ type: 'csp-violation' }],
      // Non-object `body`.
      [{ type: 'csp-violation', body: 'string-body' }],
      [{ type: 'csp-violation', body: 42 }],
      [{ type: 'csp-violation', body: null }],
    ];
    for (const body of driftCases) {
      await POST(postJson(body));
    }
    expect(
      warn,
      `drifted report-to envelopes unexpectedly passed the type==='csp-violation' filter`,
    ).not.toHaveBeenCalled();
  });

  it('summarize() reads EXACTLY these keys: violated-directive, effective-directive, blocked-uri, document-uri, source-file, line-number', async () => {
    // Lock the field-name vocabulary. If a future maintainer
    // renames any read here (or adds a new one without updating
    // this test), the audit fires. This is a source-level grep
    // against the route file — cheap, drift-catching.
    const routePath = path.resolve(process.cwd(), 'app/api/csp-report/route.ts');
    const src = fs.readFileSync(routePath, 'utf8');
    // Strip line comments so JSDoc examples don't confound the grep.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, (m) => m.startsWith(':') ? m : '');
    // Find the `summarize(` function body via balanced-brace walk.
    const fnIdx = stripped.indexOf('function summarize');
    expect(fnIdx).toBeGreaterThan(-1);
    const openBrace = stripped.indexOf('{', fnIdx);
    let depth = 1;
    let j = openBrace + 1;
    for (; j < stripped.length && depth > 0; j++) {
      const ch = stripped[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = stripped.slice(openBrace, j);

    const expectedKeys = [
      "'violated-directive'",
      "'effective-directive'",
      "'blocked-uri'",
      "'document-uri'",
      "'source-file'",
      "'line-number'",
    ];
    for (const key of expectedKeys) {
      expect(
        body.includes(key),
        `summarize() must read ${key} but it's missing from the function body`,
      ).toBe(true);
    }

    // Negative lock: no camelCase / snake_case drifts in the summarize body.
    const forbiddenDrifts = [
      "'violatedDirective'",
      "'violated_directive'",
      "'blockedUri'",
      "'blocked_uri'",
      "'documentUri'",
      "'document_uri'",
      "'sourceFile'",
      "'source_file'",
      "'lineNumber'",
      "'line_number'",
    ];
    for (const bad of forbiddenDrifts) {
      expect(
        body.includes(bad),
        `summarize() must NOT read ${bad} — the browser-side key is kebab-case per the CSP spec`,
      ).toBe(false);
    }
  });

  // ── Persist-column contract lock ───────────────────────────────
  it('persistViolation() inserts EXACTLY these 6 columns: violated_directive, effective_directive, blocked_uri, document_uri, referrer, original_policy', async () => {
    env.CSP_VIOLATIONS_PERSIST = 'true';
    const { POST } = await loadRoute();

    const report = {
      'violated-directive': 'script-src',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'https://tracker.example/a.js?t=abc',
      'document-uri': 'https://evenquote.com/get-quotes/claim?token=uuid-1234',
      'referrer': 'https://search.example.com/?q=something',
      'original-policy': "default-src 'self'; script-src 'self' 'sha256-ABC'",
    };

    await POST(postJson({ 'csp-report': report }));

    // Allow microtask flush for the fire-and-forget `void persistViolation(r)`.
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertedRows.length).toBe(1);
    const row = insertedRows[0];
    expect(new Set(Object.keys(row))).toEqual(
      new Set([
        'violated_directive',
        'effective_directive',
        'blocked_uri',
        'document_uri',
        'referrer',
        'original_policy',
      ]),
    );
    // Values present (strings, normalized).
    expect(row.violated_directive).toBe('script-src');
    expect(row.effective_directive).toBe('script-src-elem');
    // Query stripped from URLs.
    expect(row.blocked_uri).toBe('https://tracker.example/a.js');
    expect(row.document_uri).toBe('https://evenquote.com/get-quotes/claim');
    expect(row.referrer).toBe('https://search.example.com/');
    // Original policy kept but bounded.
    expect(typeof row.original_policy).toBe('string');
  });

  it('persistViolation() strips query strings from URLs to prevent guest-token leakage into csp_violations', async () => {
    env.CSP_VIOLATIONS_PERSIST = 'true';
    const { POST } = await loadRoute();

    const report = {
      'violated-directive': 'img-src',
      // Guest-token-carrying URL — the path is fine to persist, the
      // ?token=... is PII-adjacent and must be stripped.
      'document-uri':
        'https://evenquote.com/get-quotes/claim?token=00000000-0000-0000-0000-000000000000',
      'blocked-uri': 'https://third-party.example/px.gif?uid=abc123&sid=def456',
      'referrer': 'https://facebook.com/?fbclid=xyz',
    };
    await POST(postJson({ 'csp-report': report }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertedRows.length).toBe(1);
    const row = insertedRows[0];
    expect(row.document_uri).toBe('https://evenquote.com/get-quotes/claim');
    expect(row.blocked_uri).toBe('https://third-party.example/px.gif');
    expect(row.referrer).toBe('https://facebook.com/');

    // Defense-in-depth: no persisted value contains a `?` or the
    // guest token characters (simplest check — if any URL keeps its
    // query, something went wrong).
    for (const v of Object.values(row)) {
      if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
        expect(v.includes('?')).toBe(false);
      }
    }
  });

  it('persistViolation() preserves bare CSP keyword values (inline/eval/data:) without misinterpreting as URLs', async () => {
    env.CSP_VIOLATIONS_PERSIST = 'true';
    const { POST } = await loadRoute();

    const report = {
      'violated-directive': 'script-src',
      'blocked-uri': 'inline',
      'document-uri': 'https://evenquote.com/x',
    };
    await POST(postJson({ 'csp-report': report }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertedRows.length).toBe(1);
    expect(insertedRows[0].blocked_uri).toBe('inline');

    insertedRows.length = 0;
    warn.mockReset();
    await POST(
      postJson({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'eval',
          'document-uri': 'https://evenquote.com/x',
        },
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(insertedRows[0].blocked_uri).toBe('eval');
  });

  it('persistViolation() bounds original_policy to 4096 chars (no unbounded policy dumps)', async () => {
    env.CSP_VIOLATIONS_PERSIST = 'true';
    const { POST } = await loadRoute();

    const hugePolicy = 'default-src ' + 'a'.repeat(8000);
    await POST(
      postJson({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'inline',
          'original-policy': hugePolicy,
        },
      })
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertedRows.length).toBe(1);
    const op = insertedRows[0].original_policy as string;
    expect(op.length).toBe(4096);
    expect(op.startsWith('default-src ')).toBe(true);
  });

  it('persistViolation() does NOT persist the raw report body — only the 6 curated columns', async () => {
    env.CSP_VIOLATIONS_PERSIST = 'true';
    const { POST } = await loadRoute();

    await POST(
      postJson({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'inline',
          // The field below would carry user input if a script-sample
          // landed in a CSP-violation report under certain Chrome
          // builds. Must NOT be persisted.
          'script-sample': '(function(){ return secret_user_input })',
          // Same concern for any other freeform field the browser
          // might send in future spec revs.
          'extra-freeform': 'unexpected-data',
        },
      })
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(insertedRows.length).toBe(1);
    const row = insertedRows[0];
    // No `script_sample` / `extra_freeform` columns.
    expect(Object.keys(row)).not.toContain('script_sample');
    expect(Object.keys(row)).not.toContain('extra_freeform');
    expect(Object.keys(row)).not.toContain('raw');
    expect(Object.keys(row)).not.toContain('body');
  });

  // ── Persist env-gate anchor ─────────────────────────────────────
  it('persistViolation() is env-gated — no inserts fire when CSP_VIOLATIONS_PERSIST is unset / false', async () => {
    // Lock the "collection window" design. If a future refactor
    // turns persistence into the default, all csp_violations rows
    // would stream into Postgres even outside deliberate collection
    // windows, which we've treated as PII-adjacent storage.
    const { POST } = await loadRoute();

    // Unset.
    await POST(
      postJson({
        'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(insertedRows.length).toBe(0);

    // Explicit false.
    env.CSP_VIOLATIONS_PERSIST = 'false';
    await POST(
      postJson({
        'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(insertedRows.length).toBe(0);

    // Mixed-case / whitespace accidents must also be off.
    env.CSP_VIOLATIONS_PERSIST = ' TRUE ';
    await POST(
      postJson({
        'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    // The route lowercases but does NOT trim. Whitespace-wrapped
    // 'TRUE' is off. Lock that strictness.
    expect(insertedRows.length).toBe(0);
  });

  // ── summarize() value normalization lock ────────────────────────
  it('summarize() reduces URLs to host but keeps bare keywords verbatim (lock for dashboard consumers)', async () => {
    const { POST } = await loadRoute();

    await POST(
      postJson({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'https://tracker.example/a.js?q=1',
          'document-uri': 'https://evenquote.com/some-path?token=xyz',
          'source-file': 'https://evenquote.com/_next/static/chunk-abc.js',
        },
      })
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const ctx = warn.mock.calls[0][1];
    expect(ctx.blocked).toBe('tracker.example');
    expect(ctx.document).toBe('evenquote.com');
    expect(ctx.source).toBe('evenquote.com');

    // Bare keywords pass through verbatim.
    warn.mockReset();
    await POST(
      postJson({
        'csp-report': {
          'violated-directive': 'script-src',
          'blocked-uri': 'inline',
          'document-uri': 'https://evenquote.com/x',
        },
      })
    );
    expect(warn.mock.calls[0][1].blocked).toBe('inline');
  });

  it('summarize() defaults directive to violated-directive, falls back to effective-directive, else "unknown"', async () => {
    const { POST } = await loadRoute();

    // Violated preferred.
    await POST(
      postJson({
        'csp-report': {
          'violated-directive': 'script-src',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'inline',
        },
      })
    );
    expect(warn.mock.calls[0][1].directive).toBe('script-src');

    // Effective fallback.
    warn.mockReset();
    await POST(
      postJson({
        'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'inline' },
      })
    );
    expect(warn.mock.calls[0][1].directive).toBe('img-src');

    // Unknown fallback.
    warn.mockReset();
    await POST(postJson({ 'csp-report': { 'blocked-uri': 'inline' } }));
    expect(warn.mock.calls[0][1].directive).toBe('unknown');
  });
});
