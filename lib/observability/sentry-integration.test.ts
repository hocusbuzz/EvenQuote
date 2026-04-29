// Integration-ish tests that verify the captureException call sites
// wired in Round 18 actually reach the observability stub.
//
// Why this file exists alongside sentry.test.ts:
//   • sentry.test.ts covers the stub's unit behavior (init/isEnabled/
//     captureException inside the stub).
//   • THIS file covers the wiring — i.e. that when a route handler's
//     `catch` block fires, it reaches captureException with a shape the
//     real Sentry SDK can consume.
//
// If someone in a future round removes a captureException(...) call by
// accident (e.g. "cleaning up unused imports"), these tests fail. That's
// the whole point — an error tracker that silently stops receiving is
// worse than one that never existed.
//
// Implementation note: we spy on the module-level captureException by
// mocking '@/lib/observability/sentry'. The stub's no-op behavior means
// no external calls happen in prod today, so we can safely assert the
// shape of what the call sites PASS without caring about downstream.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock — each test resets the call log.
const captureExceptionMock = vi.fn();

vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) => captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

describe('captureException wiring — cron routes', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    process.env.CRON_SECRET = 'test-cron-secret-round-18';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_test_key';
  });

  it('cron/send-reports routes a handler throw through captureException', async () => {
    // Stub admin client with a no-op shape so createAdminClient()
    // (which is called *before* the try block) doesn't itself throw
    // — we want the inner lib call to fail, which IS inside try.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({}),
    }));
    vi.doMock('@/lib/cron/send-reports', () => ({
      sendPendingReports: async () => {
        throw new Error('synthetic lib failure');
      },
    }));
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
      captureMessage: vi.fn(),
      init: vi.fn(),
      isEnabled: () => false,
      setUser: vi.fn(),
      __resetForTests: vi.fn(),
    }));
    const mod = await import('@/app/api/cron/send-reports/route');
    const req = new Request('http://localhost/api/cron/send-reports', {
      headers: { authorization: 'Bearer test-cron-secret-round-18' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(500);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toMatchObject({
      tags: { route: 'cron/send-reports' },
    });
  });

  it('cron/retry-failed-calls routes a handler throw through captureException', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({}),
    }));
    vi.doMock('@/lib/cron/retry-failed-calls', () => ({
      retryFailedCalls: async () => {
        throw new Error('synthetic lib failure');
      },
    }));
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
      captureMessage: vi.fn(),
      init: vi.fn(),
      isEnabled: () => false,
      setUser: vi.fn(),
      __resetForTests: vi.fn(),
    }));
    const mod = await import('@/app/api/cron/retry-failed-calls/route');
    const req = new Request('http://localhost/api/cron/retry-failed-calls', {
      headers: { authorization: 'Bearer test-cron-secret-round-18' },
    });
    const res = await mod.GET(req);
    expect(res.status).toBe(500);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toMatchObject({
      tags: { route: 'cron/retry-failed-calls' },
    });
  });
});
