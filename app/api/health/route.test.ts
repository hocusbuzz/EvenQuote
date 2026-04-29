// Tests for /api/health.
//
// We stub the admin client so the handler's DB probe is deterministic in
// both success and failure cases. The feature-flags section is driven
// purely off process.env, so we set/unset env vars directly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Simple stub shape: .from().select() returns a promise with { error }.
function buildAdminStub(opts: { dbError?: string }) {
  return {
    from: () => ({
      select: () =>
        Promise.resolve({
          error: opts.dbError ? { message: opts.dbError } : null,
        }),
    }),
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => buildAdminStub({}),
}));

// R33 audit: this route deliberately does NOT wire captureException
// (see route.ts comment block for reasoning — polling-frequency flood,
// redundant with /api/status + uptime dashboards, R29 config-state,
// R26 no-double-capture). The observability-contract block at the
// bottom of this file locks that no-capture contract across every
// documented input shape.
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

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.resetModules();
    // Default to every feature in simulation mode so the assertion doesn't
    // depend on the dev machine's .env.local.
    //
    // R47.4b: featureReadiness() requires the FULL credential set per
    // integration. Per-test leak protection has to clear every key that
    // would flip a verdict, not just the canary.
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.VAPI_API_KEY;
    delete process.env.VAPI_ASSISTANT_ID;
    delete process.env.VAPI_PHONE_NUMBER_ID;
    delete process.env.VAPI_WEBHOOK_SECRET;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    // Minimum vars createAdminClient() needs before the stub kicks in.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_test_key_value';
  });

  it('returns 200 with ok=true when DB is reachable', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe('ok');
  });

  it('returns 503 when DB probe fails', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({ dbError: 'connection refused' }),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.db).toBe('fail');
  });

  it('reports feature integrations as simulation when env missing', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.features.stripe).toBe('simulation');
    expect(body.features.vapi).toBe('simulation');
    expect(body.features.resend).toBe('simulation');
    expect(body.features.anthropic).toBe('simulation');
  });

  it('reports features as configured when env set', async () => {
    // R47.4b: each integration's "configured" verdict requires the
    // FULL credential set, not just one canary key. Stripe needs
    // both its keys, Vapi needs all four, Resend needs key+from.
    // Anthropic remains a single key. Drift between this test and
    // lib/env.ts featureReadiness() is locked by the audit; if you
    // tweak one, tweak both.
    process.env.STRIPE_SECRET_KEY = 'sk_test_value';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_value';
    process.env.VAPI_API_KEY = 'vapi_value';
    process.env.VAPI_ASSISTANT_ID = 'asst_value';
    process.env.VAPI_PHONE_NUMBER_ID = 'pn_value';
    process.env.VAPI_WEBHOOK_SECRET = 'vapi_secret_value';
    process.env.RESEND_API_KEY = 're_value';
    process.env.RESEND_FROM = 'reports@evenquote.com';
    process.env.ANTHROPIC_API_KEY = 'anth_value';
    process.env.GOOGLE_PLACES_API_KEY = 'AIza_value';
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.features.stripe).toBe('configured');
    expect(body.features.vapi).toBe('configured');
    expect(body.features.resend).toBe('configured');
    expect(body.features.anthropic).toBe('configured');
  });

  it('reports vapi as simulation when only VAPI_API_KEY is set (R47.4b)', async () => {
    // The old check only required VAPI_API_KEY to flip to
    // 'configured', which let a half-configured deploy report
    // green while real outbound calls would fail at dispatch.
    process.env.VAPI_API_KEY = 'vapi_value';
    // Deliberately omit VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID,
    // VAPI_WEBHOOK_SECRET.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.features.vapi).toBe('simulation');
  });

  it('reports observability.sentry as "disabled" when the tracker is a no-op stub', async () => {
    // The sentry module is a stub today — @sentry/nextjs isn't
    // installed and SENTRY_DSN isn't read. `isEnabled()` returns
    // `false`, so health must surface 'disabled'. When the DSN lands
    // and init() flips `_enabled = true`, this assertion will need to
    // be gated on env — but that's a deliberate change, and this
    // lockdown forces us to think about the transition.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.observability).toBeDefined();
    expect(body.observability.sentry).toBe('disabled');
  });

  it('sets no-store Cache-Control so monitors never hit a cached response', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('HEAD mirrors GET status code but returns no body', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    const res = await mod.HEAD();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('HEAD returns 503 with no body when DB probe fails', async () => {
    // Locks the contract that HEAD failure semantics match GET — a
    // load balancer doing HEAD-only probes should still see the 503
    // when the DB is unreachable, and never receive a body that
    // would trip a body-length-aware proxy.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({ dbError: 'connection refused' }),
    }));
    const mod = await import('./route');
    const res = await mod.HEAD();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe('');
    // Cache-Control must still be present on HEAD so intermediate
    // proxies don't cache the 503 between probes.
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

// Response-envelope invariants — mirrors the pattern used in the
// /api/cron/* and /api/status route tests. /api/health has no auth
// gate (it's a public liveness probe) and no `error` field in its
// body (failures are signalled through `checks.db` + HTTP status),
// so the invariant set is smaller than /api/status. What we DO lock:
//   1. Every outcome has a top-level `ok: boolean`.
//   2. `ok` agrees with HTTP status class.
//   3. Every outcome exposes `checks.db` with a known outcome.
//   4. No body field leaks a stack trace (including nested checks /
//      features objects — a future "helpfully include err.stack in
//      checks" regression trips here).
describe('response envelope invariants — /api/health', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.VAPI_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_test_key_value';
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{ label: string; status: number; body: Record<string, unknown> }> = [];

    // 1. Happy — DB check ok → 200.
    {
      vi.resetModules();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildAdminStub({}),
      }));
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({ label: 'happy', status: res.status, body: await res.json() });
    }

    // 2. DB fail → 503.
    {
      vi.resetModules();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildAdminStub({ dbError: 'connection refused' }),
      }));
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({ label: 'db-fail', status: res.status, body: await res.json() });
    }

    // 3. DB probe throws (e.g. client constructor dies) → 503.
    {
      vi.resetModules();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => {
          throw new Error('admin client init failed');
        },
      }));
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({ label: 'db-throws', status: res.status, body: await res.json() });
    }

    return outcomes;
  }

  it('every outcome has a top-level `ok: boolean`', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      expect(typeof o.body.ok, `${o.label} missing ok`).toBe('boolean');
    }
  });

  it('ok flag agrees with the HTTP status class', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      const is2xx = o.status >= 200 && o.status < 300;
      expect(o.body.ok, `${o.label} ok=${o.body.ok} vs status=${o.status}`).toBe(is2xx);
    }
  });

  it('every outcome reports a known `checks.db` value', async () => {
    const outcomes = await collectAllOutcomes();
    const allowed = new Set(['ok', 'fail', 'skip']);
    for (const o of outcomes) {
      const checks = o.body.checks as Record<string, unknown> | undefined;
      expect(checks, `${o.label} missing checks`).toBeTruthy();
      expect(allowed.has(checks!.db as string), `${o.label} checks.db=${checks!.db}`).toBe(true);
    }
  });

  it('ok:false outcomes report checks.db="fail"', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      if (o.body.ok === false) {
        const checks = o.body.checks as Record<string, unknown>;
        expect(checks.db, `${o.label} ok:false but db not fail`).toBe('fail');
      }
    }
  });

  it('no outcome leaks a stack trace in any body field', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      const serialized = JSON.stringify(o.body);
      expect(serialized.includes('    at '), `${o.label} leaked stack`).toBe(false);
    }
  });

  it('every outcome reports `observability.sentry` as a known state', async () => {
    // Even on the DB-fail path we still report observability — health
    // should always surface whether the error tracker is receiving.
    // That way an operator debugging a 503 can tell at a glance
    // whether the outage would have paged them in Sentry.
    const outcomes = await collectAllOutcomes();
    const allowed = new Set(['enabled', 'disabled']);
    for (const o of outcomes) {
      const obs = o.body.observability as Record<string, unknown> | undefined;
      expect(obs, `${o.label} missing observability`).toBeTruthy();
      expect(allowed.has(obs!.sentry as string), `${o.label} sentry=${obs!.sentry}`).toBe(true);
    }
  });
});

