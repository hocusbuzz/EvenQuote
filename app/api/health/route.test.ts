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

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.resetModules();
    // Default to every feature in simulation mode so the assertion doesn't
    // depend on the dev machine's .env.local.
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.VAPI_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
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
    process.env.STRIPE_SECRET_KEY = 'sk_test_value';
    process.env.VAPI_API_KEY = 'vapi_value';
    process.env.RESEND_API_KEY = 're_value';
    process.env.ANTHROPIC_API_KEY = 'anth_value';
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
});
