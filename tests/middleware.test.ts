// Tests for the root middleware.ts — specifically the maintenance-mode gate.
//
// The gate is configured via two env vars:
//   • MAINTENANCE_MODE='true' enables the gate.
//   • MAINTENANCE_PREVIEW_TOKEN (optional) lets the operator bypass with
//     `?preview=<token>`.
//
// When the gate is on we expect:
//   • Allowlisted paths (webhooks, cron, /maintenance, _next internals) to
//     pass through untouched — otherwise Stripe retries pile up.
//   • Everything else to be rewritten to /maintenance.
//   • A correct `?preview=<token>` to issue a cookie and strip the query.
//   • A request carrying the bypass cookie to pass through normally.
//
// We stub `@/lib/supabase/middleware` so updateSession() just returns a
// marker response — we care only about the maintenance routing decision
// here, not the session-refresh behaviour (covered in a sibling test).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

function makeReq(path: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new Request(`https://example.com${path}`));
  for (const [k, v] of Object.entries(cookies)) {
    req.cookies.set(k, v);
  }
  return req;
}

describe('middleware.ts — maintenance-mode gate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Ensure a clean slate per-test
    delete process.env.MAINTENANCE_MODE;
    delete process.env.MAINTENANCE_PREVIEW_TOKEN;

    vi.doMock('@/lib/supabase/middleware', () => ({
      updateSession: vi.fn(async () => {
        const res = NextResponse.next();
        res.headers.set('x-test-passthrough', '1');
        return res;
      }),
    }));
  });

  it('passes through every request when MAINTENANCE_MODE is off', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/'));
    // updateSession returned NextResponse.next() with our marker
    expect(res.headers.get('x-test-passthrough')).toBe('1');
  });

  it('rewrites an ordinary path to /maintenance when the gate is on', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/pricing'));
    // Rewrites carry an x-middleware-rewrite header in Next — we just
    // check we did not pass through to updateSession.
    expect(res.headers.get('x-test-passthrough')).toBeNull();
    const rewrite = res.headers.get('x-middleware-rewrite');
    expect(rewrite).toBeTruthy();
    expect(rewrite).toContain('/maintenance');
  });

  it('lets webhook paths through the maintenance gate (Stripe, Vapi, cron)', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const { middleware } = await import('../middleware');

    for (const path of [
      '/api/stripe/webhook',
      '/api/vapi/webhook',
      '/api/cron/send-reports',
      '/api/cron/retry-failed-calls',
      '/maintenance',
      '/favicon.ico',
      '/robots.txt',
    ]) {
      const res = await middleware(makeReq(path));
      expect(
        res.headers.get('x-test-passthrough'),
        `expected ${path} to pass through`
      ).toBe('1');
    }
  });

  it('honours ?preview=<token> by setting the bypass cookie and redirecting without the query', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_PREVIEW_TOKEN = 'secret-preview-1';
    const { middleware } = await import('../middleware');

    const res = await middleware(makeReq('/pricing?preview=secret-preview-1'));
    // Redirect to the clean URL
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/pricing');
    expect(loc).not.toContain('preview=');
    // Cookie set
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('eq_maint_bypass=secret-preview-1');
    expect(setCookie.toLowerCase()).toContain('httponly');
  });

  it('passes through when the bypass cookie is present and valid', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_PREVIEW_TOKEN = 'secret-preview-2';
    const { middleware } = await import('../middleware');

    const res = await middleware(
      makeReq('/pricing', { eq_maint_bypass: 'secret-preview-2' })
    );
    expect(res.headers.get('x-test-passthrough')).toBe('1');
  });

  it('does not pass through when the bypass cookie is wrong', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_PREVIEW_TOKEN = 'secret-preview-3';
    const { middleware } = await import('../middleware');

    const res = await middleware(
      makeReq('/pricing', { eq_maint_bypass: 'not-the-right-one' })
    );
    // No passthrough, instead a rewrite to /maintenance
    expect(res.headers.get('x-test-passthrough')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
  });

  it('ignores a ?preview= query that does not match MAINTENANCE_PREVIEW_TOKEN', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_PREVIEW_TOKEN = 'secret-preview-4';
    const { middleware } = await import('../middleware');

    const res = await middleware(makeReq('/pricing?preview=wrong'));
    // No cookie, no redirect — just the maintenance rewrite.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
  });
});