// R33 observability-contract attestation — the health route is a
// probe endpoint polled at uptime-monitor frequency. Capturing any
// path here would flood Sentry at per-probe rate on a real outage,
// duplicate the signal that uptime dashboards already surface, and
// overlap with /api/status which DOES capture at cron frequency.
// Route header comment explains the four reasons. This block ensures
// every documented input shape still surfaces ZERO capture events.
//
// Canonical pattern: app/api/csp-report/route.test.ts
// "observability contract — no capture" block (R32).
//
// Future maintainer note: if you need to add a captureException here
// (e.g. "the DB has been down for 5 minutes and we want a wake-up"),
// prefer fixing /api/status or adding a rate-limited in-memory gate
// rather than reaching for captureException at probe frequency. If
// you do decide to wire it, update BOTH this file and route.ts with
// a justification comment on the new capture site.
describe('observability contract — no capture', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.VAPI_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_test_key_value';
  });

  it('never captures on the happy-path GET', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    await mod.GET();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when the DB probe returns an error result', async () => {
    // A real DB outage polled by 3 uptime monitors × 60s × 10 min
    // would mean 30+ Sentry events for the same root cause. No
    // additive signal over the uptime dashboard.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({ dbError: 'connection refused' }),
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    expect(res.status).toBe(503);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when createAdminClient throws (deploy-time config state)', async () => {
    // R29 pattern: missing SUPABASE env → throws at construct time →
    // deploy-time config state, not a runtime incident. Every single
    // probe during a misconfig window would fire a capture.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => {
        throw new Error('SUPABASE_URL missing');
      },
    }));
    const mod = await import('./route');
    const res = await mod.GET();
    expect(res.status).toBe(503);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures on the HEAD path (load-balancer probe)', async () => {
    // HEAD is what ALB / Cloudflare / Vercel LB send. Usually higher
    // frequency than GET. Same contract applies.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    await mod.HEAD();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures on HEAD when DB probe fails', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({ dbError: 'connection refused' }),
    }));
    const mod = await import('./route');
    const res = await mod.HEAD();
    expect(res.status).toBe(503);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures regardless of feature-env permutation', async () => {
    // reportFeatures() reads 4 env vars. There is no throw surface,
    // but a future refactor that e.g. validates key shapes could add
    // one. This test locks the no-capture contract across the full
    // configured/simulation cross-product.
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.VAPI_API_KEY = 'vapi_x';
    process.env.RESEND_API_KEY = 're_x';
    process.env.ANTHROPIC_API_KEY = 'anth_x';
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({}),
    }));
    const mod = await import('./route');
    await mod.GET();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});
