// Tests for the Turnstile module.
//
// Locks the env-gated behavior contract:
//   • Unconfigured (either env var missing) → soft-allow (ok:true).
//     This keeps local dev / preview deploys frictionless.
//   • Configured + missing token → fail (bot likely skipped widget).
//   • Configured + valid token → ok:true.
//   • Configured + invalid token → fail with reason.
//   • Configured + Cloudflare HTTP error → soft-allow (so a CF outage
//     doesn't break the form for real customers).
//   • Configured + fetch throws → soft-allow (same rationale).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTurnstileConfigured,
  turnstileSiteKey,
  verifyTurnstileToken,
} from './turnstile';

const origEnv = { ...process.env };

describe('isTurnstileConfigured', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns false when neither env var is set', () => {
    expect(isTurnstileConfigured()).toBe(false);
  });

  it('returns false when only the site key is set', () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '0xAAAA';
    expect(isTurnstileConfigured()).toBe(false);
  });

  it('returns false when only the secret is set', () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    expect(isTurnstileConfigured()).toBe(false);
  });

  it('returns true when both are set', () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '0xAAAA';
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    expect(isTurnstileConfigured()).toBe(true);
  });
});

describe('turnstileSiteKey', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns null when unset', () => {
    expect(turnstileSiteKey()).toBeNull();
  });

  it('returns the env value when set', () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '0x4AAAAAAAtest';
    expect(turnstileSiteKey()).toBe('0x4AAAAAAAtest');
  });
});

describe('verifyTurnstileToken', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env = { ...origEnv };
  });

  it('soft-allows (ok:true) when TURNSTILE_SECRET_KEY is unset (dev/preview)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await verifyTurnstileToken({ token: 'whatever' });
    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:false with missing-token when secret is set but token is empty', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await verifyTurnstileToken({ token: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:false with missing-token when secret is set but token is null/undefined', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    expect((await verifyTurnstileToken({ token: null })).ok).toBe(false);
    expect((await verifyTurnstileToken({ token: undefined })).ok).toBe(false);
  });

  it('POSTs the token to Cloudflare and returns ok:true on success', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await verifyTurnstileToken({
      token: 'tok123',
      remoteIp: '1.2.3.4',
    });
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body.get('secret')).toBe('sekret');
    expect(body.get('response')).toBe('tok123');
    expect(body.get('remoteip')).toBe('1.2.3.4');
  });

  it('returns ok:false with the joined error-codes when CF rejects the token', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        'error-codes': ['invalid-input-response', 'timeout-or-duplicate'],
      }),
    }) as unknown as typeof fetch;

    const r = await verifyTurnstileToken({ token: 'bad-token' });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.reason).toBe('invalid-input-response,timeout-or-duplicate');
  });

  it('soft-allows (ok:true) on Cloudflare HTTP error (CF outage shouldn\'t break forms)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as unknown as typeof fetch;

    const r = await verifyTurnstileToken({ token: 'tok' });
    expect(r.ok).toBe(true);
  });

  it('soft-allows (ok:true) when fetch throws (network down)', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const r = await verifyTurnstileToken({ token: 'tok' });
    expect(r.ok).toBe(true);
  });

  it('omits remoteip when not provided', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await verifyTurnstileToken({ token: 'tok123' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.has('remoteip')).toBe(false);
  });
});
