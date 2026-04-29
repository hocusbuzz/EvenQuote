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

// Shared captureException spy. Round 19 threaded the observability stub
// through sendPaymentMagicLink so every caller (not just the stripe
// webhook) gets lib+reason-tagged error reports.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) => captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

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
    captureExceptionMock.mockReset();
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

  // ── Round 19 observability contract ──
  //
  // signInWithOtp failures must reach the error tracker with the
  // canonical lib+reason tag set. Capturing at the lib boundary means
  // every caller (webhook today, support retry tomorrow, admin resend
  // script eventually) inherits observability coverage — tags give the
  // ops team a stable bucket to alert on regardless of which route
  // the failure bubbled through. Sentry dedupes on error fingerprint,
  // so the route-level capture in stripe/webhook/route.ts still adds
  // its own tag facet without double-counting.

  it('captures signInWithOtp errors with canonical lib+reason tags, then rethrows', async () => {
    mockHeaders();
    mockOtp({ error: { message: 'rate limited' } });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_xyz' })
    ).rejects.toThrow(/signInWithOtp failed: rate limited/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    // Tags are load-bearing. A future refactor that renames them
    // orphans alert routing without breaking Sentry fingerprint
    // history — a silent observability regression. Lock the shape.
    expect(ctx).toMatchObject({
      tags: {
        lib: 'post-payment',
        reason: 'signInWithOtp',
        requestId: 'req_xyz',
      },
    });
  });

  it('does NOT include the user email as a tag value (privacy)', async () => {
    // We own the Sentry tag boundary. Logger redaction doesn't apply
    // to structured tags, so if someone adds `{ email }` to the tag
    // set, this test fails before the PII hits the tracker.
    mockHeaders();
    mockOtp({ error: { message: 'smtp down' } });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await expect(
      sendPaymentMagicLink({
        email: 'private@customer.com',
        requestId: 'req_priv',
      })
    ).rejects.toThrow();

    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toMatch(/private@customer\.com/);
  });

  it('happy path does not capture anything', async () => {
    // Sanity check: a successful OTP dispatch must not send a false
    // positive to the error tracker. If Sentry ever starts seeing
    // "post-payment" noise, this is the first test to check.
    mockHeaders();
    mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_ok' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  // ── Round 22 audit gap-fill: input-validation path ──
  //
  // The email/requestId validation throws synchronously BEFORE the
  // admin client / Supabase call. A future maintainer might
  // "defensively" wrap this in try-catch and fire captureException,
  // which would flood Sentry with every malformed webhook payload
  // (infrastructure noise, not a code bug). Lock no-capture here.

  it('input-validation throw does NOT capture (empty email)', async () => {
    mockHeaders();
    mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: '', requestId: 'qr-inv' })
    ).rejects.toThrow();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('input-validation throw does NOT capture (empty requestId)', async () => {
    mockHeaders();
    mockOtp({ error: null });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: '' })
    ).rejects.toThrow();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('tag object is strictly {lib, reason, requestId} — no extra facets', async () => {
    // Tag schema lock. If a new tag sneaks in (e.g. `email`, `userId`,
    // a free-text `details` with PII risk), this test fails before it
    // ships. Ops dashboards assume this exact shape.
    mockHeaders();
    mockOtp({ error: { message: 'smtp down' } });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_lock' })
    ).rejects.toThrow();
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const tagKeys = Object.keys((ctx as { tags: Record<string, string> }).tags).sort();
    expect(tagKeys).toEqual(['lib', 'reason', 'requestId']);
  });

  // ── Round 30 reason-granularity regression guards ──
  //
  // post-payment.ts has exactly ONE external call (signInWithOtp), so
  // exactly ONE capture reason. These guards harden against two
  // separate classes of drift:
  //   (a) A future refactor that adds a new silent path without a
  //       canonical `reason` — a catch-all like 'sendFailed', 'error',
  //       or 'unknown' would merge the new path into the existing
  //       Sentry issue and mask its signal.
  //   (b) A future refactor that renames the one existing reason
  //       — orphans alert routing without breaking Sentry's
  //       fingerprint history (silent observability regression).

  it('regression: forbids reason catch-alls on the one capture site', async () => {
    // Mirror of the R29 pattern applied to resend.ts / intake.ts. If
    // any new failure path is added and assigned one of the forbidden
    // values, this test catches it before shipping.
    mockHeaders();
    mockOtp({ error: { message: 'any failure shape' } });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_reg' })
    ).rejects.toThrow();

    const forbidden = new Set([
      'unknown',
      'error',
      'failed',
      'otpFailed',
      'sendFailed',
      'magicLinkFailed',
      'authFailed',
    ]);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(forbidden.has(reason), `disallowed reason: ${reason}`).toBe(false);
  });

  it('regression: reason is the single locked value', async () => {
    // Allow-list lock. Keeps the PostPaymentReason type and the tag
    // value in sync — adding a new reason here is a conscious
    // decision, not an accidental string change.
    mockHeaders();
    mockOtp({ error: { message: 'smtp down' } });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_allow' })
    ).rejects.toThrow();

    const allowed = new Set(['signInWithOtp']);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
  });

  it('regression: wrapped message uses the controlled "signInWithOtp failed:" prefix', async () => {
    // R28/R29 pattern: Sentry groups by fingerprint built from the
    // thrown Error's message. A future refactor that changes the
    // prefix text (e.g. drops "signInWithOtp failed:" for a vendor
    // message only) would spawn new Sentry issues for every deploy
    // until the fingerprint stabilizes. Lock the prefix.
    mockHeaders();
    mockOtp({ error: { message: 'vendor said no' } });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_fp' })
    ).rejects.toThrow();

    const [err] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^signInWithOtp failed: /);
  });
});
