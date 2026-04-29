// Tests for /api/csp-report.
//
// Three concerns:
//   • Always returns 204 (browsers don't read the body).
//   • Accepts both `report-uri` and `report-to` body shapes.
//   • Surfaces a summary log line per violation; only logs the full
//     payload when LOG_FULL_CSP=true.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// R32 audit: this route deliberately does NOT wire captureException
// (see route.ts comment block for the four reasons). We still mock
// the observability module so the regression-guard tests at the
// bottom of this file can assert the spy was never called on any
// input-shape the route handles.
const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) => captureExceptionMock(err, ctx),
  captureMessage: (msg: string, level?: string, ctx?: unknown) =>
    captureMessageMock(msg, level, ctx),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
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

describe('/api/csp-report', () => {
  beforeEach(() => {
    vi.resetModules();
    warn.mockReset();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
    delete env.LOG_FULL_CSP;
  });

  it('returns 204 for a valid report-uri payload', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson({
        'csp-report': {
          'document-uri': 'https://evenquote.com/login',
          'violated-directive': "script-src 'self'",
          'blocked-uri': 'https://attacker.example/bad.js',
        },
      })
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = warn.mock.calls[0];
    expect(msg).toBe('csp violation');
    expect(ctx.directive).toMatch(/script-src/);
    expect(ctx.blocked).toBe('attacker.example');
    expect(ctx.full).toBeUndefined();
  });

  it('accepts the report-to (array) body shape', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson([
        {
          type: 'csp-violation',
          body: {
            'document-uri': 'https://evenquote.com/dashboard',
            'effective-directive': 'style-src',
            'blocked-uri': 'inline',
          },
        },
      ])
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1].directive).toBe('style-src');
    // 'inline' is a keyword (not a URL) — should be passed through as-is.
    expect(warn.mock.calls[0][1].blocked).toBe('inline');
  });

  it('returns 204 silently for malformed JSON', async () => {
    const { POST } = await loadRoute();
    const res = await POST(postJson('not-json{{{'));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns 204 silently for unrecognised body shapes', async () => {
    const { POST } = await loadRoute();
    const res = await POST(postJson({ unrelated: 'shape' }));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs the full payload only when LOG_FULL_CSP=true', async () => {
    env.LOG_FULL_CSP = 'true';
    const { POST } = await loadRoute();
    const fullReport = {
      'document-uri': 'https://evenquote.com/x',
      'violated-directive': "img-src 'self'",
      'blocked-uri': 'https://tracker.example/p.gif',
      'source-file': 'https://evenquote.com/_next/static/chunks/app.js',
      'line-number': 42,
    };
    const res = await POST(postJson({ 'csp-report': fullReport }));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1].full).toEqual(fullReport);
  });

  it('coalesces multiple report-to entries into individual log lines', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson([
        { type: 'csp-violation', body: { 'violated-directive': 'a', 'blocked-uri': 'inline' } },
        { type: 'csp-violation', body: { 'violated-directive': 'b', 'blocked-uri': 'eval' } },
        // Filtered out — wrong type.
        { type: 'network-error', body: { foo: 'bar' } },
      ])
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('handles a non-URL blocked-uri ("eval") without throwing', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson({
        'csp-report': {
          'violated-directive': "script-src",
          'blocked-uri': 'eval',
        },
      })
    );
    expect(res.status).toBe(204);
    expect(warn.mock.calls[0][1].blocked).toBe('eval');
  });

  // ────────── Envelope invariants ──────────
  //
  // These tests lock the contract the CSP Report-Only window actually
  // depends on. The route is the ingestion point the browser POSTs
  // violations to — if any of these break, reports will either stop
  // flowing (blind spot) or start leaking data we don't want in the
  // log stream (privacy regression). Intentionally tight.

  describe('response envelope invariants', () => {
    it('always returns 204 No Content — never 200 with a body', async () => {
      const { POST } = await loadRoute();
      // The browser ignores the body. 200 with a body costs bytes and
      // trains an attacker's fuzzer that there's something to probe.
      // Spec-correct is 204. Lock it.
      const cases = [
        { 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'inline' } },
        [{ type: 'csp-violation', body: { 'violated-directive': 'x' } }],
        { unrelated: 'shape' },
        '{{{',
      ];
      for (const body of cases) {
        const res = await POST(postJson(body));
        expect(res.status).toBe(204);
        // 204 MUST NOT carry a body per RFC 7230 §3.3.3.
        const text = await res.text();
        expect(text).toBe('');
      }
    });

    it('never throws past the handler (a network-error object is not a CSP violation)', async () => {
      const { POST } = await loadRoute();
      // Reporting API v1 coalesced report-to targets — clients sometimes
      // send network-error reports alongside csp-violation. The route
      // must drop them without throwing.
      const res = await POST(
        postJson([
          { type: 'network-error', body: { type: 'http.error' } },
          { type: 'deprecation', body: { message: 'foo' } },
        ])
      );
      expect(res.status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    });

    it('tolerates a completely empty POST body (some browsers send this)', async () => {
      const { POST } = await loadRoute();
      // Edge / Firefox have been observed sending zero-length bodies
      // under certain policy configs. Must not 500.
      const req = new Request('https://example.com/api/csp-report', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: '',
      });
      const res = await POST(req);
      expect(res.status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    });

    it('PII hygiene: URL paths are stripped to the host in summary logs', async () => {
      const { POST } = await loadRoute();
      // Guest flows carry UUIDs in the path. A summary log line must NOT
      // include the path segment — only the host. The route's `hostOf()`
      // helper enforces this.
      const res = await POST(
        postJson({
          'csp-report': {
            'document-uri':
              'https://evenquote.com/get-quotes/claim?token=9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
            'violated-directive': 'script-src',
            'blocked-uri':
              'https://pixel.tracker.example/p/user-abc123/beacon.gif',
          },
        })
      );
      expect(res.status).toBe(204);
      const ctx = warn.mock.calls[0][1];
      // The host only — never the path, never the query string.
      expect(ctx.document).toBe('evenquote.com');
      expect(ctx.blocked).toBe('pixel.tracker.example');
      // Negative assertion: no UUID or token bleed into the summary.
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toMatch(/9a8b7c6d/);
      expect(serialized).not.toMatch(/user-abc123/);
      expect(serialized).not.toMatch(/get-quotes/);
    });

    it('PII hygiene: the full payload is NEVER logged when LOG_FULL_CSP is unset', async () => {
      // This is the single most important invariant in the file.
      // Explicit because "default off" was a conscious choice in the
      // handler's comment block; a refactor could easily invert it.
      const { POST } = await loadRoute();
      expect(env.LOG_FULL_CSP).toBeUndefined();
      await POST(
        postJson({
          'csp-report': {
            'document-uri': 'https://evenquote.com/x?email=a@b.com',
            'violated-directive': 'script-src',
            'blocked-uri': 'inline',
            'script-sample': 'console.log("secret="+window.token)',
          },
        })
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const ctx = warn.mock.calls[0][1];
      expect(ctx.full).toBeUndefined();
      // Sample text must not bleed via any key in the summary.
      const serialized = JSON.stringify(ctx);
      expect(serialized).not.toMatch(/console\.log/);
      expect(serialized).not.toMatch(/a@b\.com/);
    });

    it('LOG_FULL_CSP accepts only "true" case-insensitively — off for other truthy values', async () => {
      // Guard against a common footgun: setting LOG_FULL_CSP=1 or =yes
      // and *thinking* full logging is enabled while it quietly isn't
      // (or worse — a future maintainer loosening the check and
      // flipping the default).
      //
      // The handler does `(env ?? '').toLowerCase() === 'true'`. That
      // means 'true' and 'TRUE' and 'TrUe' all enable full logging
      // (intentional: ENV vars from different shells can arrive any-
      // case), but '1', 'yes', and ' true ' (whitespace-padded) do NOT.
      for (const value of ['1', 'yes', ' true ', 'truthy']) {
        env.LOG_FULL_CSP = value;
        vi.resetModules();
        const { POST } = await loadRoute();
        warn.mockReset();
        await POST(
          postJson({
            'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
          })
        );
        const ctx = warn.mock.calls[0][1];
        expect(ctx.full).toBeUndefined();
      }

      // Positive control: 'TRUE' (exact, case-insensitive match) DOES
      // enable full logging. Locks the "case-insensitive on purpose"
      // decision so a future tightening is a visible change.
      env.LOG_FULL_CSP = 'TRUE';
      vi.resetModules();
      const { POST } = await loadRoute();
      warn.mockReset();
      await POST(
        postJson({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        })
      );
      expect(warn.mock.calls[0][1].full).toBeDefined();

      delete env.LOG_FULL_CSP;
    });

    it('does not expose CORS headers — CSP reports are same-origin only', async () => {
      // If someone accidentally adds Access-Control-Allow-Origin: *,
      // this endpoint becomes a cross-origin log sink any page on the
      // internet can POST to. Worth locking.
      const { POST } = await loadRoute();
      const res = await POST(
        postJson({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        })
      );
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('returns 204 even when body is an array of zero useful reports', async () => {
      // A report-to payload may arrive with only non-CSP entries. The
      // route short-circuits to 204 without logging — which is the
      // correct behavior (nothing to report) and also what we want for
      // a zero-noise guarantee.
      const { POST } = await loadRoute();
      const res = await POST(postJson([] as unknown as object));
      expect(res.status).toBe(204);
      expect(warn).not.toHaveBeenCalled();
    });

    it('returns 413 when content-length exceeds 64 KB ceiling', async () => {
      // Size cap is an early-reject DoS guard. Without it, a rogue
      // POST of a multi-MB "csp-report" body would force the route to
      // read-then-parse megabytes of JSON on every request. Locks the
      // 64 KB ceiling as the contract so a future refactor doesn't
      // silently widen it.
      const { POST } = await loadRoute();
      const req = new Request('https://example.com/api/csp-report', {
        method: 'POST',
        headers: new Headers({
          'content-type': 'application/json',
          // One byte past the 65536-byte ceiling.
          'content-length': String(64 * 1024 + 1),
        }),
        // Body is a tiny stub — the handler must reject on the header
        // before ever reading it.
        body: '{"csp-report":{"violated-directive":"x","blocked-uri":"y"}}',
      });
      const res = await POST(req);
      expect(res.status).toBe(413);
      // 413 response must not leak a body either.
      expect(await res.text()).toBe('');
      // And MUST NOT log — a size attack shouldn't fill the log stream.
      expect(warn).not.toHaveBeenCalled();
    });

    it('accepts content-length at exactly the 64 KB boundary', async () => {
      // The check is strict-greater-than, so exactly 64 KB is still
      // valid. Edge case worth locking.
      const { POST } = await loadRoute();
      const req = new Request('https://example.com/api/csp-report', {
        method: 'POST',
        headers: new Headers({
          'content-type': 'application/json',
          'content-length': String(64 * 1024),
        }),
        body: JSON.stringify({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(204);
    });

    it('accepts requests with no content-length header (chunked transfer)', async () => {
      // Some HTTP clients send Transfer-Encoding: chunked and omit
      // content-length entirely. Don't reject those — fall through to
      // req.json() and let Next's body-reader handle its own limits.
      const { POST } = await loadRoute();
      const req = new Request('https://example.com/api/csp-report', {
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(204);
    });

    it('drops report-to entries with a non-object body without throwing', async () => {
      // Hardened by intent: the normaliser checks `entry.body &&
      // typeof entry.body === 'object'`. A string or null body is
      // skipped. Lock that so a refactor to a looser check (e.g.
      // just truthy) doesn't start forwarding garbage into the logger.
      const { POST } = await loadRoute();
      const res = await POST(
        postJson([
          { type: 'csp-violation', body: 'not-an-object' },
          { type: 'csp-violation', body: null },
          // One valid entry alongside — must still be logged.
          {
            type: 'csp-violation',
            body: { 'violated-directive': 'valid', 'blocked-uri': 'inline' },
          },
        ])
      );
      expect(res.status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1].directive).toBe('valid');
    });

    it('logs a summary even when the report object has no useful fields', async () => {
      // Completely empty `csp-report: {}` is legal spec-wise (a buggy
      // browser could send it). The summariser must NOT throw; it
      // should emit a summary with the documented fallbacks.
      const { POST } = await loadRoute();
      const res = await POST(postJson({ 'csp-report': {} }));
      expect(res.status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      const ctx = warn.mock.calls[0][1];
      // Contract: 'directive' falls back to the literal 'unknown'
      // (not null, not undefined) so alerting / grouping has a stable
      // bucket for "directive missing" instead of noisy splits.
      expect(ctx.directive).toBe('unknown');
      expect(ctx.blocked).toBe('unknown');
      expect(ctx.document).toBe('unknown');
      expect(ctx.line).toBeNull();
    });

    it('prefers violated-directive over effective-directive when both present', async () => {
      // Both fields are spec-valid; in practice older browsers send
      // violated-directive and newer ones send both. Locking
      // precedence prevents a summary from silently switching bucket
      // if the browser ecosystem shifts.
      const { POST } = await loadRoute();
      const res = await POST(
        postJson({
          'csp-report': {
            'violated-directive': 'script-src-attr',
            'effective-directive': 'script-src',
            'blocked-uri': 'inline',
          },
        })
      );
      expect(res.status).toBe(204);
      expect(warn.mock.calls[0][1].directive).toBe('script-src-attr');
    });
  });

  // ── Persistence gate (CSP_VIOLATIONS_PERSIST) ────────────────────
  //
  // During the Report-Only → Enforce rollout window, violation rows
  // land in the csp_violations Supabase table (migration 0009) so
  // scripts/analyze-csp-reports.ts can group them. The gate keeps the
  // default OFF — PII-adjacent storage should only exist during an
  // intentional collection window.
  //
  // What we lock here:
  //   • Default (unset): NO insert. Logging still fires.
  //   • =true: exactly ONE insert per violation, with query-strings
  //     stripped from blocked_uri / document_uri / referrer.
  //   • Insert failure must NOT 5xx the browser — it silently logs
  //     and returns 204.
  describe('persistence gate', () => {
    type InsertCall = { table: string; row: Record<string, unknown> };
    const inserts: InsertCall[] = [];
    type InsertResult = { error: null | { message: string } };
    const insertFn = vi.fn(
      async (): Promise<InsertResult> => ({ error: null })
    );

    beforeEach(() => {
      vi.resetModules();
      inserts.length = 0;
      insertFn.mockReset();
      insertFn.mockResolvedValue({ error: null });
      delete env.CSP_VIOLATIONS_PERSIST;
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => ({
          from: (table: string) => ({
            insert: (row: Record<string, unknown>) => {
              inserts.push({ table, row });
              return insertFn();
            },
          }),
        }),
      }));
    });

    it('does NOT insert when CSP_VIOLATIONS_PERSIST is unset', async () => {
      const { POST } = await loadRoute();
      await POST(
        postJson({
          'csp-report': {
            'document-uri': 'https://evenquote.com/x',
            'violated-directive': 'script-src',
            'blocked-uri': 'inline',
          },
        })
      );
      expect(inserts).toHaveLength(0);
      expect(insertFn).not.toHaveBeenCalled();
    });

    it('does NOT insert for other truthy values (1, yes, " true ")', async () => {
      for (const value of ['1', 'yes', ' true ', 'truthy']) {
        env.CSP_VIOLATIONS_PERSIST = value;
        vi.resetModules();
        const { POST } = await loadRoute();
        await POST(
          postJson({
            'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
          })
        );
      }
      expect(inserts).toHaveLength(0);
      delete env.CSP_VIOLATIONS_PERSIST;
    });

    it('inserts exactly one row per violation when =true', async () => {
      env.CSP_VIOLATIONS_PERSIST = 'true';
      vi.resetModules();
      const { POST } = await loadRoute();
      const res = await POST(
        postJson({
          'csp-report': {
            'document-uri': 'https://evenquote.com/x',
            'violated-directive': 'script-src',
            'blocked-uri': 'inline',
          },
        })
      );
      expect(res.status).toBe(204);
      // Await a microtask so the fire-and-forget `void persistViolation`
      // finishes before we assert.
      await new Promise((r) => setImmediate(r));
      expect(inserts).toHaveLength(1);
      expect(inserts[0].table).toBe('csp_violations');
      expect(inserts[0].row.violated_directive).toBe('script-src');
      expect(inserts[0].row.blocked_uri).toBe('inline');
      delete env.CSP_VIOLATIONS_PERSIST;
    });

    it('strips query strings from blocked_uri / document_uri / referrer', async () => {
      env.CSP_VIOLATIONS_PERSIST = 'true';
      vi.resetModules();
      const { POST } = await loadRoute();
      await POST(
        postJson({
          'csp-report': {
            'document-uri': 'https://evenquote.com/q/claim?token=9a8b7c6d',
            'violated-directive': 'script-src',
            'blocked-uri': 'https://pixel.example/p?user=abc123&trk=xyz',
            'referrer': 'https://evenquote.com/pay?sid=xyz',
          },
        })
      );
      await new Promise((r) => setImmediate(r));
      expect(inserts).toHaveLength(1);
      const row = inserts[0].row as Record<string, string>;
      // Paths preserved (useful for directive tuning); query stripped.
      expect(row.document_uri).toBe('https://evenquote.com/q/claim');
      expect(row.blocked_uri).toBe('https://pixel.example/p');
      expect(row.referrer).toBe('https://evenquote.com/pay');
      // PII-token negative-assertions — the token/user/sid values must
      // not survive into any column.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toMatch(/9a8b7c6d/);
      expect(serialized).not.toMatch(/user=abc123/);
      expect(serialized).not.toMatch(/sid=xyz/);
      delete env.CSP_VIOLATIONS_PERSIST;
    });

    it('swallows DB insert errors — returns 204 and does not throw', async () => {
      env.CSP_VIOLATIONS_PERSIST = 'true';
      insertFn.mockResolvedValue({ error: { message: 'boom' } });
      vi.resetModules();
      const { POST } = await loadRoute();
      const res = await POST(
        postJson({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        })
      );
      expect(res.status).toBe(204);
      await new Promise((r) => setImmediate(r));
      // The violation log still fired at warn level; the persist
      // failure added a SECOND warn. Both are correct.
      expect(warn.mock.calls.length).toBeGreaterThanOrEqual(1);
      delete env.CSP_VIOLATIONS_PERSIST;
    });
  });

  // ── Observability contract lock (R32 audit) ──────────────────────
  //
  // The csp-report route is a security-telemetry SINK — it ingests
  // browser-reported violations and forwards them to the log drain
  // (+ optionally a persistence table during rollout windows). It is
  // part of the observability pipeline, not a participant in it.
  // Wrapping it in Sentry capture would:
  //   (a) fire at browser-violation frequency during rollout windows
  //       (hundreds per page load on ad-heavy pages) — Sentry flood,
  //   (b) flood on browser garbage (empty bodies, network-error
  //       coalesced reports, malformed JSON),
  //   (c) loop when Sentry itself CSPs or otherwise drops — creating
  //       an observability black hole.
  //
  // Route.ts has the full reasoning in a comment block. This suite
  // locks the decision so a future maintainer adding captureException
  // has a visible, failing test — and must update BOTH this file and
  // route.ts to proceed. If that happens, add a comment justifying
  // the new capture site (e.g. "path X is genuinely silent and fires
  // at bounded rate on real incidents only").
  describe('observability contract — no capture', () => {
    const noCaptureInputs: Array<[string, unknown]> = [
      [
        'well-formed report-uri payload',
        {
          'csp-report': {
            'document-uri': 'https://evenquote.com/x',
            'violated-directive': 'script-src',
            'blocked-uri': 'inline',
          },
        },
      ],
      [
        'report-to array payload',
        [{ type: 'csp-violation', body: { 'violated-directive': 'x', 'blocked-uri': 'eval' } }],
      ],
      [
        'empty csp-report body',
        { 'csp-report': {} },
      ],
      [
        'unrecognised body shape',
        { unrelated: 'shape' },
      ],
      [
        'array of non-CSP entries only',
        [
          { type: 'network-error', body: { type: 'http.error' } },
          { type: 'deprecation', body: { message: 'foo' } },
        ],
      ],
      [
        'empty array',
        [] as unknown as object,
      ],
      [
        'malformed JSON',
        'not-json{{{',
      ],
    ];

    for (const [label, body] of noCaptureInputs) {
      it(`never captures on: ${label}`, async () => {
        const { POST } = await loadRoute();
        await POST(postJson(body));
        expect(captureExceptionMock).not.toHaveBeenCalled();
        expect(captureMessageMock).not.toHaveBeenCalled();
      });
    }

    it('never captures when persistViolation DB insert errors during a rollout window', async () => {
      // The single most likely future regression — a "safety net"
      // captureException added around the persist failure path. This
      // test is the first place it breaks. Rationale: during a rollout
      // window with persistence failing, the log drain already has the
      // signal and capturing per-violation would flood.
      env.CSP_VIOLATIONS_PERSIST = 'true';
      const insertFn = vi.fn().mockResolvedValue({ error: { message: 'boom' } });
      vi.resetModules();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => ({
          from: () => ({ insert: () => insertFn() }),
        }),
      }));
      const { POST } = await loadRoute();
      await POST(
        postJson({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        })
      );
      await new Promise((r) => setImmediate(r));
      expect(insertFn).toHaveBeenCalled();
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(captureMessageMock).not.toHaveBeenCalled();
      delete env.CSP_VIOLATIONS_PERSIST;
    });

    it('never captures when createAdminClient throws (deploy-time config state)', async () => {
      // R29 pattern: missing env → createAdminClient throws → this is
      // deploy-time config state not a runtime incident. Capturing here
      // would flood Sentry on every request during a misconfig window.
      // Log.warn is the single signal.
      env.CSP_VIOLATIONS_PERSIST = 'true';
      vi.resetModules();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => {
          throw new Error('SUPABASE_URL missing');
        },
      }));
      const { POST } = await loadRoute();
      const res = await POST(
        postJson({
          'csp-report': { 'violated-directive': 'x', 'blocked-uri': 'inline' },
        })
      );
      expect(res.status).toBe(204);
      await new Promise((r) => setImmediate(r));
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(captureMessageMock).not.toHaveBeenCalled();
      delete env.CSP_VIOLATIONS_PERSIST;
    });

    it('payload exceeding 64 KB does NOT capture (size-attack guard)', async () => {
      // A payload-too-large attempt should be rejected silently. Any
      // capture here would turn the size-cap into a Sentry amplifier.
      const { POST } = await loadRoute();
      const req = new Request('https://example.com/api/csp-report', {
        method: 'POST',
        headers: new Headers({
          'content-type': 'application/json',
          'content-length': String(64 * 1024 + 1),
        }),
        body: '{}',
      });
      await POST(req);
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(captureMessageMock).not.toHaveBeenCalled();
    });
  });
});
