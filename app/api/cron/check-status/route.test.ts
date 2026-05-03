// Tests for /api/cron/check-status — the cron-friendly companion
// to /api/status.
//
// We mock the underlying probes (checkStripe / checkVapi / checkResend
// from the status route) so the tests are pure and don't try to dial
// the live integrations.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCheckStripe = vi.fn();
const mockCheckVapi = vi.fn();
const mockCheckResend = vi.fn();

vi.mock('@/app/api/status/route', () => ({
  checkStripe: () => mockCheckStripe(),
  checkVapi: () => mockCheckVapi(),
  checkResend: () => mockCheckResend(),
}));

const env = process.env as Record<string, string | undefined>;

async function loadRoute() {
  const mod = await import('./route');
  return mod;
}

function makeReq(headers: Record<string, string> = {}) {
  return new Request('https://example.com/api/cron/check-status', {
    method: 'GET',
    headers: new Headers(headers),
  });
}

describe('/api/cron/check-status', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheckStripe.mockReset();
    mockCheckVapi.mockReset();
    mockCheckResend.mockReset();
    // Default Resend to 'ok' so existing tests that only set Stripe
    // and Vapi keep their original semantics. Tests that exercise
    // Resend explicitly override.
    mockCheckResend.mockResolvedValue({ outcome: 'ok' });
    env.CRON_SECRET = 'cron_test_secret';
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete env.CRON_SECRET;
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'anything' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/CRON_SECRET/);
  });

  it('returns 401 when secret is missing from request', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(mockCheckStripe).not.toHaveBeenCalled();
    expect(mockCheckVapi).not.toHaveBeenCalled();
  });

  it('returns 401 when provided secret does not match', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'WRONG' }));
    expect(res.status).toBe(401);
  });

  it('accepts the secret via Authorization: Bearer header', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(
      makeReq({ authorization: 'Bearer cron_test_secret' })
    );
    expect(res.status).toBe(200);
  });

  it('returns 200 with both ok when both probes succeed', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ stripe: 'ok', vapi: 'ok', resend: 'ok' });
    expect(body.errors).toBeUndefined();
  });

  it('treats "skip" outcomes as healthy (preview env, no key)', async () => {
    // Critical: a preview env without VAPI_API_KEY should NOT page.
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'skip' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.vapi).toBe('skip');
  });

  it('returns 503 with errors when Stripe probe fails', async () => {
    mockCheckStripe.mockResolvedValue({
      outcome: 'fail',
      message: 'Invalid API Key',
    });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.stripe).toBe('fail');
    expect(body.errors.stripe).toBe('Invalid API Key');
  });

  it('returns 503 when both probes fail and surfaces both errors', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'fail', message: 'foo' });
    mockCheckVapi.mockResolvedValue({ outcome: 'fail', message: 'bar' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual({ stripe: 'foo', vapi: 'bar' });
  });

  it('responds to POST identically to GET (Vercel Cron uses POST)', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { POST } = await loadRoute();
    const req = new Request('https://example.com/api/cron/check-status', {
      method: 'POST',
      headers: new Headers({ 'x-cron-secret': 'cron_test_secret' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('sets Cache-Control: no-store to keep monitor results fresh', async () => {
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
  });
});

// Response-envelope invariants — see the matching block in
// retry-failed-calls/route.test.ts. These lock the cross-outcome shape
// (`{ ok: boolean }`, ok agrees with status class, ok:false carries an
// error field where appropriate, and no stack traces leak).
describe('response envelope invariants — /api/cron/check-status', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheckStripe.mockReset();
    mockCheckVapi.mockReset();
    env.CRON_SECRET = 'cron_test_secret';
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
  });

  async function collectAllOutcomes() {
    const outcomes: Array<{ label: string; status: number; body: Record<string, unknown> }> = [];

    // 1. Missing CRON_SECRET → 500.
    {
      delete env.CRON_SECRET;
      const { GET } = await loadRoute();
      const res = await GET(makeReq({ 'x-cron-secret': 'nope' }));
      outcomes.push({ label: 'missing-secret-env', status: res.status, body: await res.json() });
      env.CRON_SECRET = 'cron_test_secret';
    }

    // 2. Unauthorized (no header).
    {
      vi.resetModules();
      const { GET } = await loadRoute();
      const res = await GET(makeReq());
      outcomes.push({ label: 'unauth', status: res.status, body: await res.json() });
    }

    // 3. Happy path — both probes ok.
    {
      vi.resetModules();
      mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
      mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
      const { GET } = await loadRoute();
      const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
      outcomes.push({ label: 'happy', status: res.status, body: await res.json() });
    }

    // 4. Degraded — probe fails, expect 503 + ok:false envelope.
    {
      vi.resetModules();
      mockCheckStripe.mockResolvedValue({ outcome: 'fail', message: 'boom' });
      mockCheckVapi.mockResolvedValue({ outcome: 'ok' });
      const { GET } = await loadRoute();
      const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
      outcomes.push({ label: 'degraded', status: res.status, body: await res.json() });
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

  it('ok:false auth/config outcomes carry a string `error`', async () => {
    const outcomes = await collectAllOutcomes();
    // 'degraded' reports failures via `errors` (plural, per-check), not
    // `error`, which is a distinct contract. Auth/config outcomes use the
    // flat `error` field. Check the right one per label.
    for (const o of outcomes) {
      if (o.label === 'missing-secret-env' || o.label === 'unauth') {
        expect(typeof o.body.error, `${o.label} error not string`).toBe('string');
        expect((o.body.error as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('degraded outcome reports per-check errors via `errors` object, not a flat error string', async () => {
    const outcomes = await collectAllOutcomes();
    const degraded = outcomes.find((o) => o.label === 'degraded');
    expect(degraded).toBeTruthy();
    expect(degraded!.body.ok).toBe(false);
    expect(typeof degraded!.body.errors).toBe('object');
    expect((degraded!.body.errors as Record<string, unknown>).stripe).toBe('boom');
  });

  it('no ok:false outcome leaks a stack trace', async () => {
    const outcomes = await collectAllOutcomes();
    for (const o of outcomes) {
      if (o.body.ok === false) {
        const err = String(o.body.error ?? '');
        const errorsMap = o.body.errors as Record<string, unknown> | undefined;
        expect(err.includes('    at '), `${o.label} leaked stack in error`).toBe(false);
        if (errorsMap) {
          for (const v of Object.values(errorsMap)) {
            expect(String(v).includes('    at '), `${o.label} leaked stack in errors map`).toBe(false);
          }
        }
      }
    }
  });
});

// ── captureException tag-shape lockdown ────────────────────────────
// check-status was the odd one out among /api/cron/* — it didn't fire
// captureException on degraded outcomes. Now added: a synthetic Error
// is captured with canonical `{ route, stripe, vapi }` tags so on-call
// gets paged through Sentry the same way the other cron jobs do.
//
// The probe outcome values ('ok'|'skip'|'fail') are literal strings,
// not contact data, so forwarding them as tag values is safe. PII
// guards remain in place in case a future refactor widens that set.
describe('captureException tag shape — cron/check-status', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCheckStripe.mockReset();
    mockCheckVapi.mockReset();
    mockCheckResend.mockReset();
    // Default Resend to 'ok' so existing tests that only set Stripe
    // and Vapi keep their original semantics. Tests that exercise
    // Resend explicitly override.
    mockCheckResend.mockResolvedValue({ outcome: 'ok' });
    env.CRON_SECRET = 'cron_test_secret';
  });

  it('fires capture with canonical tags when a probe returns fail', async () => {
    const captureExceptionMock = vi.fn();
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
    }));
    mockCheckStripe.mockResolvedValue({ outcome: 'fail', message: 'bad key' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });

    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(503);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/stripe=fail/);
    expect(ctx).toEqual({
      tags: {
        route: 'cron/check-status',
        reason: 'integrationProbeFailed',
        stripe: 'fail',
        vapi: 'ok',
        resend: 'ok',
      },
    });
    // PII guard — tag values are literal outcome strings, never contact
    // data. Keep the guard in case a future change broadens the set.
    for (const v of Object.values((ctx as { tags: Record<string, string> }).tags)) {
      expect(v).not.toMatch(/@/);
      expect(v).not.toMatch(/\+?\d{10,}/);
    }
  });

  it('does NOT fire capture on the happy path (both ok)', async () => {
    const captureExceptionMock = vi.fn();
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
    }));
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'ok' });

    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(200);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT fire capture when an integration is merely skipped', async () => {
    // Preview envs with no VAPI_API_KEY return 'skip'. Skip is
    // healthy — no Sentry event should fire.
    const captureExceptionMock = vi.fn();
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
    }));
    mockCheckStripe.mockResolvedValue({ outcome: 'ok' });
    mockCheckVapi.mockResolvedValue({ outcome: 'skip' });

    const { GET } = await loadRoute();
    const res = await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    expect(res.status).toBe(200);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('regression-guard: reason tag is a discrete, allow-listed value', async () => {
    const captureExceptionMock = vi.fn();
    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
    }));
    mockCheckStripe.mockResolvedValue({ outcome: 'fail', message: 'x' });
    mockCheckVapi.mockResolvedValue({ outcome: 'fail', message: 'y' });
    const { GET } = await loadRoute();
    await GET(makeReq({ 'x-cron-secret': 'cron_test_secret' }));
    const ALLOWED = new Set(['integrationProbeFailed']);
    for (const [, ctx] of captureExceptionMock.mock.calls) {
      const reason = (ctx as { tags?: Record<string, string> })?.tags?.reason;
      expect(reason, 'reason tag present').toBeTruthy();
      expect(ALLOWED.has(String(reason))).toBe(true);
    }
  });
});
