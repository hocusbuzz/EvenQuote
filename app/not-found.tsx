// 404 page.
//
// Next 14 serves this for any unmatched route in the app directory, AND
// when a page / server component throws `notFound()`. Kept deliberately
// minimal — nav + a calm redirect back to /. No telemetry, no scripts.
//
// We wrap in the same SiteNavbar/SiteFooter as the landing page so an
// accidental bad link still feels like "you're on EvenQuote, just the
// wrong page" rather than a bare white error screen.

import Link from 'next/link';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';

export default function NotFound() {
  return (
    <>
      <SiteNavbar />
      <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center px-6 py-24 text-center">
        <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          404 — Not Found
        </p>
        <h1 className="mt-4 font-serif text-5xl font-semibold tracking-tight sm:text-6xl">
          We couldn't find that page.
        </h1>
        <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">
          The link may be broken, or the page may have moved. No harm done — we
          didn't call anyone.
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow transition hover:opacity-90"
          >
            Take me home
          </Link>
          <Link
            href="/get-quotes"
            className="inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-6 text-sm font-medium transition hover:bg-accent"
          >
            Get quotes
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
