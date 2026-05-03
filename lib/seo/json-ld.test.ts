// Tests for the JsonLd component contract.
//
// React's renderToStaticMarkup is the simplest way to assert what the
// browser would receive. We don't snapshot — snapshots churn on
// formatting changes. Instead we lock the things that matter for SEO:
//   • script tag is type="application/ld+json"
//   • the data is JSON-stringified verbatim
//   • the @context + @type round-trip cleanly through stringify
//   • when CSP_NONCE_ENABLED puts an x-nonce on the request, the
//     attribute is present (regression guard for the strict-CSP path)
//   • when no nonce header is set, the attribute is absent (regression
//     guard for the static-CSP path — adding nonce='' would break it)

import { describe, it, expect, vi } from 'vitest';

const headersMock = vi.fn();
vi.mock('next/headers', () => ({
  headers: () => headersMock(),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { JsonLd } from './json-ld';

function setNoNonce() {
  headersMock.mockReturnValue({ get: () => null });
}

function setNonce(value: string) {
  headersMock.mockReturnValue({
    get: (k: string) => (k === 'x-nonce' ? value : null),
  });
}

describe('JsonLd', () => {
  it('renders a <script type="application/ld+json"> with the data JSON-stringified verbatim', () => {
    setNoNonce();
    const html = renderToStaticMarkup(
      JsonLd({
        data: {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: 'EvenQuote',
        },
      }),
    );
    expect(html).toMatch(/^<script type="application\/ld\+json"/);
    // dangerouslySetInnerHTML inlines the JSON unescaped (modulo HTML
    // chars that React still escapes in string position — none here).
    expect(html).toContain(
      '{"@context":"https://schema.org","@type":"Product","name":"EvenQuote"}',
    );
    // No nonce attribute when middleware doesn't set one — locks the
    // static-CSP behavior so a future refactor doesn't render
    // `nonce=""` (which is technically invalid + would break strict-CSP).
    expect(html).not.toContain('nonce=');
  });

  it('renders the nonce attribute when middleware set x-nonce on the request', () => {
    setNonce('abc123');
    const html = renderToStaticMarkup(
      JsonLd({ data: { '@type': 'WebSite' } }),
    );
    expect(html).toContain('nonce="abc123"');
  });

  it('handles nested objects + arrays in the data without losing structure', () => {
    setNoNonce();
    const html = renderToStaticMarkup(
      JsonLd({
        data: {
          '@type': 'Service',
          provider: { '@type': 'Organization', name: 'EvenQuote' },
          areaServed: ['US', 'CA'],
        },
      }),
    );
    expect(html).toContain('"provider":{"@type":"Organization","name":"EvenQuote"}');
    expect(html).toContain('"areaServed":["US","CA"]');
  });
});
