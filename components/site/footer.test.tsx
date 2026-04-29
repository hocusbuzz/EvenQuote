// Tests for the site footer.
//
// Lightweight — we mock Next's <Link> so we don't need the app router
// to render. The assertions are:
//   1. Brand lockup, slogan and copyright year render.
//   2. Each link column is wrapped in a semantic <nav> with an
//      aria-label so screen-reader landmarks aren't ambiguous.
//   3. R47.5: legal links are now LIVE — privacy + terms are wired
//      into the footer and indexable. The previous "no legal links"
//      regression guard has been replaced with a positive lock that
//      both links are present.

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.HTMLAttributes<HTMLAnchorElement>) =>
    React.createElement('a', { href, ...rest }, children),
}));

import { SiteFooter } from './footer';

describe('SiteFooter', () => {
  it('renders brand, slogan, and current-year copyright', () => {
    const html = renderToStaticMarkup(React.createElement(SiteFooter));
    const year = new Date().getFullYear();
    expect(html).toContain('Even');
    expect(html).toContain('Quote');
    expect(html).toContain('Stop chasing quotes. Start comparing them.');
    // R47.5: copyright now identifies the operating entity.
    expect(html).toContain(`© ${year} EvenQuote · Hocusbuzz LLC`);
  });

  it('wraps each link column in a semantic <nav> with an aria-label', () => {
    const html = renderToStaticMarkup(React.createElement(SiteFooter));
    expect(html).toMatch(/<nav[^>]*aria-label="Product"/);
    expect(html).toMatch(/<nav[^>]*aria-label="Account"/);
  });

  it('wires each link column <ul> to its heading via aria-labelledby', () => {
    const html = renderToStaticMarkup(React.createElement(SiteFooter));
    expect(html).toContain('aria-labelledby="footer-product-heading"');
    expect(html).toContain('aria-labelledby="footer-account-heading"');
  });

  it('links /legal/privacy and /legal/terms (R47.5)', () => {
    // The previous regression guard was "no legal links until
    // counsel review." Counsel review is parked as a launch-day
    // prerequisite (see soft-launch runbook); the published copy
    // is acceptable for soft launch and matches actual operations.
    // The lock is now positive: both links must be present so a
    // future footer rewrite can't accidentally drop them.
    const html = renderToStaticMarkup(React.createElement(SiteFooter));
    expect(html).toContain('/legal/privacy');
    expect(html).toContain('/legal/terms');
  });
});
