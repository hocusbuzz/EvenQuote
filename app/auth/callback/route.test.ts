import { describe, it, expect, beforeEach, vi } from 'vitest';

// Supabase server client is mocked. We need handles to BOTH:
//   • exchangeCodeForSession — OAuth / PKCE path (?code=)
//   • verifyOtp — magic-link / OTP path (?token_hash=&type=)
// added by the May 2026 fix so server-initiated magic links from
// post-payment.ts work without the broken PKCE expectation.
const mockExchange = vi.fn();
const mockVerifyOtp = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: mockExchange,
      verifyOtp: mockVerifyOtp,
    },
  }),
}));

// Observability capture is mocked. R30 added exchangeCodeForSessionFailed
// as the canonical capture site for silent magic-link breaks. Lock the
// tag shape, PII contract, and no-capture boundaries in tests below.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) => captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

async function loadGet() {
  const { GET } = await import('./route');
  return GET;
}

function makeReq(path: string) {
  // NextRequest extends Request and accepts a URL in the constructor.
  // We use the plain Request type here — the handler only reads .url
  // so this is compatible at runtime.
  return new Request(`http://localhost${path}`) as unknown as Parameters<Awaited<ReturnType<typeof loadGet>>>[0];
}

describe('/auth/callback', () => {
  beforeEach(() => {
    vi.resetModules();
    mockExchange.mockReset();
    mockVerifyOtp.mockReset();
    captureExceptionMock.mockReset();
  });

  it('redirects to /auth/callback/finish when neither code nor token_hash is present (fragment-flow fallback)', async () => {
    // Locks the May 2026 fix: when Supabase uses the implicit
    // (fragment) flow — notably for type=signup confirmation — the
    // tokens arrive in the URL fragment which the server cannot read.
    // We hand off to the client page at /auth/callback/finish, which
    // CAN read the fragment and persist the session via
    // createBrowserClient. The browser preserves the fragment across
    // the 302, so the tokens land at /finish intact.
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback'));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth/callback/finish');
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('preserves ?next when redirecting to /auth/callback/finish', async () => {
    const GET = await loadGet();
    const res = await GET(
      makeReq(
        '/auth/callback?next=' +
          encodeURIComponent('/get-quotes/claim?request=abc'),
      ),
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get('location')!;
    expect(new URL(loc).pathname).toBe('/auth/callback/finish');
    expect(new URL(loc).searchParams.get('next')).toBe(
      '/get-quotes/claim?request=abc',
    );
  });

  it('redirects to /auth-code-error with provider error message', async () => {
    const GET = await loadGet();
    const res = await GET(
      makeReq('/auth/callback?error=access_denied&error_description=user%20declined')
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
    // URLSearchParams round-trips "user declined" but spaces encode as '+'.
    // Use the URL API to decode rather than decodeURIComponent (which
    // does not decode '+').
    expect(new URL(loc).searchParams.get('message')).toBe('user declined');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('exchanges the code and redirects to /dashboard by default', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
    expect(mockExchange).toHaveBeenCalledWith('abc');
    // verifyOtp must NOT fire on the OAuth/PKCE path — wrong API.
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it('verifies the magic-link token_hash via verifyOtp and redirects to /dashboard by default', async () => {
    // Locks the May 2026 PKCE fix: magic links from post-payment.ts
    // arrive at the callback with `?token_hash=…&type=magiclink` (the
    // implicit-flow shape). Pre-fix, the callback called
    // exchangeCodeForSession on a missing `?code=` and broke every
    // post-payment magic link with a "PKCE code verifier not found"
    // error — what cost us a real customer's first impression.
    mockVerifyOtp.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?token_hash=tok123&type=magiclink'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: 'magiclink',
      token_hash: 'tok123',
    });
    // exchangeCodeForSession must NOT fire on the OTP path.
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('respects ?next on the magic-link (token_hash) path', async () => {
    mockVerifyOtp.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(
      makeReq(
        '/auth/callback?token_hash=tok123&type=magiclink&next=' +
          encodeURIComponent('/get-quotes/claim?request=abc'),
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost/get-quotes/claim?request=abc',
    );
  });

  it('defaults type to magiclink when token_hash is present without a type', async () => {
    // Older link formats may omit `type`; the only OTP type we
    // generate today is magiclink (post-payment.ts), so the default
    // is safe.
    mockVerifyOtp.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?token_hash=tok123'));
    expect(res.status).toBe(307);
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      type: 'magiclink',
      token_hash: 'tok123',
    });
  });

  it('respects a safe ?next relative path', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc&next=%2Fdashboard%2Frequests%2F123'));
    expect(res.headers.get('location')).toBe('http://localhost/dashboard/requests/123');
  });

  it('rejects an absolute-URL ?next (open-redirect guard)', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    // Scheme-relative //evil.com/ — must NOT be followed
    const res = await GET(makeReq('/auth/callback?code=abc&next=%2F%2Fevil.com%2Fsteal'));
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
  });

  it('rejects a backslash in ?next (Windows-path trick)', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc&next=%2Fdash%5Cevil'));
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
  });

  it('redirects to /auth-code-error with message when exchange fails', async () => {
    mockExchange.mockResolvedValue({ error: { message: 'invalid code' } });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc'));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
    expect(new URL(loc).searchParams.get('message')).toBe('invalid code');
  });

  // ── Round 30 observability contract ──
  //
  // Paired with the R29 get-quotes/claim audit. If this route fails
  // silently, the magic-link break happens BEFORE the claim route can
  // run, so R29's claim-route observability never fires. The customer
  // paid $9.99, clicked the link, got sent to /auth-code-error, and
  // nothing reached ops. Capture at the auth exchange.
  //
  // Deliberately NOT captured: ?error=... (user denied OAuth — user-
  // facing event) and missing ?code= (bot crawlers / expired share
  // links — flooding risk). Both locked below with negative tests so
  // a future "defensive" refactor doesn't silently capture them.

  it('captures exchangeCodeForSession errors with canonical route+reason tags', async () => {
    mockExchange.mockResolvedValue({ error: { message: 'expired token' } });
    const GET = await loadGet();
    await GET(makeReq('/auth/callback?code=abc'));

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    // Controlled prefix for fingerprint stability — Sentry groups by
    // error message fingerprint, so vendor rewording must not spawn
    // new issues per deploy.
    expect((err as Error).message).toMatch(/^exchangeCodeForSession failed: /);
    expect(ctx).toMatchObject({
      tags: {
        route: 'auth/callback',
        reason: 'exchangeCodeForSessionFailed',
      },
    });
  });

  it('captures when exchangeCodeForSession THROWS (transport-layer)', async () => {
    // A future Supabase SDK change that starts throwing instead of
    // returning { error } must still reach Sentry. Without the try/
    // catch wrapper, a raw throw would fall through to Next.js's error
    // boundary — 500 with no route tags, no structured signal.
    mockExchange.mockRejectedValue(new Error('socket hang up'));
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc'));
    // User still lands on the error page (no uncaught crash).
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/auth-code-error');
    // And ops still sees the capture.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect((err as Error).message).toMatch(/^exchangeCodeForSession failed: /);
    expect(ctx).toMatchObject({
      tags: {
        route: 'auth/callback',
        reason: 'exchangeCodeForSessionFailed',
      },
    });
  });

  it('does NOT capture when provider returns ?error= (user-denied OAuth)', async () => {
    // User-facing event, not an ops incident. Capturing here would
    // flood Sentry every time a user hits "Cancel" on the Google
    // consent screen.
    const GET = await loadGet();
    await GET(
      makeReq('/auth/callback?error=access_denied&error_description=user%20declined')
    );
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('does NOT capture when ?code= is missing', async () => {
    // Bot crawlers / share-link misuse / expired links all land here.
    // Flooding risk — explicitly no-capture.
    const GET = await loadGet();
    await GET(makeReq('/auth/callback'));
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('happy path does NOT capture anything', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    await GET(makeReq('/auth/callback?code=abc'));
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('PII guard: tags never include code/email/IP/origin', async () => {
    // Tag values are indexed and survive message-body scrubbers.
    // Every capture path must pass only route + reason identifiers —
    // never the auth code, an email, a user agent, or the origin URL.
    mockExchange.mockResolvedValue({ error: { message: 'bad' } });
    const GET = await loadGet();
    await GET(
      makeReq('/auth/callback?code=super-secret-auth-code&next=%2Fdashboard')
    );
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('super-secret-auth-code');
    expect(serialized).not.toMatch(/@/); // no emails
    expect(serialized).not.toMatch(/localhost/); // no origin host
  });

  it('tag schema lock — EXACT keys, no drift', async () => {
    mockExchange.mockResolvedValue({ error: { message: 'bad' } });
    const GET = await loadGet();
    await GET(makeReq('/auth/callback?code=abc'));
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const tagKeys = Object.keys(
      (ctx as { tags: Record<string, string> }).tags
    ).sort();
    // Strict key-set lock: if a future change adds `code`, `email`,
    // `userId`, or a free-text `details` field here, this test fails
    // before it ships.
    expect(tagKeys).toEqual(['reason', 'route']);
  });

  it('regression: forbids reason catch-alls across the capture site', async () => {
    // Mirror of the R29 claim-route / R30 post-payment allow-list
    // pattern. Any new catch-all label masks the new path's signal.
    mockExchange.mockResolvedValue({ error: { message: 'bad' } });
    const GET = await loadGet();
    await GET(makeReq('/auth/callback?code=abc'));

    const forbidden = new Set([
      'unknown',
      'error',
      'failed',
      'authFailed',
      'sessionFailed',
      'exchangeFailed',
      'runFailed',
    ]);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(forbidden.has(reason), `disallowed reason: ${reason}`).toBe(false);
  });

  it('regression: reason is one of the locked allow-list values', async () => {
    mockExchange.mockResolvedValue({ error: { message: 'bad' } });
    const GET = await loadGet();
    await GET(makeReq('/auth/callback?code=abc'));
    const allowed = new Set(['exchangeCodeForSessionFailed']);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
  });
});
