// Site footer. Editorial/newspaper feel — big type, monospace meta.
// Keeping it deliberately sparse — a footer bloated with fake
// social/affiliate links would read as padding rather than substance.
//
// Marketing audit (2026-05-01): the "v0.1 — pre-launch" badge was
// removed from line 93. Reasoning from marketing/INBOX_FOR_DEV_CHANNEL.md:
// charging $9.99 for real work is incompatible with a "pre-launch"
// signal — every visitor reading that decided not to trust us with
// their card. Internal version tracking now lives in a /api/version
// endpoint + git history, not user-visible UI.

import Link from 'next/link';

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-32 border-t border-foreground/90 bg-ink text-cream">
      <div className="container py-16">
        <div className="grid gap-12 md:grid-cols-[2fr_1fr_1fr]">
          {/* Brand block */}
          <div>
            <Link
              href="/"
              className="font-display text-4xl font-bold tracking-tight text-cream hover:text-lime"
            >
              Even<span className="text-lime">Quote</span>
            </Link>
            <p className="mt-4 max-w-sm text-sm text-cream/60">
              Stop chasing quotes. Start comparing them.
            </p>
          </div>

          {/* Product column — semantic <nav> so screen readers announce
              the link group with its landmark name. */}
          <nav aria-label="Product">
            <p id="footer-product-heading" className="label-eyebrow mb-4 !text-cream/50">
              Product
            </p>
            <ul className="space-y-2 text-sm" aria-labelledby="footer-product-heading">
              <li>
                <Link href="/get-quotes" className="hover:text-lime">
                  Get quotes
                </Link>
              </li>
              <li>
                <Link href="/#how" className="hover:text-lime">
                  How it works
                </Link>
              </li>
              <li>
                <Link href="/#faq" className="hover:text-lime">
                  FAQ
                </Link>
              </li>
            </ul>
          </nav>

          {/* Account column */}
          <nav aria-label="Account">
            <p id="footer-account-heading" className="label-eyebrow mb-4 !text-cream/50">
              Account
            </p>
            <ul className="space-y-2 text-sm" aria-labelledby="footer-account-heading">
              <li>
                <Link href="/login" className="hover:text-lime">
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/signup" className="hover:text-lime">
                  Sign up
                </Link>
              </li>
              <li>
                <Link href="/dashboard" className="hover:text-lime">
                  Dashboard
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-16 flex flex-col items-start justify-between gap-4 border-t border-cream/10 pt-8 font-mono text-xs text-cream/50 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
            <p>© {year} EvenQuote · Hocusbuzz LLC</p>
            <span className="hidden sm:inline" aria-hidden>
              ·
            </span>
            <Link href="/legal/privacy" className="hover:text-lime">
              Privacy
            </Link>
            <span className="hidden sm:inline" aria-hidden>
              ·
            </span>
            <Link href="/legal/terms" className="hover:text-lime">
              Terms
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
