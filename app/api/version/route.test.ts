// Tests for /api/version.
//
// Pure-env-read endpoint, no DB or external calls — tests are about
// shape correctness, env-var handling, and cache-header presence.

import { describe, it, expect, beforeEach } from 'vitest';

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
