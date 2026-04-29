// Tests for /api/version.
//
// Pure-env-read endpoint, no DB or external calls — tests are about
// shape correctness, env-var handling, and cache-header presence.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// R33 audit: this route deliberately does NOT wire captureException
// (see route.ts comment block — no error paths, probe frequency,
// secrets-boundary simplicity). The observability-contract block at
// the bottom of this file locks that no-capture contract across
// every documented input shape.
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

// process.env keys are typed too narrowly under @types/node 20+
// (NODE_ENV is a literal union); cast through a writable view for the
// mutating paths here. Same pattern Round 6 settled on.
const env = process.env as Record<string, string | undefined>;

describe('GET /api/version', () => {
  beforeEach(() => {
    delete env.VERCEL_GIT_COMMIT_SHA;
    delete env.VERCEL_GIT_COMMIT_REF;
    delete env.VERCEL_ENV;
    delete env.VERCEL_REGION;
    delete env.BUILD_TIME;
    delete env.VERCEL_BUILD_TIME;
  });

  it('returns 200 with the expected shape on a vanilla local run', async () => {
    const mod = await import('./route');
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      commit: 'dev',
      commitShort: 'dev',
      branch: null,
      buildTime: null,
      region: null,
    });
    // environment is computed from NODE_ENV when VERCEL_ENV is unset;
    // vitest defaults NODE_ENV='test', so this lands on 'development'.
    expect(['development', 'production']).toContain(body.environment);
  });

  it('truncates the commit SHA to 7 chars in commitShort, preserves full in commit', async () => {
    env.VERCEL_GIT_COMMIT_SHA = 'abc1234567890def1234567890abcdef12345678';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.commit).toBe('abc1234567890def1234567890abcdef12345678');
    expect(body.commitShort).toBe('abc1234');
  });

  it('returns the branch name when VERCEL_GIT_COMMIT_REF is set', async () => {
    env.VERCEL_GIT_COMMIT_REF = 'feat/new-checkout';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.branch).toBe('feat/new-checkout');
  });

  it('reports VERCEL_ENV when set (production/preview/development)', async () => {
    env.VERCEL_ENV = 'preview';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.environment).toBe('preview');
  });

  it('falls back to NODE_ENV for environment when VERCEL_ENV is missing', async () => {
    // VERCEL_ENV unset → use NODE_ENV. NODE_ENV is read-only in newer
    // @types/node — cast the writable view to set it.
    const original = env.NODE_ENV;
    env.NODE_ENV = 'production';
    try {
      const mod = await import('./route');
      const res = await mod.GET();
      const body = await res.json();
      expect(body.environment).toBe('production');
    } finally {
      env.NODE_ENV = original;
    }
  });

  it('rejects unknown VERCEL_ENV values and falls back', async () => {
    env.VERCEL_ENV = 'staging-but-spelled-wrong';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(['production', 'development']).toContain(body.environment);
    expect(body.environment).not.toBe('staging-but-spelled-wrong');
  });

  it('exposes the region when VERCEL_REGION is set', async () => {
    env.VERCEL_REGION = 'iad1';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.region).toBe('iad1');
  });

  it('prefers BUILD_TIME over VERCEL_BUILD_TIME when both are set', async () => {
    env.BUILD_TIME = '2026-04-22T10:00:00Z';
    env.VERCEL_BUILD_TIME = '2026-04-22T11:00:00Z';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.buildTime).toBe('2026-04-22T10:00:00Z');
  });

  it('falls back to VERCEL_BUILD_TIME when BUILD_TIME is unset', async () => {
    env.VERCEL_BUILD_TIME = '2026-04-22T11:00:00Z';
    const mod = await import('./route');
    const res = await mod.GET();
    const body = await res.json();
    expect(body.buildTime).toBe('2026-04-22T11:00:00Z');
  });

  it('sets a CDN-friendly Cache-Control header (60s + SWR)', async () => {
    const mod = await import('./route');
    const res = await mod.GET();
    const cc = res.headers.get('Cache-Control') ?? '';
    expect(cc).toContain('public');
    expect(cc).toContain('s-maxage=60');
    expect(cc).toContain('stale-while-revalidate');
  });

  it('HEAD returns 200 with no body and the same cache header', async () => {
    const mod = await import('./route');
    const res = await mod.HEAD();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('');
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=60');
  });

  it('does not leak any secret-named env vars in the response body', async () => {
    // Defensive: ensure if someone adds new env-shadowing logic, we
    // catch obvious key-like leakage at the public-route surface.
    env.STRIPE_SECRET_KEY = 'sk_test_should_not_appear';
    env.SUPABASE_SERVICE_ROLE_KEY = 'svc_test_should_not_appear';
    const mod = await import('./route');
    const res = await mod.GET();
    const text = await res.text();
    expect(text).not.toContain('sk_test_should_not_appear');
    expect(text).not.toContain('svc_test_should_not_appear');
  });
});

