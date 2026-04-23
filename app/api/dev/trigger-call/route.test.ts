// Tests for /api/dev/trigger-call.
//
// This is a dev-only "fire a real call against my seeded data"
// endpoint. It must HARD-REFUSE in production (NODE_ENV), optionally
// gate on DEV_TRIGGER_TOKEN, and otherwise run a synthetic quote_request
// through the same engine.runCallBatch() the real flow uses.
//
// We focus on the gating surface because the business logic is covered
// by lib/calls/engine.test.ts. Gating is the security boundary that
// keeps this route from being a call-injection backdoor if someone
// misconfigures an env var.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Stub Supabase admin client so "insert a synthetic quote_request" works
// without a real DB.
function buildAdminStub() {
  return {
    from: (table: string) => {
      if (table === 'service_categories') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { id: 'cat_moving_1', name: 'Moving' },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'quote_requests') {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'qr_dev_1' },
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => buildAdminStub(),
}));

vi.mock('@/lib/calls/engine', () => ({
  runCallBatch: vi.fn().mockResolvedValue({
    ok: true,
    dispatched: 3,
    succeeded: 3,
    failed: 0,
  }),
}));

describe('GET /api/dev/trigger-call', () => {
  const savedEnv: Record<string, string | undefined> = {};
  // Plain string[] avoids NODE_ENV's readonly narrowing under strict TS.
  const ENV_KEYS: string[] = ['NODE_ENV', 'DEV_TRIGGER_TOKEN', 'TEST_OVERRIDE_PHONE'];

  beforeEach(() => {
    vi.resetModules();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  // Restore env after each test — don't leak NODE_ENV to neighboring files.
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns 404 in production regardless of token', async () => {
    // Writable view to bypass TS's readonly narrowing of NODE_ENV.
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    process.env.DEV_TRIGGER_TOKEN = 'right-token';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/trigger-call?token=right-token')
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/disabled in production/);
  });

  it('returns 401 when DEV_TRIGGER_TOKEN is set and token is missing', async () => {
    process.env.DEV_TRIGGER_TOKEN = 'shh-dev';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/trigger-call')
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/DEV_TRIGGER_TOKEN/);
  });

  it('returns 401 when provided token does not match', async () => {
    process.env.DEV_TRIGGER_TOKEN = 'shh-dev';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/trigger-call?token=wrong')
    );
    expect(res.status).toBe(401);
  });

  it('accepts request when token matches', async () => {
    process.env.DEV_TRIGGER_TOKEN = 'shh-dev';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/trigger-call?token=shh-dev')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.quote_request_id).toBe('qr_dev_1');
  });

  it('accepts request when DEV_TRIGGER_TOKEN is unset (dev laptop default)', async () => {
    // No DEV_TRIGGER_TOKEN means no Layer-2 gate; NODE_ENV guard (unset
    // here, so treated as non-production) is sufficient.
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/trigger-call')
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 for unknown category', async () => {
    const mod = await import('./route');
    const res = await mod.GET(
      new Request('http://localhost/api/dev/trigger-call?category=rocketry')
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown category/);
    expect(body.error).toMatch(/moving/);
    expect(body.error).toMatch(/cleaning/);
  });

  it('happy path: returns batch result and reports test_override_phone_active flag', async () => {
    process.env.TEST_OVERRIDE_PHONE = '+15556667777';
    const mod = await import('./route');
    const res = await mod.GET(
      new Request(
        'http://localhost/api/dev/trigger-call?category=cleaning&city=Carlsbad&zip=92008'
      )
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('Moving'); // from our stub — returns same row regardless of slug
    expect(body.target).toEqual({ city: 'Carlsbad', state: 'CA', zip: '92008' });
    expect(body.test_override_phone_active).toBe(true);
    expect(body.batch).toMatchObject({ ok: true, dispatched: 3 });
  });
});

