// Tests for sendPaymentMagicLink — the post-payment action that
// generates a Supabase magic-link via admin.auth.admin.generateLink
// and sends it via Resend with our branded template.
//
// History (read post-payment.ts for the full story): we tried
// signInWithOtp + flowType:'pkce', then signInWithOtp + flowType:
// 'implicit'; both broke server-side magic links. The current shape
// is generateLink (gets the action URL) + sendEmail (we own the
// template + delivery surface).
//
// Tested:
//   - input validation (email/requestId required)
//   - correct redirect URL assembly (NEXT_PUBLIC_APP_URL vs headers fallback)
//   - generateLink call shape (type='magiclink', redirectTo)
//   - sendEmail invocation with the rendered template
//   - error surfaces from BOTH generateLink and sendEmail
//   - canonical Sentry tag shape + reason allow-list
//   - PII guard on captured tags

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origAppUrl = process.env.NEXT_PUBLIC_APP_URL;

// Shared captureException spy.
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

type GenerateLinkResult = {
  data: { properties: { action_link: string } } | null;
  error: { message: string } | null;
};
type SendEmailResult =
  | { ok: true; id: string; simulated: false }
  | { ok: false; simulated: false; error: string };

function mockSupabaseGenerate(result: GenerateLinkResult) {
  const spy = vi.fn().mockResolvedValue(result);
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({
      auth: { admin: { generateLink: spy } },
    }),
  }));
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  return spy;
}

function mockResendSend(result: SendEmailResult) {
  const spy = vi.fn().mockResolvedValue(result);
  vi.doMock('@/lib/email/resend', () => ({
    sendEmail: spy,
  }));
  return spy;
}

const FAKE_ACTION_LINK =
  'https://test.supabase.co/auth/v1/verify?token=tok123&type=magiclink&redirect_to=https%3A%2F%2Fevenquote.com%2Fauth%2Fcallback%3Fnext%3D%252Fget-quotes%252Fclaim%253Frequest%253Dqr-1';

