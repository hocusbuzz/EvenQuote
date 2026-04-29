// Segment-level error boundary for /get-quotes/**.
//
// Next 14 App Router convention: a nearest-ancestor error.tsx catches
// uncaught errors thrown by any page/layout within its segment. Without
// this file the root app/error.tsx would catch them, which is fine but
// shows a more generic "we tripped over a cable" message.
//
// Why a dedicated boundary for this segment:
//   • The intake flow is the single revenue path. A user who trips an
//     error mid-intake is more valuable to get back into the funnel
//     than to send home. The copy here invites them to restart from
//     /get-quotes (category picker) rather than /.
//   • Keeps the site chrome *outside* the segment rendered — SiteNavbar /
//     SiteFooter inside sibling segments (landing page, dashboard) stay
//     alive if a user navigates away mid-error.
//   • The root error.tsx (app/error.tsx) still catches anything that
//     bubbles past this one or out of a sibling segment.
//
// What we intentionally DO NOT show:
//   • The error message or stack — the intake can throw from any of a
//     dozen places (Supabase, Stripe session lookup, third-party geo).
//     Rendering error.message would leak internals. Only the digest
//     (Next's opaque id) is safe to surface, and only as a support
//     reference.
//
// CLIENT component — required by Next because reset() is a client-side
// callback.

'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GetQuotesErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side error was already logged by Next's runtime; this is a
    // client-side breadcrumb so a user opening DevTools sees the digest.
    // eslint-disable-next-line no-console
    console.error('[get-quotes/error]', error.digest);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-6 py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        Something went wrong
      </p>
      <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">
        We lost the thread mid-request.
      </h1>
      <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">
        This one&rsquo;s on us — you haven&rsquo;t been charged. Try again, or start
        from the top. If it keeps happening, email{' '}
        <a className="underline underline-offset-4" href="mailto:support@evenquote.com">
          support@evenquote.com
        </a>{' '}
        with the reference below and we&rsquo;ll sort it out by hand.
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
          href="/get-quotes"
          className="inline-flex h-11 items-center justify-center rounded-md border-2 border-ink bg-background px-6 text-sm font-medium transition hover:bg-accent"
        >
          Start over
        </Link>
      </div>
    </main>
  );
}
