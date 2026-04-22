// Site footer. Editorial/newspaper feel — big type, monospace meta.
// Keeping it deliberately sparse: EvenQuote is pre-launch and a
// footer bloated with fake legal/social links would read as padding.

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

          {/* Product column */}
          <div>
            <p className="label-eyebrow mb-4 !text-cream/50">Product</p>
            <ul className="space-y-2 text-sm">
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
          </div>

          {/* Account column */}
          <div>
            <p className="label-eyebrow mb-4 !text-cream/50">Account</p>
            <ul className="space-y-2 text-sm">
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
          </div>
        </div>

        <div className="mt-16 flex flex-col items-start justify-between gap-4 border-t border-cream/10 pt-8 font-mono text-xs text-cream/50 sm:flex-row sm:items-center">
          <p>© {year} EvenQuote. All rights reserved.</p>
          <p className="uppercase tracking-widest">v0.1 — pre-launch</p>
        </div>
      </div>
    </footer>
  );
}
