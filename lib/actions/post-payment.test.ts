// Tests for sendPaymentMagicLink — the post-payment action that dispatches
// a Supabase magic link to the email the guest entered during intake.
//
// We stub the admin client's auth.signInWithOtp and next/headers so the
// action can be exercised without Supabase or the Next runtime. Because
// the action is a thin adapter, most of the value is:
//   - input validation (email/requestId required)
//   - correct redirect URL assembly (NEXT_PUBLIC_APP_URL vs headers fallback)
//   - error surfacing from Supabase

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origAppUrl = process.env.NEXT_PUBLIC_APP_URL;

function mockHeaders(proto = 'http', host = 'localhost:3000') {
  vi.doMock('next/headers', () => ({
    headers: () => ({
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === 'x-forwarded-proto') return proto;
        if (n === 'host') return host;
        return null;
      },
    }),
  }));
}

function mockOtp(result: { error: { message: string } | null }) {
  const spy = vi.fn().mockResolvedValue(result);
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      auth: { signInWithOtp: spy },
    }),
  }));
  return spy;
}

describe('sendPaymentMagicLink', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_APP_URL;
  });
  afterEach(() => {
    if (origAppUrl !== undefined) process.env.NEXT_PUBLIC_APP_URL = origAppUrl;
  });

  it('throws when email is missing', async () => {
    mockHeaders();
    mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: '', requestId: 'qr-1' })
    ).rejects.toThrow(/email and requestId required/);
  });

  it('throws when requestId is missing', async () => {
    mockHeaders();
    mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: '' })
    ).rejects.toThrow(/email and requestId required/);
  });

  it('builds redirect from NEXT_PUBLIC_APP_URL when set (strips trailing slash)', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com/';
    mockHeaders();
    const otp = mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-7' });
    expect(otp).toHaveBeenCalledOnce();
    const call = otp.mock.calls[0][0];
    expect(call.email).toBe('a@b.com');
    expect(call.options.shouldCreateUser).toBe(true);
    expect(call.options.emailRedirectTo).toBe(
      'https://evenquote.com/auth/callback?next=' +
        encodeURIComponent('/get-quotes/claim?request=qr-7')
    );
  });

  it('falls back to request headers when NEXT_PUBLIC_APP_URL is unset', async () => {
    mockHeaders('https', 'preview.evenquote.com');
    const otp = mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-8' });
    const call = otp.mock.calls[0][0];
    expect(call.options.emailRedirectTo).toContain('https://preview.evenquote.com/auth/callback');
    expect(call.options.emailRedirectTo).toContain('request%3Dqr-8');
  });

  it('URL-encodes the request id in the next param', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
    mockHeaders();
    const otp = mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    // UUID-shaped id so encoding is representative
    await sendPaymentMagicLink({
      email: 'a@b.com',
      requestId: 'aa-bb cc',
    });
    const redirect = otp.mock.calls[0][0].options.emailRedirectTo as string;
    // The `next` path contains `?request=aa-bb cc` which gets
    // encodeURIComponent'd, so the space becomes `%20` inside the outer
    // encoding → `%2520` in the final emailRedirectTo (since the space's
    // `%20` itself gets percent-encoded once more by the outer encode).
    expect(redirect).toMatch(/request%3Daa-bb%2520cc/);
  });

  it('rethrows Supabase errors with clear context', async () => {
    mockHeaders();
    mockOtp({ error: { message: 'rate limit exceeded' } });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-9' })
    ).rejects.toThrow(/signInWithOtp failed: rate limit exceeded/);
  });

  it('does not leak the magic-link URL in the thrown error', async () => {
    // Defensive: the URL contains the user email in a redirect. If Supabase
    // errored we want the message but never the assembled redirect.
    mockHeaders();
    mockOtp({ error: { message: 'SMTP down' } });
    const { sendPaymentMagicLink } = await import('./post-payment');
    try {
      await sendPaymentMagicLink({ email: 'victim@example.com', requestId: 'qr-pii' });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('victim@example.com');
      expect(msg).not.toContain('qr-pii');
    }
  });
});
