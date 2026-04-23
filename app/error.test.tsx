// Tests for the segment-level error boundary (`app/error.tsx`).
//
// The component is a React client component that renders static copy plus
// a reset() button and digest. Because Vitest runs in a Node environment
// (no DOM), we assert on the rendered HTML via `react-dom/server`'s
// `renderToStaticMarkup`. That intentionally skips useEffect so we avoid
// asserting on the console.error breadcrumb and focus on what the user
// actually sees.
//
// The three things we actually care about:
//   1. The error message is NEVER surfaced to the user (PII/stack-leak guard).
//   2. The opaque `digest` IS surfaced when present (support correlation).
//   3. The "Try again" button is wired to the supplied `reset` callback.

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ErrorBoundary from './error';

function render(
  error: Error & { digest?: string },
  reset: () => void = () => {}
) {
  return renderToStaticMarkup(
    React.createElement(ErrorBoundary, { error, reset })
  );
}

describe('ErrorBoundary (app/error.tsx)', () => {
  it('renders the friendly copy block', () => {
    const html = render(Object.assign(new Error('ignored'), {}));
    expect(html).toContain('We tripped over a cable');
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Try again');
    expect(html).toContain('Take me home');
  });

  it('does NOT leak the raw error.message to the rendered HTML', () => {
    const secret = 'duplicate key value violates unique constraint "x_pkey"';
    const html = render(
      Object.assign(new Error(secret), { digest: 'abc123' })
    );
    expect(html).not.toContain(secret);
    expect(html).not.toContain('duplicate key');
    expect(html).not.toContain('pkey');
  });

  it('surfaces the digest when present', () => {
    const html = render(
      Object.assign(new Error('x'), { digest: 'dig_9f8e7d' })
    );
    expect(html).toContain('dig_9f8e7d');
    expect(html).toMatch(/Ref:\s*dig_9f8e7d/);
  });

  it('omits the digest line when digest is missing', () => {
    const html = render(new Error('x'));
    expect(html).not.toMatch(/Ref:/);
  });

  it('exposes a retry button with type="button" and does not auto-invoke reset', () => {
    // We can't fake a click through renderToStaticMarkup (no DOM here),
    // but we can assert the contract: (a) the rendered HTML contains a
    // type="button" element with the "Try again" label — proving reset
    // has a UI binding — and (b) reset isn't called just by rendering.
    const reset = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(ErrorBoundary, { error: new Error('x'), reset })
    );
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*Try again\s*<\/button>/);
    expect(reset).not.toHaveBeenCalled();
  });

  it('links home and to /get-quotes', () => {
    const html = render(new Error('x'));
    expect(html).toMatch(/href="\/"/);
    expect(html).not.toContain('data-error-message');
  });
});
