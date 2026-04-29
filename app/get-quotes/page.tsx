// /get-quotes — category picker.
//
// Replaces the old direct-to-moving intake form. Phase 6.1 made the
// platform multi-vertical: this page is now a crossroads. Each tile
// links to /get-quotes/[slug] which is the dynamic dispatcher (either
// a live intake form or a waitlist capture for deferred verticals).
//
// We pull the tile data from the service_categories table so new
// categories don't require a code change — just seed a row and add a
// slug to ACTIVE_FORM_SLUGS in app/get-quotes/[category]/page.tsx.

import Link from 'next/link';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata = {
  title: 'Get quotes — EvenQuote',
  description: 'Pick a service. We\'ll call local pros and send you the numbers.',
};

// Render per-request so adding/disabling a service_categories row reflects
// immediately without needing a redeploy. Without this, Next.js may
// statically generate the page at build time — and if the build sandbox
// can't reach Supabase (or the table was empty at deploy time), every
// future request serves an empty grid even after rows are seeded.
// Discovered during launch when the deploy succeeded but the page rendered
// no service cards despite 4 active rows in the DB.
export const dynamic = 'force-dynamic';

// These slugs render a live intake form; everything else renders the
// waitlist capture. Keep in sync with app/get-quotes/[category]/page.tsx.
const LIVE_SLUGS = new Set(['moving', 'cleaning']);

type CategoryRow = {
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
};

export default async function GetQuotesPage() {
  const admin = createAdminClient();
  const { data: categories } = await admin
    .from('service_categories')
    .select('name, slug, description, icon')
    .eq('is_active', true)
    .order('name');

  const tiles = (categories ?? []) as CategoryRow[];

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-4xl py-12 sm:py-16">
        <div className="mb-10">
          <p className="label-eyebrow mb-2">Pick a service</p>
          <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
            What kind of pro do you need?
          </h1>
          <p className="mt-3 text-muted-foreground">
            We'll call local businesses and send you back a clean comparison — prices,
            availability, what's included. $9.99 per request.
          </p>
        </div>

        <ul className="grid gap-4 sm:grid-cols-2">
          {tiles.map((c) => {
            const live = LIVE_SLUGS.has(c.slug);
            return (
              <li key={c.slug}>
                <Link
                  href={`/get-quotes/${c.slug}`}
                  className="group flex h-full flex-col justify-between rounded-lg border border-border bg-card p-6 transition-colors hover:border-foreground"
                >
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <p className="label-eyebrow">{c.name}</p>
                      {!live ? (
                        <span className="rounded-full border border-foreground/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                          Waitlist
                        </span>
                      ) : null}
                    </div>
                    <h2 className="font-display text-2xl font-bold tracking-tight">
                      {live ? 'Start a ' + c.name.toLowerCase() + ' request' : c.name + ' — coming soon'}
                    </h2>
                    {c.description ? (
                      <p className="mt-2 text-sm text-muted-foreground">{c.description}</p>
                    ) : null}
                  </div>
                  <p className="mt-6 font-mono text-xs uppercase tracking-widest text-foreground underline-offset-4 group-hover:underline">
                    {live ? '$9.99 — get quotes →' : 'Join the waitlist →'}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          Don't see what you need? <a href="mailto:hello@evenquote.com" className="underline underline-offset-4">Tell us</a> — we'll let you know when it ships.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