describe('sendPaymentMagicLink', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    delete process.env.NEXT_PUBLIC_APP_URL;
  });
  afterEach(() => {
    if (origAppUrl !== undefined) process.env.NEXT_PUBLIC_APP_URL = origAppUrl;
  });

  // ── Input validation ────────────────────────────────────────────

  it('throws when email is missing', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: null });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: '', requestId: 'qr-1' })
    ).rejects.toThrow(/email and requestId required/);
  });

  it('throws when requestId is missing', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: null });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: '' })
    ).rejects.toThrow(/email and requestId required/);
  });

  // ── Happy path: generateLink + sendEmail ────────────────────────

  it('calls generateLink with type=magiclink and the right redirectTo', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com/';
    mockHeaders();
    const gen = mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-7' });

    expect(gen).toHaveBeenCalledOnce();
    const args = gen.mock.calls[0][0];
    expect(args.type).toBe('magiclink');
    expect(args.email).toBe('a@b.com');
    expect(args.options.redirectTo).toBe(
      'https://evenquote.com/auth/callback?next=' +
        encodeURIComponent('/get-quotes/claim?request=qr-7'),
    );
  });

  it('falls back to request headers when NEXT_PUBLIC_APP_URL is unset', async () => {
    mockHeaders('https', 'preview.evenquote.com');
    const gen = mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-8' });
    const args = gen.mock.calls[0][0];
    expect(args.options.redirectTo).toContain('https://preview.evenquote.com/auth/callback');
    expect(args.options.redirectTo).toContain('request%3Dqr-8');
  });

  it('passes the generated action_link to sendEmail and tags it magic-link', async () => {
    mockHeaders();
    mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    const send = mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await sendPaymentMagicLink({
      email: 'pat@example.com',
      requestId: 'qr-1',
      recipientName: 'Pat',
      categoryName: 'Handyman',
    });

    expect(send).toHaveBeenCalledOnce();
    const sendArgs = send.mock.calls[0][0];
    expect(sendArgs.to).toBe('pat@example.com');
    expect(sendArgs.tag).toBe('magic-link');
    // Subject explicitly says "Sign in" so it cannot be misread as
    // "your quotes are ready" (real customer misread on 2026-05-01).
    expect(sendArgs.subject.toLowerCase()).toContain('sign in');
    expect(sendArgs.subject.toLowerCase()).toContain('handyman');
    // The action link must appear in BOTH html and text bodies so
    // the user can fall back to copy/paste if the button doesn't
    // render in their client (Outlook, plain-text mode). HTML body
    // gets &-encoded by escapeHtml so we look for the unique token
    // portion rather than the literal URL; text body is verbatim.
    expect(sendArgs.html).toContain('tok123');
    expect(sendArgs.text).toContain('tok123');
  });

  it('rewrites the action_link host to evenquote.com/auth/verify when NEXT_PUBLIC_APP_URL is set (deliverability fix)', async () => {
    // Locks the May 2026 deliverability fix: Resend Insights flagged
    // the supabase.co host in the email as the #1 spam-trigger
    // ("link URLs don't match sending domain"). We proxy through
    // /auth/verify on our own domain so the user-visible link host
    // matches the From domain. See app/auth/verify/route.ts.
    process.env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
    mockHeaders();
    mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    const send = mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-1' });

    const sendArgs = send.mock.calls[0][0];
    // Text body has the proxied URL verbatim. Must point at our
    // domain, NOT the bare supabase.co host.
    expect(sendArgs.text).toContain('https://evenquote.com/auth/verify?');
    expect(sendArgs.text).not.toContain('https://test.supabase.co/auth/v1/verify');
    // Token + every original query param must survive the rewrite.
    expect(sendArgs.text).toContain('tok123');
    expect(sendArgs.text).toContain('type=magiclink');
  });

  it('falls back to raw action_link when NEXT_PUBLIC_APP_URL is unset (local dev)', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    mockHeaders();
    mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    const send = mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'qr-1' });

    const sendArgs = send.mock.calls[0][0];
    // No rewrite in dev — would point at localhost which doesn't
    // serve /auth/verify, breaking the loopback flow.
    expect(sendArgs.text).toContain(FAKE_ACTION_LINK);
  });

  // ── Error paths ────────────────────────────────────────────────

  it('throws + captures generateLinkFailed when Supabase returns an error object', async () => {
    mockHeaders();
    mockSupabaseGenerate({
      data: null,
      error: { message: 'rate limit exceeded' },
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_xyz' })
    ).rejects.toThrow(/generateLink failed: rate limit exceeded/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toMatchObject({
      tags: {
        lib: 'post-payment',
        reason: 'generateLinkFailed',
        requestId: 'req_xyz',
      },
    });
  });

  it('throws + captures generateLinkFailed when the response has no action_link', async () => {
    // Supabase shape drift defense: if the SDK response shape changes
    // and `action_link` becomes undefined without an `error`, we still
    // need to fail loudly rather than ship an email with no link.
    mockHeaders();
    mockSupabaseGenerate({
      data: { properties: { action_link: '' } },
      error: null,
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_shape' })
    ).rejects.toThrow(/generateLink failed: generateLink returned no action_link/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('throws + captures sendEmailFailed when Resend returns ok:false', async () => {
    mockHeaders();
    mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    mockResendSend({ ok: false, simulated: false, error: 'domain not verified' });
    const { sendPaymentMagicLink } = await import('./post-payment');

    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_send' })
    ).rejects.toThrow(/magic-link email send failed: domain not verified/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toMatchObject({
      tags: {
        lib: 'post-payment',
        reason: 'sendEmailFailed',
        requestId: 'req_send',
      },
    });
  });

  // ── PII guards ─────────────────────────────────────────────────

  it('does not leak the user email in the thrown error', async () => {
    mockHeaders();
    mockSupabaseGenerate({
      data: null,
      error: { message: 'whatever' },
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    try {
      await sendPaymentMagicLink({
        email: 'victim@example.com',
        requestId: 'qr-pii',
      });
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('victim@example.com');
    }
  });

  it('does NOT include the user email as a tag value (privacy)', async () => {
    mockHeaders();
    mockSupabaseGenerate({
      data: null,
      error: { message: 'smtp down' },
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
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

  // ── Happy path no-capture ──────────────────────────────────────

  it('happy path does not capture anything', async () => {
    mockHeaders();
    mockSupabaseGenerate({
      data: { properties: { action_link: FAKE_ACTION_LINK } },
      error: null,
    });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_ok' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  // ── Input-validation no-capture ────────────────────────────────

  it('input-validation throw does NOT capture (empty email)', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: null });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: '', requestId: 'qr-inv' })
    ).rejects.toThrow();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('input-validation throw does NOT capture (empty requestId)', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: null });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: '' })
    ).rejects.toThrow();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  // ── Sentry tag shape lock ──────────────────────────────────────

  it('tag object is strictly {lib, reason, requestId} — no extra facets', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: { message: 'smtp down' } });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_lock' })
    ).rejects.toThrow();
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const tagKeys = Object.keys((ctx as { tags: Record<string, string> }).tags).sort();
    expect(tagKeys).toEqual(['lib', 'reason', 'requestId']);
  });

  // ── Reason allow-list / catch-all guard ────────────────────────

  it('regression: reason is one of the locked allow-list values', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: { message: 'whatever' } });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
    const { sendPaymentMagicLink } = await import('./post-payment');
    await expect(
      sendPaymentMagicLink({ email: 'a@b.com', requestId: 'req_allow' })
    ).rejects.toThrow();

    const allowed = new Set(['generateLinkFailed', 'sendEmailFailed']);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
  });

  it('regression: forbids reason catch-alls', async () => {
    mockHeaders();
    mockSupabaseGenerate({ data: null, error: { message: 'any failure' } });
    mockResendSend({ ok: true, id: 'em_1', simulated: false });
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
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(forbidden.has(reason), `disallowed reason: ${reason}`).toBe(false);
  });
});