// Response-envelope invariants — Round 14.
//
// Same monitoring-contract-lockdown pattern as /api/cron/*, /api/health,
// /api/status. /api/version has no error paths (pure env read) so the
// contract is slightly different:
//   1. Every outcome is HTTP 200 (no 4xx/5xx paths).
//   2. Every outcome returns the stable 6-key shape.
//   3. `environment` is always one of the known enum values.
//   4. `commit` and `commitShort` are always non-empty strings.
//   5. Cache-Control header is always present with s-maxage=60.
//   6. GET and HEAD return the SAME cache headers.
//   7. No body field leaks a stack trace or secret-shaped env.
//
// Why locked down at all if there are no error paths: future "helpful"
// refactors (adding a DB check, catching a deeper error, surfacing more
// env context) could silently weaken the contract. These tests fire
// the moment any future change breaks the public-route promise.
describe('response envelope invariants — /api/version', () => {
  beforeEach(() => {
    delete env.VERCEL_GIT_COMMIT_SHA;
    delete env.VERCEL_GIT_COMMIT_REF;
    delete env.VERCEL_ENV;
    delete env.VERCEL_REGION;
    delete env.BUILD_TIME;
    delete env.VERCEL_BUILD_TIME;
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{
      label: string;
      status: number;
      body: Record<string, unknown>;
      cacheControl: string | null;
    }> = [];

    // 1. Vanilla — no Vercel env vars set.
    {
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({
        label: 'vanilla',
        status: res.status,
        body: await res.json(),
        cacheControl: res.headers.get('Cache-Control'),
      });
    }

    // 2. Production deploy shape.
    {
      env.VERCEL_ENV = 'production';
      env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
      env.VERCEL_GIT_COMMIT_REF = 'main';
      env.VERCEL_REGION = 'iad1';
      env.BUILD_TIME = '2026-04-23T10:00:00Z';
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({
        label: 'production',
        status: res.status,
        body: await res.json(),
        cacheControl: res.headers.get('Cache-Control'),
      });
      delete env.VERCEL_ENV;
      delete env.VERCEL_GIT_COMMIT_SHA;
      delete env.VERCEL_GIT_COMMIT_REF;
      delete env.VERCEL_REGION;
      delete env.BUILD_TIME;
    }

    // 3. Preview deploy shape.
    {
      env.VERCEL_ENV = 'preview';
      env.VERCEL_GIT_COMMIT_SHA = '1234567890abcdef1234567890abcdef12345678';
      env.VERCEL_GIT_COMMIT_REF = 'feat/preview-branch';
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({
        label: 'preview',
        status: res.status,
        body: await res.json(),
        cacheControl: res.headers.get('Cache-Control'),
      });
      delete env.VERCEL_ENV;
      delete env.VERCEL_GIT_COMMIT_SHA;
      delete env.VERCEL_GIT_COMMIT_REF;
    }

    // 4. Unknown VERCEL_ENV — must fall back cleanly to a valid enum.
    {
      env.VERCEL_ENV = 'staging-typo';
      const mod = await import('./route');
      const res = await mod.GET();
      outcomes.push({
        label: 'unknown-vercel-env',
        status: res.status,
        body: await res.json(),
        cacheControl: res.headers.get('Cache-Control'),
      });
      delete env.VERCEL_ENV;
    }

    return outcomes;
  }

  it('every outcome returns HTTP 200', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      expect(o.status, `${o.label} status=${o.status}`).toBe(200);
    }
  });

  it('every outcome exposes the stable 6-key shape', async () => {
    const outcomes = await collectAllOutcomes();
    const requiredKeys = [
      'commit',
      'commitShort',
      'branch',
      'buildTime',
      'environment',
      'region',
    ];
    for (const o of outcomes) {
      for (const k of requiredKeys) {
        expect(
          Object.prototype.hasOwnProperty.call(o.body, k),
          `${o.label} missing key ${k}`,
        ).toBe(true);
      }
    }
  });

  it('environment is always a known enum value', async () => {
    const outcomes = await collectAllOutcomes();
    const allowed = new Set(['production', 'preview', 'development']);
    for (const o of outcomes) {
      expect(
        allowed.has(o.body.environment as string),
        `${o.label} environment=${o.body.environment}`,
      ).toBe(true);
    }
  });

  it('commit and commitShort are always non-empty strings', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      expect(typeof o.body.commit, `${o.label} commit type`).toBe('string');
      expect((o.body.commit as string).length, `${o.label} commit empty`).toBeGreaterThan(0);
      expect(typeof o.body.commitShort, `${o.label} commitShort type`).toBe('string');
      expect(
        (o.body.commitShort as string).length,
        `${o.label} commitShort empty`,
      ).toBeGreaterThan(0);
    }
  });

  it('commitShort never exceeds 7 characters', async () => {
    // Anchors the `shortSha()` contract — if anyone changes the slice
    // length, the version launcher and support replies break together.
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      expect(
        (o.body.commitShort as string).length,
        `${o.label} commitShort=${o.body.commitShort}`,
      ).toBeLessThanOrEqual(7);
    }
  });

  it('Cache-Control header is always present with s-maxage=60', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      expect(o.cacheControl, `${o.label} missing Cache-Control`).toBeTruthy();
      expect(o.cacheControl, `${o.label} missing s-maxage=60`).toContain('s-maxage=60');
      expect(o.cacheControl, `${o.label} missing stale-while-revalidate`).toContain(
        'stale-while-revalidate',
      );
    }
  });

  it('GET and HEAD share the same Cache-Control header', async () => {
    // Launcher scripts + uptime monitors often probe HEAD; any divergence
    // here would split cache behavior silently across probe tools.
    const mod = await import('./route');
    const get = await mod.GET();
    const head = await mod.HEAD();
    expect(head.headers.get('Cache-Control')).toBe(get.headers.get('Cache-Control'));
    expect(head.status).toBe(200);
  });

  it('no outcome leaks a stack trace in any body field', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      const serialized = JSON.stringify(o.body);
      expect(serialized.includes('    at '), `${o.label} leaked stack`).toBe(false);
    }
  });

  it('no outcome leaks a secret-named env var value', async () => {
    // Defensive: even when every known secret is populated, none of
    // their values should surface in the response body.
    env.STRIPE_SECRET_KEY = 'sk_invariant_leak_probe';
    env.SUPABASE_SERVICE_ROLE_KEY = 'svc_invariant_leak_probe';
    env.VAPI_WEBHOOK_SECRET = 'vws_invariant_leak_probe';
    env.STRIPE_WEBHOOK_SECRET = 'whsec_invariant_leak_probe';
    try {
      const outcomes = await collectAllOutcomes();
      for (const o of outcomes) {
        const serialized = JSON.stringify(o.body);
        expect(serialized, `${o.label} leaked sk`).not.toContain('sk_invariant_leak_probe');
        expect(serialized, `${o.label} leaked svc`).not.toContain('svc_invariant_leak_probe');
        expect(serialized, `${o.label} leaked vws`).not.toContain('vws_invariant_leak_probe');
        expect(serialized, `${o.label} leaked whsec`).not.toContain('whsec_invariant_leak_probe');
      }
    } finally {
      delete env.STRIPE_SECRET_KEY;
      delete env.SUPABASE_SERVICE_ROLE_KEY;
      delete env.VAPI_WEBHOOK_SECRET;
      delete env.STRIPE_WEBHOOK_SECRET;
    }
  });
});

