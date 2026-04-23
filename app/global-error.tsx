// Root-layout error boundary.
//
// When an error is thrown in the root layout itself (or anything it
// depends on — font loading, theme provider, etc.), Next won't have a
// working layout to wrap a normal error.tsx with. This file is the
// bottom-of-the-stack fallback: it renders its own <html> and <body>.
//
// Keep this minimal and dependency-free — no fonts, no Tailwind classes
// that depend on the theme, no imports that could themselves throw.
// If this file throws, users see Next's generic static error page.

'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[global-error]', error.digest, error.message);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#fafafa',
          color: '#0a0a0a',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 480, padding: 24 }}>
          <p
            style={{
              fontSize: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: '#737373',
              margin: 0,
            }}
          >
            Critical error
          </p>
          <h1
            style={{
              fontSize: 36,
              fontWeight: 600,
              marginTop: 12,
              marginBottom: 0,
              lineHeight: 1.1,
            }}
          >
            EvenQuote is briefly offline.
          </h1>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.6,
              color: '#525252',
              marginTop: 16,
            }}
          >
            Sorry about that. Please refresh in a moment. If it persists, email{' '}
            <a href="mailto:support@evenquote.com" style={{ color: '#0a0a0a' }}>
              support@evenquote.com
            </a>
            .
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: '#737373', marginTop: 16 }}>
              Ref: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
