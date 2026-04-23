// Tests for the site footer.
//
// Lightweight — we mock Next's <Link> so we don't need the app router
// to render. The assertions are:
//   1. Brand lockup, slogan and copyright year render.
//   2. Each link column is wrapped in a semantic <nav> with an
//      aria-label so screen-reader landmarks aren't ambiguous.
//   3. No legal links are wired in yet (footer intentionally unlinked
//      pending counsel review — see Round 2 of the daily report).
//      This test locks that in so a future edit doesn't accidentally
//      publish unreviewed legal pages.

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
    expect(html).toContain(`© ${year} EvenQuote. All rights reserved.`);
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

  it('does NOT link /legal/privacy or /legal/terms (pending counsel review)', () => {
    // This is a regression guard — Round 2 flagged that publishing the
    // unreviewed drafts would be a real-money mistake. If counsel
    // approves and we wire links in, delete this test along with the
    // wiring PR.
    const html = renderToStaticMarkup(React.createElement(SiteFooter));
    expect(html).not.toContain('/legal/privacy');
    expect(html).not.toContain('/legal/terms');
  });
});
