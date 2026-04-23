// Segment-level error boundary (Next 14 App Router convention).
//
// Triggered when an uncaught error bubbles up from a page / layout
// inside any route segment. Receives the error + a reset() callback
// that re-renders the failing segment.
//
// Why this file is a CLIENT component:
//   Next requires error.tsx to be a client component because reset()
//   is a client-side handler. The 'use client' directive is mandatory.
//
// What we intentionally DO NOT show:
//   • The error message or stack — could leak table names, internal
//     paths, or PII depending on where the throw originated. Only the
//     digest (Next's opaque id) is safe to surface, and only for support
//     correlation.

'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log client-side so the browser console still has a breadcrumb; the
    // server-side error was already logged by Next's runtime.
    // eslint-disable-next-line no-console
    console.error('[error-boundary]', error.digest, error.message);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-6 py-24 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        Something went wrong
      </p>
      <h1 className="mt-4 font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
        We tripped over a cable.
      </h1>
      <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">
        This is on us, not you. The team has been notified. Try reloading — if
        it keeps happening, email us and we'll sort it out.
      </p>
      {error.digest && (
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          Ref: {error.digest}
        </p>
      )}
      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow transition hover:opacity-90"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-6 text-sm font-medium transition hover:bg-accent"
        >
          Take me home
        </Link>
      </div>
    </main>
  );
}
