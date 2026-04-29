// Tests for app/layout.tsx — specifically the CSP nonce threading.
//
// The Round 15 middleware scaffold generates a per-request nonce when
// `CSP_NONCE_ENABLED=true` and sets it on the request's `x-nonce`
// header. The root layout must read that header and apply it to every
// inline <script> it renders, or those scripts will be blocked once
// `CSP_ENFORCE=true` flips the CSP from report-only to enforcing.
//
// We test BOTH modes so a future refactor can't silently drop either:
//
//   1. Header present → nonce attribute set on BOTH JSON-LD scripts.
//   2. Header absent  → nonce attribute omitted (React behaviour when
//      the prop is undefined).
//
// Strategy: mock `next/headers`, `next/font/google`, `geist/font/*`,
// then import RootLayout and render to static markup. Same rendering
// strategy as the sibling error boundaries (renderToStaticMarkup +
// regex assertions).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Hoisted so vi.mock can reference it. Each test overrides the value
// via `headerValue` below before importing the layout.
let headerValue: string | null = null;

vi.mock('next/headers', () => ({
  headers: () => ({
    get: (name: string) => (name === 'x-nonce' ? headerValue : null),
  }),
}));

// next/font/google runs a build-time transform; in a unit test the
// import throws. Stub it with a shape-compatible object so layout.tsx
// can spread `fraunces.variable` without exploding.
vi.mock('next/font/google', () => ({
  Fraunces: () => ({
    variable: '--font-fraunces',
    className: 'font-fraunces-mock',
  }),
}));

// Geist ships a pre-built module but pulls in Next internals that the
// test env doesn't have. Stub with the same shape.
vi.mock('geist/font/sans', () => ({
  GeistSans: { variable: '--font-geist-sans', className: 'font-geist-sans-mock' },
}));
vi.mock('geist/font/mono', () => ({
  GeistMono: { variable: '--font-geist-mono', className: 'font-geist-mono-mock' },
}));

// globals.css is a side-effect import — Vite/Vitest can't parse it
// without a CSS plugin. Stub as an empty module.
vi.mock('./globals.css', () => ({}));

async function loadLayout() {
  return (await import('./layout')).default;
}

function render(children: React.ReactNode) {
  return async () => {
    const Layout = await loadLayout();
    return renderToStaticMarkup(
      // The JSX from Layout is trusted to be valid — we type-cast so
      // TS doesn't complain about the children arg shape.
      React.createElement(Layout, null, children),
    );
  };
}

describe('RootLayout CSP nonce threading', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('applies the nonce to BOTH JSON-LD scripts when x-nonce header is present', async () => {
    headerValue = 'test-nonce-abc123';
    const html = await render(<main data-testid="child" />)();

    // Two JSON-LD scripts — one Organization, one WebSite. Both must
    // carry the nonce so the enforcing CSP doesn't block either.
    const matches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>/g);
    expect(matches).toHaveLength(2);
    for (const tag of matches ?? []) {
      expect(tag).toContain('nonce="test-nonce-abc123"');
    }

    // Sanity: the actual schema content renders (regression for the
    // dangerouslySetInnerHTML plumbing).
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"@type":"WebSite"');
  });

  it('omits the nonce attribute when x-nonce header is absent', async () => {
    // When CSP_NONCE_ENABLED=false (or middleware hasn't run yet in
    // local dev without the flag), headers().get('x-nonce') returns
    // null. React renders `nonce={undefined}` as an absent attribute
    // entirely — which is what the static-CSP mode expects.
    headerValue = null;
    const html = await render(<main />)();

    const matches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>/g);
    expect(matches).toHaveLength(2);
    for (const tag of matches ?? []) {
      expect(tag).not.toMatch(/nonce=/);
    }
  });

  it('does not accidentally stringify "null" or "undefined" as the nonce value', async () => {
    // A common foot-gun if someone refactors to `nonce={String(value)}`
    // or similar — the nonce attribute would silently become the
    // literal string 'null' or 'undefined', which passes shape checks
    // but fails CSP evaluation. Lock the correct behaviour.
    headerValue = null;
    const html = await render(<main />)();
    expect(html).not.toMatch(/nonce="null"/);
    expect(html).not.toMatch(/nonce="undefined"/);
  });

  it('surfaces the x-nonce value verbatim (no re-encoding)', async () => {
    // Nonces are base64 and can contain "=" padding. A refactor that
    // runs them through encodeURIComponent would break the CSP match.
    headerValue = 'bXl0ZXN0bm9uY2U=';
    const html = await render(<main />)();
    expect(html).toContain('nonce="bXl0ZXN0bm9uY2U="');
    expect(html).not.toMatch(/nonce="bXl0ZXN0bm9uY2U%3D"/);
  });

  it('renders the skip-to-content a11y link regardless of nonce mode', async () => {
    // Non-nonce invariant that's easy to lose on a refactor — make sure
    // neither the nonce plumbing nor the script order removed it.
    headerValue = null;
    const html = await render(<main />)();
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('Skip to main content');
  });
});
