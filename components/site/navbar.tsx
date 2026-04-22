// Top navigation. Server component — reads auth state so the CTA
// reflects whether the user is signed in (Dashboard vs Sign in).
//
// No mobile drawer on Phase 3 — the nav is deliberately minimal
// (just logo + one CTA), so a hamburger would be overkill.

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getUser } from '@/lib/auth';

export async function SiteNavbar() {
  const user = await getUser();

  return (
    <header className="sticky top-0 z-50 border-b border-foreground/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link
          href="/"
          className="font-display text-2xl font-bold tracking-tight hover:opacity-80"
          aria-label="EvenQuote home"
        >
          Even<span className="text-lime">Quote</span>
        </Link>

        <nav className="flex items-center gap-2">
          {user ? (
            <Button asChild variant="default" size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild variant="lime" size="sm">
                <Link href="/get-quotes">Get quotes</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
