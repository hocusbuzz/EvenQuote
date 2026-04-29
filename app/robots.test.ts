import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import robots from './robots';

const env = process.env as Record<string, string | undefined>;

describe('robots', () => {
  beforeEach(() => {
    env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
  });
  afterEach(() => {
    delete env.NEXT_PUBLIC_APP_URL;
  });

  it('allows root and declares the sitemap', () => {
    const r = robots();
    expect(r.sitemap).toBe('https://evenquote.com/sitemap.xml');
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const wildcard = rules.find((x) => x.userAgent === '*');
    expect(wildcard).toBeDefined();
    const allow = Array.isArray(wildcard!.allow) ? wildcard!.allow : [wildcard!.allow];
    expect(allow).toContain('/');
  });

  it('disallows gated and transactional paths', () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const wildcard = rules.find((x) => x.userAgent === '*')!;
    const disallow = wildcard.disallow;
    const list = Array.isArray(disallow) ? disallow : [disallow];

    const mustBeBlocked = [
      '/api/',
      '/auth/',
      '/dashboard',
      '/admin',
      '/get-quotes/checkout',
      '/get-quotes/success',
    ];
    for (const p of mustBeBlocked) {
      expect(list).toContain(p);
    }
  });

  it('respects NEXT_PUBLIC_APP_URL with trailing-slash stripping', () => {
    env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    const r = robots();
    expect(r.sitemap).toBe('https://staging.evenquote.com/sitemap.xml');
  });

  it('falls back to the canonical domain when env is unset', () => {
    delete env.NEXT_PUBLIC_APP_URL;
    const r = robots();
    expect(r.sitemap).toBe('https://evenquote.com/sitemap.xml');
  });
});

// ── Observability contract — no capture (R35 audit) ──────────────────
// app/robots.ts is a public-bot-frequency endpoint. The R32/R33
// telemetry-sink + probe attestation pattern applies: we lock at the
// source level that no captureException/captureMessage/Sentry import
// is present, and at the runtime level that none of the documented
// input shapes ever transitively reaches a Sentry call.
//
// If a future maintainer adds a capture site to robots.ts, these
// tests fail and the maintainer must update both the test and the
// route header comment with the new contract.
describe('robots — observability contract — no capture', () => {
  const originalEnv = { ...process.env };
  const captureExceptionMock = vi.fn();
  const captureMessageMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
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

  it('never captures on a default invocation (no env override)', async () => {
    const robotsFn = (await import('./robots')).default;
    const r = robotsFn();
    expect(r.sitemap).toBe('https://evenquote.com/sitemap.xml');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures with a NEXT_PUBLIC_APP_URL override (with trailing slash)', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    const robotsFn = (await import('./robots')).default;
    const r = robotsFn();
    expect(r.sitemap).toBe('https://staging.evenquote.com/sitemap.xml');
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('never captures across pathological env values (whitespace, empty, very-long)', async () => {
    for (const value of [
      '',
      ' ',
      'https://x.example.com',
      'https://x.example.com/',
      'https://x.example.com////',
      'https://' + 'a'.repeat(2000) + '.example.com',
    ]) {
      vi.resetModules();
      process.env.NEXT_PUBLIC_APP_URL = value;
      const robotsFn = (await import('./robots')).default;
      // The function must not throw; we don't assert a specific
      // sitemap URL here — the only invariant is no capture.
      expect(() => robotsFn()).not.toThrow();
    }
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it('source-level grep (comments stripped): no captureException/captureMessage/Sentry import in app/robots.ts', async () => {
    // Drift-guard. Mirrors the canonical R34 middleware.ts source-
    // level grep test. Catches any future capture wiring that the
    // behavioural tests above might miss (e.g. a path not exercised
    // by the runtime cases). Comments are stripped before scanning
    // so the route header observability contract — which legitimately
    // names the forbidden tokens — does not false-positive.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const raw = await fs.readFile(
      path.resolve(process.cwd(), 'app/robots.ts'),
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
        `app/robots.ts must not contain "${token}" (in code, comments excluded) — see route header observability contract`
      ).toBe(false);
    }
  });
});
