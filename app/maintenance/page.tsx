// /maintenance — public gate shown when MAINTENANCE_MODE=true.
//
// Rendered by a middleware rewrite, not a redirect, so the URL bar
// stays on whatever the visitor typed. Keep this page fully static
// (no Supabase / Stripe / external API calls) so it works even if
// those integrations are the reason we're in maintenance mode.

import Link from 'next/link';

export const dynamic = 'force-static';
export const revalidate = false;

export const metadata = {
  title: 'We’ll be right back — EvenQuote',
  description:
    'EvenQuote is undergoing scheduled maintenance. Leave your email and we’ll ping you the moment quotes are live again.',
  robots: { index: false, follow: false },
};

export default function MaintenancePage() {
  return (
    <main className="relative min-h-dvh bg-cream text-ink">
      {/* Subtle grid + blob so the page isn't just empty space */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.18] [background-image:linear-gradient(to_right,#0A0A0A_1px,transparent_1px),linear-gradient(to_bottom,#0A0A0A_1px,transparent_1px)] [background-size:32px_32px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 -z-10 h-[420px] w-[420px] rounded-full bg-lime blur-3xl opacity-40"
      />

      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-6 py-10 sm:px-10">
        <header className="flex items-center justify-between">
          <span className="font-display text-xl font-bold tracking-tight">
            EvenQuote
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wider">
            <span className="h-2 w-2 animate-pulse rounded-full bg-lime" />
            Tuning the dial
          </span>
        </header>

        <section className="flex flex-1 flex-col justify-center py-16">
          <p className="label-eyebrow mb-4 text-xs font-semibold uppercase tracking-widest">
            Back in a blink
          </p>
          <h1 className="font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            We&rsquo;re polishing the phones.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink/70">
            EvenQuote is on a brief maintenance break while we make sure every
            quote lands perfectly in your inbox. No charges can be made right
            now — we&rsquo;ll be back shortly.
          </p>

          <div className="mt-10 inline-flex w-fit items-center gap-4 rounded-lg border-2 border-ink bg-white p-5 shadow-[6px_6px_0_0_#0A0A0A]">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-lime">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6 text-ink"
                aria-hidden
              >
                <path d="M22 16.92V21a1 1 0 0 1-1.09 1 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 3.13 4.09 1 1 0 0 1 4.11 3h4.09a1 1 0 0 1 1 .75l1 4a1 1 0 0 1-.29 1L8.21 10.2a16 16 0 0 0 6 6l1.45-1.7a1 1 0 0 1 1-.29l4 1a1 1 0 0 1 .75 1z" />
              </svg>
            </div>
            <div className="text-sm">
              <p className="font-semibold">Scheduled maintenance</p>
              <p className="text-ink/60">
                Quotes resume in a few hours. Ongoing jobs continue uninterrupted.
              </p>
            </div>
          </div>

          <div className="mt-10 flex flex-wrap gap-3 text-sm">
            <a
              href="mailto:support@evenquote.com"
              className="inline-flex h-11 items-center justify-center rounded-md border-2 border-ink bg-white px-5 font-semibold text-ink shadow-[4px_4px_0_0_#0A0A0A] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_0_#0A0A0A]"
            >
              Email support
            </a>
            <Link
              href="https://hocusbuzz.com"
              className="inline-flex h-11 items-center justify-center rounded-md border-2 border-transparent px-5 font-medium text-ink/60 underline-offset-4 hover:text-ink hover:underline"
            >
              More from HocusBuzz →
            </Link>
          </div>
        </section>

        <footer className="mt-auto border-t border-ink/10 pt-6 text-xs text-ink/50">
          <p>
            © {new Date().getFullYear()} EvenQuote, a HocusBuzz product. Thanks
            for your patience.
          </p>
        </footer>
      </div>
    </main>
  );
}
