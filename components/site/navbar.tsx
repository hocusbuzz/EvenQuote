// Top navigation. Server component — reads auth + profile so the
// CTA reflects whether the user is signed in (Dashboard vs Sign in)
// and, if they're an admin, surfaces the Admin link alongside
// Dashboard. The admin gate is redundant defense-in-depth: the
// /admin routes also run through middleware + requireAdmin() at
// render time, so even if this conditional were bypassed the
// actual admin pages would 302 non-admins to /.
//
// No mobile drawer on Phase 3 — the nav is deliberately minimal
// (just logo + one CTA), so a hamburger would be overkill.

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getUser, getProfile } from '@/lib/auth';

export async function SiteNavbar() {
  const user = await getUser();
  // Only fetch the profile when we know there's a user — saves a
  // round-trip on every public page render.
  const profile = user ? await getProfile() : null;
  const isAdmin = profile?.role === 'admin';

  return (
    <header className="sticky top-0 z-50 border-b border-foreground/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link
          href="/"
          className="font-display text-2xl font-bold tracking-tight hover:opacity-80"
          aria-label="EvenQuote home"
        >
          Even
          {/* Lime fill gets a thin ink outline so "Quote" stays
              legible on the cream navbar. -webkit-text-stroke is the
              modern all-browser-supported way to outline text
              without building it from four offset text-shadows.
              paint-order keeps the fill on top of the stroke so the
              lime is crisp, with the ink reading as a hairline
              around each letter. */}
          <span
            className="text-lime"
            style={{
              WebkitTextStroke: '0.75px hsl(var(--foreground))',
              paintOrder: 'stroke fill',
            }}
          >
            Quote
          </span>
        </Link>

        <nav className="flex items-center gap-2">
          {user ? (
            <>
              {isAdmin ? (
                // Subtle lime-bordered pill so it's visually distinct
                // from Dashboard without being loud. Only visible to
                // admins (profiles.role='admin').
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="border-lime hover:bg-lime"
                >
                  <Link href="/admin">Admin</Link>
                </Button>
              ) : null}
              <Button asChild variant="default" size="sm">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
              {/* Global sign-out — available on every page when logged
                  in. POSTs to /auth/signout which invalidates the
                  Supabase session and redirects to /. */}
              <form action="/auth/signout" method="POST">
                <Button type="submit" variant="ghost" size="sm">
                  Sign out
                </Button>
              </form>
            </>
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
