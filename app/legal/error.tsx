// Segment-level error boundary for /legal/**.
//
// Legal pages are static today — mounted once, rendered as MDX/JSX
// prose. So why a dedicated boundary?
//
//   • Future-proofing. If /legal ever grows dynamic data (e.g. pulling
//     last-updated timestamps from a CMS, or injecting a contact
//     address from env), a render error would otherwise bubble to
//     app/error.tsx whose copy reads "We tripped over a cable" — a
//     tone that doesn't match the legal tab on a Terms page.
//   • Isolation. The legal layout keeps its nav/footer chrome; a
//     thrown render in the article slot shouldn't tear the whole app
//     error shell over the page.
//
// What we do NOT show:
//   • The error message. Even a static legal page could one day pull
//     a real user's email (e.g. for a unique-visitor "as-of" note);
//     error.message is presumed-PII by default.
//
// CLIENT component — reset() is a client-side callback per Next's
// error boundary contract.

'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function LegalErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side error was already logged by Next's runtime; this is
    // a client-side breadcrumb so a user opening DevTools sees the
    // digest (safe to surface) without needing the message.
    // eslint-disable-next-line no-console
    console.error('[legal/error]', error.digest);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-6 py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        Something went wrong
      </p>
      <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">
        This page didn&rsquo;t load right.
      </h1>
      <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">
        We couldn&rsquo;t render the legal copy just now. If you&rsquo;re trying
        to read the Terms or Privacy Policy and need them urgently, email{' '}
        <a className="underline underline-offset-4" href="mailto:support@evenquote.com">
          support@evenquote.com
        </a>{' '}
        with the reference below and we&rsquo;ll send the current text over.
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
          className="inline-flex h-11 items-center justify-center rounded-md border-2 border-ink bg-background px-6 text-sm font-medium transition hover:bg-accent"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
