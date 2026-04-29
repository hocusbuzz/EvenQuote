// /admin/businesses — seeded business directory. Filter by category.
// Shows name, phone, category, city, rating, success rate, last call.
//
// Used by ops to diagnose coverage gaps ("why are we only calling 3
// movers in this zip?") and quality issues ("which businesses are
// consistently unreachable?").

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';

export const metadata: Metadata = {
  title: 'Businesses · Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const sp = await searchParams;
  const categorySlug = sp.category ?? 'all';
  const queryText = (sp.q ?? '').trim();

  // Fetch categories for the filter row.
  const { data: categories } = await admin
    .from('service_categories')
    .select('slug, name')
    .order('name');

  let q = admin
    .from('businesses')
    .select(
      `id, name, phone, email, city, state, zip_code,
       google_rating, call_success_rate, last_called_at, is_active,
       category:category_id(slug, name)`
    )
    .order('call_success_rate', { ascending: false, nullsFirst: false })
    .order('google_rating', { ascending: false, nullsFirst: false })
    .limit(200);

  if (categorySlug !== 'all') {
    // Join-filter: find category id first (cheap — small table).
    const { data: cat } = await admin
      .from('service_categories')
      .select('id')
      .eq('slug', categorySlug)
      .maybeSingle();
    if (cat) q = q.eq('category_id', cat.id);
  }

  if (queryText.length > 0) {
    // Simple name ilike match; keep it narrow so we don't fight with
    // the category filter. Phone search would need digits-only normalized
    // column — future work.
    q = q.ilike('name', `%${queryText}%`);
  }

  const { data: rows } = await q;

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <div className="mb-6">
          <p className="label-eyebrow mb-1">
            <Link href="/admin" className="hover:underline">Admin</Link> / Businesses
          </p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Businesses
          </h1>
          <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {rows?.length ?? 0} shown · top 200 by success-rate
          </p>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Link
              href="/admin/businesses"
              className={
                'rounded-md border-2 px-2.5 py-1 font-mono uppercase tracking-widest ' +
                (categorySlug === 'all'
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-foreground/40 hover:bg-lime')
              }
            >
              all
            </Link>
            {(categories ?? []).map((c) => (
              <Link
                key={c.slug}
                href={`/admin/businesses?category=${c.slug}`}
                className={
                  'rounded-md border-2 px-2.5 py-1 font-mono uppercase tracking-widest ' +
                  (categorySlug === c.slug
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/40 hover:bg-lime')
                }
              >
                {c.slug}
              </Link>
            ))}
          </div>
          <form action="/admin/businesses" className="ml-auto flex gap-2">
            {categorySlug !== 'all' ? (
              <input type="hidden" name="category" value={categorySlug} />
            ) : null}
            <input
              name="q"
              defaultValue={queryText}
              placeholder="Search name…"
              className="rounded-md border-2 border-foreground/40 bg-background px-2 py-1 font-mono text-xs"
            />
            <button
              type="submit"
              className="rounded-md border-2 border-foreground/80 px-3 py-1 font-mono text-xs uppercase tracking-widest hover:bg-lime"
            >
              Search
            </button>
          </form>
        </div>

        <div className="overflow-hidden rounded-md border-2 border-foreground/80">
          <table className="w-full text-sm">
            <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2 text-right">Rating</th>
                <th className="px-3 py-2 text-right">Success</th>
                <th className="px-3 py-2 text-right">Last called</th>
                <th className="px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((b) => {
                const cat = Array.isArray(b.category) ? b.category[0] : b.category;
                return (
                  <tr key={b.id} className="border-t border-foreground/10">
                    <td className="px-3 py-2">{b.name}</td>
                    <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
                      {cat?.slug ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {b.city}, {b.state} {b.zip_code}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{b.phone ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {b.google_rating != null ? Number(b.google_rating).toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {b.call_success_rate != null
                        ? Math.round(Number(b.call_success_rate) * 100) + '%'
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      {b.last_called_at
                        ? new Date(b.last_called_at).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
                      {b.is_active ? 'yes' : 'no'}
                    </td>
                  </tr>
                );
              })}
              {(!rows || rows.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    No matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
