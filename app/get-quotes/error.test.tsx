// Tests for app/get-quotes/error.tsx — segment-level error boundary.
//
// Invariants locked here:
//
//   1. error.message is NEVER rendered — the intake can throw from any
//      of a dozen places (Supabase, Stripe session lookup, geo), and
//      error.message could leak table names, PII, or internal paths.
//   2. The digest IS surfaced when present (support correlation) and
//      omitted otherwise.
//   3. Try again has a button binding (reset is not auto-invoked).
//   4. The "Start over" link points at /get-quotes — the WHOLE reason
//      this boundary is segment-local instead of just using app/error.tsx.
//   5. Support email is a clickable mailto.
//
// Same strategy as app/error.test.tsx — renderToStaticMarkup since
// vitest runs in Node and there's no DOM / testing-library dep.

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

describe('ErrorBoundary (app/get-quotes/error.tsx)', () => {
  it('renders the segment-specific copy', () => {
    const html = render(new Error('x'));
    expect(html).toContain('We lost the thread mid-request');
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Try again');
    expect(html).toContain('Start over');
    // Reassurance: the user wasn't charged. Important in a checkout flow.
    expect(html).toMatch(/haven.*charged/);
  });

  it('does NOT leak error.message to the rendered HTML', () => {
    // Spread of realistic throw shapes that actually occur in the
    // intake flow: Postgres error text, Stripe session ids, contact
    // email echoes, filesystem paths.
    const payloads = [
      'duplicate key value violates unique constraint "quote_requests_pkey"',
      'Stripe: No such checkout.session: cs_test_abc123',
      'contact_email = "user@example.com" was invalid',
      '/var/task/node_modules/@supabase/postgrest-js/dist/main/lib/PostgrestError.js',
    ];
    for (const payload of payloads) {
      const html = render(Object.assign(new Error(payload), { digest: 'd1' }));
      expect(html).not.toContain(payload);
      // sub-fragments that shouldn't leak either
      expect(html).not.toContain('duplicate key');
      expect(html).not.toContain('cs_test_abc123');
      expect(html).not.toContain('user@example.com');
      expect(html).not.toContain('PostgrestError');
    }
  });

  it('surfaces the digest when present', () => {
    const html = render(Object.assign(new Error('x'), { digest: 'dig_xyz42' }));
    expect(html).toContain('dig_xyz42');
    expect(html).toMatch(/Ref:\s*dig_xyz42/);
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

  it('Start over link targets /get-quotes — keeps the user in the funnel', () => {
    const html = render(new Error('x'));
    // Segment-local boundary's whole point is NOT to send mid-funnel
    // users back to /. Lock the href so a refactor can't silently
    // defeat that.
    expect(html).toMatch(/href="\/get-quotes"[^>]*>[\s\S]*?Start over/);
    expect(html).not.toMatch(/href="\/"[\s\S]*?Start over/);
  });

  it('exposes a mailto link for support', () => {
    const html = render(new Error('x'));
    expect(html).toContain('mailto:support@evenquote.com');
    expect(html).toContain('support@evenquote.com');
  });
});
