// Tests for the 404 page (`app/not-found.tsx`).
//
// The server component is wrapped in SiteNavbar + SiteFooter. For unit
// testing we stub those to marker strings so we don't pull the entire
// site chrome into the test boot — the assertions here are about the
// 404 body itself, not the nav/footer which have their own code paths.

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/components/site/navbar', () => ({
  SiteNavbar: () => React.createElement('nav', { 'data-testid': 'navbar' }, 'NAV'),
}));

vi.mock('@/components/site/footer', () => ({
  SiteFooter: () => React.createElement('footer', { 'data-testid': 'footer' }, 'FOOT'),
}));

import NotFound from './not-found';

describe('NotFound (app/not-found.tsx)', () => {
  // React renders apostrophes as HTML entities (&#x27;); strip those
  // before substring assertions so tests read naturally.
  const unescape = (s: string) => s.replace(/&#x27;/g, "'");

  it('renders the branded 404 copy', () => {
    const html = unescape(renderToStaticMarkup(React.createElement(NotFound)));
    expect(html).toContain("We couldn't find that page");
    expect(html).toContain('404 — Not Found');
  });

  it('preserves brand voice — no harsh / apologetic / corporate copy', () => {
    const html = unescape(renderToStaticMarkup(React.createElement(NotFound)));
    expect(html).toContain("didn't call anyone");
    expect(html).not.toContain('We apologize for the inconvenience');
  });

  it('renders navbar and footer chrome', () => {
    const html = renderToStaticMarkup(React.createElement(NotFound));
    expect(html).toContain('NAV');
    expect(html).toContain('FOOT');
  });

  it('exposes CTAs back to home and the intake surface', () => {
    const html = renderToStaticMarkup(React.createElement(NotFound));
    expect(html).toMatch(/href="\/"/);
    expect(html).toMatch(/href="\/get-quotes"/);
  });
});
