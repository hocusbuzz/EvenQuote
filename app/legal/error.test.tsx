// Tests for app/legal/error.tsx — segment-level error boundary.
//
// Locks the invariants that make a legal-segment boundary meaningfully
// different from app/error.tsx:
//
//   1. Copy is legal-appropriate — no "tripped over a cable".
//   2. error.message is NEVER rendered (future-proofing: legal may one
//      day pull dynamic data with embedded PII).
//   3. Digest IS surfaced when present; absent otherwise.
//   4. Try again is a type="button" and reset is not auto-invoked.
//   5. Support mailto present.
//   6. The secondary CTA sends the user to "/" (legal segment has no
//      natural "start over" target like /get-quotes does).
//
// Rendering strategy mirrors sibling tests (renderToStaticMarkup —
// vitest runs in Node; no DOM dep).

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ErrorBoundary from './error';

function render(
  error: Error & { digest?: string },
  reset: () => void = () => {},
) {
  return renderToStaticMarkup(
    React.createElement(ErrorBoundary, { error, reset }),
  );
}

describe('ErrorBoundary (app/legal/error.tsx)', () => {
  it('renders segment-appropriate copy (not the generic cable line)', () => {
    const html = render(new Error('x'));
    expect(html).toContain('This page didn');
    expect(html).toContain('legal copy');
    expect(html).toContain('Try again');
    expect(html).toContain('Back to home');
    // Guard against copy drift toward the generic boundary's line.
    expect(html).not.toContain('tripped over a cable');
    // Specific to this segment — we offer to send the text by email,
    // which is the right promise for a legal page.
    expect(html).toMatch(/send the current text/);
  });

  it('does NOT leak error.message to the rendered HTML', () => {
    // Realistic payload shapes if legal ever goes dynamic:
    //  • a Supabase error text with table name
    //  • an email pulled from a session
    //  • a raw file path from a transitive package
    //  • a stack frame that quotes user input
    const payloads = [
      'relation "legal_docs" does not exist',
      'unable to resolve user@example.com — not a valid recipient',
      '/var/task/node_modules/@anthropic-ai/sdk/dist/index.js',
      'SyntaxError: Unexpected token < in JSON at position 0 from https://cms.evenquote.com/api/legal/privacy',
    ];
    for (const payload of payloads) {
      const html = render(Object.assign(new Error(payload), { digest: 'd1' }));
      expect(html).not.toContain(payload);
      // sub-fragments that shouldn't leak either
      expect(html).not.toContain('legal_docs');
      expect(html).not.toContain('user@example.com');
      expect(html).not.toContain('anthropic-ai');
      expect(html).not.toContain('cms.evenquote.com');
    }
  });

  it('surfaces the digest when present', () => {
    const html = render(Object.assign(new Error('x'), { digest: 'dig_abc99' }));
    expect(html).toContain('dig_abc99');
    expect(html).toMatch(/Ref:\s*dig_abc99/);
  });

  it('omits the Ref line when digest is missing', () => {
    const html = render(new Error('x'));
    expect(html).not.toMatch(/Ref:/);
  });

  it('Try again is a type="button" and reset is not invoked by render', () => {
    const reset = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(ErrorBoundary, { error: new Error('x'), reset }),
    );
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>\s*Try again\s*<\/button>/);
    expect(reset).not.toHaveBeenCalled();
  });

  it('Back to home link targets the root', () => {
    // Legal segment has no natural "start over" target (unlike
    // /get-quotes → category picker). Home is the correct fallback;
    // lock that so a refactor can't redirect elsewhere.
    const html = render(new Error('x'));
    expect(html).toMatch(/href="\/"[^>]*>[\s\S]*?Back to home/);
  });

  it('exposes a mailto link for support', () => {
    const html = render(new Error('x'));
    expect(html).toContain('mailto:support@evenquote.com');
    expect(html).toContain('support@evenquote.com');
  });
});