// R33 observability-contract attestation — /api/version is a pure
// env-var read with no error surface and is polled at probe
// frequency. Capturing here would never add signal over uptime
// dashboards and would flood on any misconfigured deploy.
//
// Canonical pattern: app/api/csp-report/route.test.ts
// "observability contract — no capture" (R32), applied to
// /api/health (R33) and now here.
describe('observability contract — no capture', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
    delete env.VERCEL_GIT_COMMIT_SHA;
    delete env.VERCEL_GIT_COMMIT_REF;
    delete env.VERCEL_ENV;
    delete env.VERCEL_REGION;
    delete env.BUILD_TIME;
    delete env.VERCEL_BUILD_TIME;
  });

  it('never captures on the vanilla GET', async () => {
    const mod = await import('./route');
    await mod.GET();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures across the production deploy env permutation', async () => {
    env.VERCEL_ENV = 'production';
    env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
    env.VERCEL_GIT_COMMIT_REF = 'main';
    env.VERCEL_REGION = 'iad1';
    env.BUILD_TIME = '2026-04-23T10:00:00Z';
    const mod = await import('./route');
    await mod.GET();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when VERCEL_ENV is an unknown value (fallback path)', async () => {
    // The only genuine "decision" in this route — unknown VERCEL_ENV
    // falls through to NODE_ENV comparison. No throw surface today,
    // but a future refactor could add one. Locked no-capture anyway.
    env.VERCEL_ENV = 'staging-typo';
    const mod = await import('./route');
    await mod.GET();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures on the HEAD path', async () => {
    const mod = await import('./route');
    await mod.HEAD();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when every documented Vercel env var is present', async () => {
    // Broad-permutation guard: the response body is fully
    // deterministic from env, and no branch has a throw. A future
    // refactor that e.g. parses BUILD_TIME as a Date could introduce
    // a throw; this locks the no-capture contract ahead of that.
    env.VERCEL_ENV = 'preview';
    env.VERCEL_GIT_COMMIT_SHA = '1'.repeat(40);
    env.VERCEL_GIT_COMMIT_REF = 'feat/x';
    env.VERCEL_REGION = 'sfo1';
    env.BUILD_TIME = '2026-04-24T00:00:00Z';
    env.VERCEL_BUILD_TIME = '2026-04-24T00:00:01Z';
    const mod = await import('./route');
    await mod.GET();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });
});
