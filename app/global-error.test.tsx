// Tests for the root-layout fallback error boundary (`app/global-error.tsx`).
//
// The component renders its own <html>/<body> with inline styles — no
// Tailwind, no theme, no font imports that could themselves throw. That
// minimal-dependency constraint is what these tests mainly lock down.
//
// Assertions:
//   1. The raw error.message is NEVER reflected to the HTML.
//   2. The digest IS surfaced when present.
//   3. The support email link exists.
//   4. No Tailwind `class=` attributes are used (inline style only).

import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import GlobalError from './global-error';

function render(error: Error & { digest?: string }) {
  return renderToStaticMarkup(
    React.createElement(GlobalError, { error, reset: () => {} })
  );
}

describe('GlobalError (app/global-error.tsx)', () => {
  it('renders the minimal fallback copy', () => {
    const html = render(new Error('whatever'));
    expect(html).toContain('EvenQuote is briefly offline');
    expect(html).toContain('Critical error');
  });

  it('includes a mailto link to support', () => {
    const html = render(new Error('x'));
    expect(html).toContain('mailto:support@evenquote.com');
  });

  it('never surfaces error.message', () => {
    const msg = 'TypeError: Cannot read properties of undefined (reading foo)';
    const html = render(Object.assign(new Error(msg), { digest: 'd1' }));
    expect(html).not.toContain(msg);
    expect(html).not.toContain('Cannot read properties');
    expect(html).not.toContain('TypeError');
  });

  it('surfaces digest when present', () => {
    const html = render(
      Object.assign(new Error('x'), { digest: 'global_dig_42' })
    );
    expect(html).toContain('global_dig_42');
  });

  it('omits the Ref line when digest is absent', () => {
    const html = render(new Error('x'));
    expect(html).not.toMatch(/Ref:/);
  });

  it('uses inline styles only — no Tailwind/class attributes', () => {
    const html = render(new Error('x'));
    // No className-based styling: the whole point of this boundary is
    // dependency-free rendering. Grepping for `class=` catches any
    // regression that introduces Tailwind or theme dependency.
    expect(html).not.toMatch(/class=/);
    // Must contain style= to prove inline styling is in effect.
    expect(html).toMatch(/style=/);
  });

  it('wraps output in <html> + <body> for the root-layout scenario', () => {
    const html = render(new Error('x'));
    expect(html).toMatch(/^<html\s/);
    expect(html).toContain('<body');
    expect(html).toContain('</html>');
  });
});
