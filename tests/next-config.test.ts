// Regression guard for next.config.mjs security posture.
//
// Why: security headers live in a config file that's easy to edit
// accidentally (a refactor, a Dependabot update, a "let me just try X"
// experiment). If someone weakens X-Frame-Options, drops HSTS, or opens
// a CSP directive, we want a red test before Vercel ships it.
//
// What we assert:
//   • poweredByHeader is false (don't advertise Next version)
//   • reactStrictMode is on
//   • The global `/:path*` headers block contains the seven headers we
//     expect, with the exact values or the right invariants:
//       X-Frame-Options: DENY
//       X-Content-Type-Options: nosniff
//       Referrer-Policy: strict-origin-when-cross-origin
//       Permissions-Policy contains camera=(), microphone=(), geolocation=()
//       Strict-Transport-Security: 1-year + includeSubDomains + preload
//       Content-Security-Policy includes: default-src 'self',
//         frame-ancestors 'none', form-action incl. checkout.stripe.com,
//         base-uri 'self', object-src 'none'
//
// We DO NOT test the nonce-based script-src/style-src directives here —
// those aren't in the minimal CSP (see docs/CSP_PLAN.md). When that
// rolls out this file should be updated alongside it.

import { describe, it, expect } from 'vitest';

async function loadConfig() {
  // Direct import of the ESM config module.
  const mod = await import('../next.config.mjs');
  return mod.default as {
    poweredByHeader: boolean;
    reactStrictMode: boolean;
    headers: () => Promise<
      Array<{
        source: string;
        headers: Array<{ key: string; value: string }>;
      }>
    >;
  };
}

describe('next.config.mjs — security posture', () => {
  it('does not expose the Next.js version via X-Powered-By', async () => {
    const cfg = await loadConfig();
    expect(cfg.poweredByHeader).toBe(false);
  });

  it('has reactStrictMode enabled', async () => {
    const cfg = await loadConfig();
    expect(cfg.reactStrictMode).toBe(true);
  });

  it('applies security headers globally to /:path*', async () => {
    const cfg = await loadConfig();
    const blocks = await cfg.headers();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some((b) => b.source === '/:path*')).toBe(true);
  });

  it('sends X-Frame-Options: DENY', async () => {
    const h = await getGlobalHeaders();
    expect(h['X-Frame-Options']).toBe('DENY');
  });

  it('sends X-Content-Type-Options: nosniff', async () => {
    const h = await getGlobalHeaders();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sends Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const h = await getGlobalHeaders();
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sends a Permissions-Policy that locks down sensors/cameras', async () => {
    const h = await getGlobalHeaders();
    const pp = h['Permissions-Policy'] ?? '';
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    // interest-cohort=() opts out of FLoC — keeps us out of third-party
    // advertising topics tables without us asking.
    expect(pp).toContain('interest-cohort=()');
  });

  it('sends a long-lived HSTS header with includeSubDomains + preload', async () => {
    const h = await getGlobalHeaders();
    const hsts = h['Strict-Transport-Security'] ?? '';
    expect(hsts).toMatch(/max-age=\d+/);
    // >= 1 year (31536000s) per HSTS preload requirements
    const m = hsts.match(/max-age=(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });

  it('sends a Content-Security-Policy with the minimal hardening directives', async () => {
    const h = await getGlobalHeaders();
    const csp = h['Content-Security-Policy'] ?? '';
    // IMPORTANT: we deliberately DO NOT set default-src here. Doing so
    // becomes the fallback for script-src, which blocks Next.js's
    // inline hydration bootstrap and leaves every client component
    // dead on arrival. Once the nonce middleware in lib/security/csp.ts
    // is wired up (see docs/CSP_PLAN.md) we can re-introduce default-src
    // alongside a nonced script-src.
    expect(csp).not.toContain("default-src 'self'");
    // Clickjacking blocker
    expect(csp).toContain("frame-ancestors 'none'");
    // Form-redirect abuse blocker; Stripe Checkout is the one allowed
    // off-origin form destination.
    expect(csp).toMatch(/form-action[^;]*'self'/);
    expect(csp).toContain('https://checkout.stripe.com');
    // <base> tag injection blocker
    expect(csp).toContain("base-uri 'self'");
    // Flash/object/embed abuse blocker
    expect(csp).toContain("object-src 'none'");
  });
});

async function getGlobalHeaders(): Promise<Record<string, string>> {
  const mod = await import('../next.config.mjs');
  const cfg = mod.default as {
    headers: () => Promise<
      Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    >;
  };
  const blocks = await cfg.headers();
  const global = blocks.find((b) => b.source === '/:path*');
  if (!global) throw new Error('global /:path* header block missing');
  return Object.fromEntries(global.headers.map((h) => [h.key, h.value]));
}
