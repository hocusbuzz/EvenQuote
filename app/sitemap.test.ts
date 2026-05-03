import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const env = process.env as Record<string, string | undefined>;

// Mock the admin supabase client. The sitemap late-imports it, so we
// need to declare the mock before each test that exercises it.
const mockEq = vi.fn();
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockCreateAdminClient = vi.fn(() => ({ from: mockFrom }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mockCreateAdminClient,
}));

describe('sitemap', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateAdminClient.mockClear();
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockReset();
    env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
  });

  afterEach(() => {
    delete env.NEXT_PUBLIC_APP_URL;
  });

  it('includes / and /get-quotes even when the DB returns no categories', async () => {
    mockEq.mockResolvedValue({ data: [] });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://evenquote.com/');
    expect(urls).toContain('https://evenquote.com/get-quotes');
  });

  it('adds one dynamic entry per active service category', async () => {
    mockEq.mockResolvedValue({
      data: [
        { slug: 'moving', updated_at: '2026-01-01T00:00:00Z' },
        { slug: 'cleaning', updated_at: '2026-02-01T00:00:00Z' },
      ],
    });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://evenquote.com/get-quotes/moving');
    expect(urls).toContain('https://evenquote.com/get-quotes/cleaning');
  });

  it('filters to is_active categories only (delegates to Supabase .eq)', async () => {
    mockEq.mockResolvedValue({ data: [] });
    const sitemap = (await import('./sitemap')).default;
    await sitemap();
    expect(mockEq).toHaveBeenCalledWith('is_active', true);
  });

  it('falls back to static-only sitemap when the DB throws', async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error('unreachable');
    });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    // Only the STATIC_ENTRIES should remain — bumped 2 → 3 with the
    // /pricing standalone page (commit-pending).
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.url)).toEqual([
      'https://evenquote.com/',
      'https://evenquote.com/get-quotes',
      'https://evenquote.com/pricing',
    ]);
  });

  it('does NOT include gated routes (regression guard)', async () => {
    mockEq.mockResolvedValue({ data: [{ slug: 'moving', updated_at: null }] });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    for (const forbidden of [
      '/dashboard',
      '/admin',
      '/get-quotes/checkout',
      '/get-quotes/success',
      '/api/',
      '/auth/',
      '/legal/privacy',
      '/legal/terms',
    ]) {
      expect(urls.some((u) => u.includes(forbidden))).toBe(false);
    }
  });

  it('respects NEXT_PUBLIC_APP_URL override with trailing-slash stripping', async () => {
    env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    mockEq.mockResolvedValue({ data: [] });
    vi.resetModules();
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    // Exactly one slash after the host, never two
    for (const e of entries) {
      expect(e.url).not.toMatch(/https:\/\/[^/]+\/\//);
    }
    expect(entries[0].url).toBe('https://staging.evenquote.com/');
  });
});

// ── Observability contract — no capture (R35 audit) ──────────────────
// app/sitemap.ts is a public-bot-frequency endpoint. The R32/R33
// telemetry-sink + probe attestation pattern applies. Sitemap is the
// most-likely-to-fail surface in this audit (it actually does I/O,
// unlike robots.ts which is pure) — the existing try/catch block
// gracefully degrades to a static sitemap, which is the entire
// reason a Sentry capture would be redundant signal here.
//
// If a future maintainer adds a capture site to sitemap.ts, these
// tests fail and the maintainer must update both the test and the
// route header comment with the new contract.
describe('sitemap — observability contract — no capture', () => {
  const originalEnv = { ...process.env };
  const captureExceptionMock = vi.fn();
  const captureMessageMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
    mockCreateAdminClient.mockClear();
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockReset();
    process.env = { ...originalEnv };
    delete process.env.NEXT_PUBLIC_APP_URL;

    vi.doMock('@/lib/observability/sentry', () => ({
      captureException: (err: unknown, ctx?: unknown) =>
        captureExceptionMock(err, ctx),
      captureMessage: (msg: string, level?: string, ctx?: unknown) =>
        captureMessageMock(msg, level, ctx),
      init: vi.fn(),
      isEnabled: () => false,
      setUser: vi.fn(),
      __resetForTests: vi.fn(),
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('never captures on the happy path (DB returns categories)', async () => {
    mockEq.mockResolvedValue({
      data: [{ slug: 'moving', updated_at: '2026-01-01T00:00:00Z' }],
    });
    const sitemap = (await import('./sitemap')).default;
    await sitemap();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when DB returns no categories (data:[] no error)', async () => {
    mockEq.mockResolvedValue({ data: [] });
    const sitemap = (await import('./sitemap')).default;
    await sitemap();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when DB returns null data (no rows match)', async () => {
    mockEq.mockResolvedValue({ data: null });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    // Should degrade gracefully to STATIC_ENTRIES only.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when createAdminClient throws (DB unreachable at build time)', async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY unset');
    });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    // Static-only fallback.
    expect(entries).toHaveLength(3);
    // CRUCIAL: the explicit graceful-degradation catch must NOT
    // capture. This is the entire reason for the no-capture
    // contract — public-bot-frequency endpoint that should NOT
    // flood Sentry on a transient build-time DB hiccup.
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures when supabase select throws mid-call', async () => {
    mockEq.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    expect(entries).toHaveLength(3);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures with a NEXT_PUBLIC_APP_URL override + DB happy path', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    mockEq.mockResolvedValue({
      data: [{ slug: 'cleaning', updated_at: '2026-02-01T00:00:00Z' }],
    });
    const sitemap = (await import('./sitemap')).default;
    await sitemap();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('source-level grep (comments stripped): no captureException/captureMessage/Sentry import in app/sitemap.ts', async () => {
    // Drift-guard. Mirrors the canonical R34 middleware.ts source-
    // level grep test. Sitemap.ts is the only attested file in this
    // audit that does real I/O, so this guard is load-bearing — a
    // future maintainer might be tempted to "just add a Sentry
    // capture to the catch block" without realizing the public-bot-
    // crawl frequency makes that a Sentry-flood foot-gun.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const raw = await fs.readFile(
      path.resolve(process.cwd(), 'app/sitemap.ts'),
      'utf8'
    );
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const forbidden = [
      'captureException',
      'captureMessage',
      'Sentry.capture',
      "from '@/lib/observability/sentry'",
      "from '@sentry/nextjs'",
    ];
    for (const token of forbidden) {
      expect(
        source.includes(token),
        `app/sitemap.ts must not contain "${token}" (in code, comments excluded) — see route header observability contract`
      ).toBe(false);
    }
  });
});