// ─── CSP nonce middleware (Round 9) ───────────────────────────────
//
// The nonce-based CSP is gated behind CSP_NONCE_ENABLED so we can
// flip it on/off without a code change. Default OFF means a regression
// here would be caught by *both* this test (when on) and the
// pre-existing maintenance-gate tests above (when off).
describe('middleware.ts — CSP nonce headers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.MAINTENANCE_MODE;
    delete process.env.CSP_NONCE_ENABLED;
    delete process.env.CSP_ENFORCE;

    vi.doMock('@/lib/supabase/middleware', () => ({
      updateSession: vi.fn(async () => NextResponse.next()),
    }));
  });

  it('does NOT set CSP headers when CSP_NONCE_ENABLED is unset (default off)', async () => {
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/'));
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
    expect(res.headers.get('x-nonce')).toBeNull();
  });

  it('sets the Report-Only header when CSP_NONCE_ENABLED=true and CSP_ENFORCE is unset', async () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/'));

    const reportOnly = res.headers.get('Content-Security-Policy-Report-Only');
    const enforcing = res.headers.get('Content-Security-Policy');

    // Report-only header is present, enforcing header is NOT set —
    // this is the safe rollout posture.
    expect(reportOnly).toBeTruthy();
    expect(enforcing).toBeNull();

    // Sanity-check the policy payload — must contain a nonce that
    // matches the x-nonce header.
    const nonce = res.headers.get('x-nonce');
    expect(nonce).toBeTruthy();
    expect(reportOnly).toContain(`'nonce-${nonce}'`);
    expect(reportOnly).toMatch(/report-uri \/api\/csp-report/);
  });

  it('flips to enforcing header when CSP_ENFORCE=true', async () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    process.env.CSP_ENFORCE = 'true';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/'));
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toBeNull();
  });

  it('produces a fresh nonce per request', async () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    const { middleware } = await import('../middleware');
    const r1 = await middleware(makeReq('/a'));
    const r2 = await middleware(makeReq('/b'));
    const n1 = r1.headers.get('x-nonce');
    const n2 = r2.headers.get('x-nonce');
    expect(n1).toBeTruthy();
    expect(n2).toBeTruthy();
    expect(n1).not.toBe(n2);
  });
});

// ─── Observability contract — no capture (R34 audit) ─────────────
//
// middleware.ts runs on EVERY matched request. A capture call here
// would be multiplied by the traffic firehose. The route header
// comment enumerates five reasons for the no-capture contract:
//   1. Request-frequency flood risk.
//   2. Platform-level instrumentation (Next's instrumentation.ts +
//      @sentry/nextjs middleware wrapper) already captures throws.
//   3. Session-refresh errors are steady-state, not incidents.
//   4. CSP nonce generation + maintenance-mode rewrite are pure.
//   5. Cookie-decode errors are UX signals, not incident signals.
//
// This block locks the no-capture contract across every documented
// middleware input shape. Canonical parent pattern:
// app/api/health/route.test.ts / app/api/version/route.test.ts
// (R33) and app/api/csp-report/route.test.ts (R32).
//
// Future maintainer note: if you add captureException to
// middleware.ts, update BOTH this file and middleware.ts with a
// justification comment on the new capture site.
describe('middleware.ts — observability contract — no capture', () => {
  const originalEnv = { ...process.env };
  const captureExceptionMock = vi.fn();
  const captureMessageMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
    process.env = { ...originalEnv };
    delete process.env.MAINTENANCE_MODE;
    delete process.env.MAINTENANCE_PREVIEW_TOKEN;
    delete process.env.CSP_NONCE_ENABLED;
    delete process.env.CSP_ENFORCE;

    // Stub sentry AND the supabase middleware helper so any throw
    // path in updateSession() doesn't reach a real Supabase client.
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
      captureMessage: (msg: string, level?: string, ctx?: unknown) =>
        captureMessageMock(msg, level, ctx),
      init: vi.fn(),
      isEnabled: () => false,
      setUser: vi.fn(),
      __resetForTests: vi.fn(),
    }));

    vi.doMock('@/lib/supabase/middleware', () => ({
      updateSession: vi.fn(async () => NextResponse.next()),
    }));
  });

  it('never captures on a plain request (default env, no maintenance, no CSP)', async () => {
    const { middleware } = await import('../middleware');
    await middleware(makeReq('/'));
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when the maintenance gate rewrites to /maintenance', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/pricing'));
    expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when ?preview=<token> redirects with a bypass cookie', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_PREVIEW_TOKEN = 'tok-x';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/pricing?preview=tok-x'));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures on webhook/allow-listed paths under maintenance', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const { middleware } = await import('../middleware');
    for (const path of [
      '/api/stripe/webhook',
      '/api/vapi/webhook',
      '/api/cron/send-reports',
      '/api/csp-report',
      '/maintenance',
      '/favicon.ico',
      '/robots.txt',
    ]) {
      await middleware(makeReq(path));
    }
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when CSP_NONCE_ENABLED produces a nonce + Report-Only header', async () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/'));
    expect(res.headers.get('x-nonce')).toBeTruthy();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when CSP_ENFORCE flips to the enforcing header', async () => {
    process.env.CSP_NONCE_ENABLED = 'true';
    process.env.CSP_ENFORCE = 'true';
    const { middleware } = await import('../middleware');
    const res = await middleware(makeReq('/'));
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('source-level: middleware.ts does not try/catch around updateSession (platform owns crashes)', async () => {
    // If updateSession() throws, Next.js + @sentry/nextjs middleware
    // wrapper captures at the platform boundary. Adding a try/catch
    // with captureException inside middleware.ts would double-capture
    // the same throw with a different stack trace (R26 no-double-
    // capture rule).
    //
    // We enforce this at the source level rather than via mocks:
    // runtime-mock approaches here are flaky against Vitest's doMock
    // resolution order across resetModules boundaries. A source-scan
    // is deterministic and catches any future try/catch that wraps
    // updateSession.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const raw = await fs.readFile(
      path.resolve(process.cwd(), 'middleware.ts'),
      'utf8'
    );
    // Strip comments so the header's prose doesn't false-positive.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // The exported middleware() function must await updateSession
    // WITHOUT a try/catch around that await. We grep for the two
    // tell-tale shapes of a wrap: `try` appearing before the call, or
    // `.catch(` chained onto it.
    expect(
      source.includes('.catch('),
      'middleware.ts must not chain .catch() — platform owns the throw'
    ).toBe(false);
    // Cheap heuristic: ensure updateSession is awaited bare, not inside
    // a try block. If a future refactor legitimately needs a try, the
    // maintainer should update this assertion with a justification.
    const awaitMatch = /await\s+updateSession\s*\(/.exec(source);
    expect(awaitMatch, 'expected `await updateSession(` in middleware.ts').not.toBeNull();
    // Look 200 chars of preceding source; forbid a `try {` in that window.
    const idx = awaitMatch!.index;
    const window = source.slice(Math.max(0, idx - 200), idx);
    expect(
      /\btry\s*\{/.test(window),
      'middleware.ts must not wrap updateSession in a try/catch — platform owns the throw'
    ).toBe(false);
  });

  it('never captures when the bypass cookie is malformed', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_PREVIEW_TOKEN = 'tok-x';
    const { middleware } = await import('../middleware');
    // Deliberately malformed / stale cookie value — a common browser-
    // side state. This is a UX signal, not an incident.
    const res = await middleware(
      makeReq('/pricing', { eq_maint_bypass: 'stale-or-malformed-value' })
    );
    expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('source-level grep (comments stripped): no captureException/captureMessage/Sentry import in middleware.ts', async () => {
    // Drift-guard: a future maintainer could add a captureException
    // to middleware.ts that the behavioural tests above miss (e.g.
    // a path not exercised). This source-level scan catches ANY
    // capture wiring — mirrors the R33 lib/security/no-capture-audit
    // pattern.
    //
    // Comments are stripped before scanning because the header
    // comment block deliberately documents the no-capture contract
    // using the forbidden token names. Only the CODE matters.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const raw = await fs.readFile(
      path.resolve(process.cwd(), 'middleware.ts'),
      'utf8'
    );
    // Strip // line comments and /* block comments */ before scanning.
    // Good enough for middleware.ts — no template strings with `//` in
    // user code here. If this grows, lift to a tiny TS-aware helper.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const forbidden = [
      'captureException',
      'captureMessage',
      'Sentry.capture',
      "from '@/lib/observability/sentry'",
      "from '@sentry/nextjs'",
    ];
    for (const token of forbidden) {
      expect(
        source.includes(token),
        `middleware.ts must not contain "${token}" (in code, comments excluded) — see route header observability contract`
      ).toBe(false);
    }
  });
});
