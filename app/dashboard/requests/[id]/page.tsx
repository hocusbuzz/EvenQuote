// /dashboard/requests/[id] — per-request quote detail view.
//
// Phase 8 ships this with one interactive surface: a "share my contact"
// button per quote. Clicking it calls releaseContactToBusiness, which
// stamps quotes.contact_released_at and emails the business.
//
// RLS does the access control — this page uses the cookie-bound
// client, and the policies in migration 0001 + 0007 enforce that only
// the owner sees their own quote_request / calls / quotes.
//
// The UI is deliberately minimal. Phase 10 replaces this with a
// richer comparison view.

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { SiteNavbar } from '@/components/site/navbar';
import { ReleaseContactButton } from './release-button';

type QuoteRow = {
  id: string;
  business_id: string;
  price_min: number | null;
  price_max: number | null;
  price_description: string | null;
  availability: string | null;
  includes: string[] | null;
  excludes: string[] | null;
  notes: string | null;
  requires_onsite_estimate: boolean;
  confidence_score: number | null;
  contact_released_at: string | null;
  business: { name: string; google_rating: number | null } | null;
};

export default async function RequestDetailPage({
  params,
}: {
  params: { id: string };
}) {
  await requireUser();
  const { id } = params;
  const supabase = await createClient();

  const { data: request, error: reqErr } = await supabase
    .from('quote_requests')
    .select(
      `
      id,
      status,
      city,
      state,
      created_at,
      total_businesses_to_call,
      total_calls_completed,
      total_quotes_collected,
      category:service_categories!quote_requests_category_id_fkey(name)
    `
    )
    .eq('id', id)
    .maybeSingle();

  if (reqErr) {
    console.error('[request-detail] load failed', reqErr);
  }
  if (!request) {
    // Either doesn't exist or doesn't belong to this user — 404 either
    // way to avoid leaking existence.
    notFound();
  }

  const categoryRaw = (request as { category?: unknown }).category;
  const category = Array.isArray(categoryRaw) ? categoryRaw[0] : categoryRaw;
  const categoryName =
    (category as { name?: string } | null)?.name ?? 'Service';

  const { data: quotesRaw, error: qErr } = await supabase
    .from('quotes')
    .select(
      `
      id,
      business_id,
      price_min,
      price_max,
      price_description,
      availability,
      includes,
      excludes,
      notes,
      requires_onsite_estimate,
      confidence_score,
      contact_released_at,
      business:businesses!quotes_business_id_fkey(name, google_rating)
    `
    )
    .eq('quote_request_id', id)
    .order('price_min', { ascending: true, nullsFirst: false });

  if (qErr) {
    console.error('[request-detail] quotes load failed', qErr);
  }

  const quotes: QuoteRow[] = (quotesRaw ?? []).map((q) => {
    const bizRaw = (q as { business?: unknown }).business;
    const business = Array.isArray(bizRaw) ? bizRaw[0] : bizRaw;
    return { ...q, business: business ?? null } as QuoteRow;
  });

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-4xl py-12">
        <nav className="mb-6 text-sm">
          <Link
            href="/dashboard"
            className="text-muted-foreground hover:text-foreground"
          >
            ← All requests
          </Link>
        </nav>

        <header className="mb-10">
          <p className="label-eyebrow mb-2">{categoryName}</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            {request.city}, {request.state}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {quotes.length} quote{quotes.length === 1 ? '' : 's'} collected
            {' · '}
            {request.total_calls_completed} of {request.total_businesses_to_call}{' '}
            calls completed
          </p>
        </header>

        {quotes.length === 0 ? (
          <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
            <h2 className="font-display text-xl font-semibold">
              Quotes still coming in
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              We're working through the call list. You'll get an email
              when the full report is ready.
            </p>
          </section>
        ) : (
          <ul className="space-y-4">
            {quotes.map((q) => (
              <li
                key={q.id}
                className="rounded-lg border border-border bg-card p-5 text-card-foreground"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-lg font-semibold">
                        {q.business?.name ?? 'Unknown business'}
                      </h3>
                      {q.business?.google_rating != null && (
                        <span className="text-xs text-muted-foreground">
                          ★ {q.business.google_rating.toFixed(1)}
                        </span>
                      )}
                      {q.requires_onsite_estimate && (
                        <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800">
                          On-site needed
                        </span>
                      )}
                    </div>

                    <div className="mt-2 font-display text-xl font-bold">
                      {formatPriceRange(q.price_min, q.price_max)}
                    </div>
                    {q.price_description && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {q.price_description}
                      </p>
                    )}
                    {q.availability && (
                      <p className="mt-2 text-sm">
                        <strong>Available:</strong> {q.availability}
                      </p>
                    )}
                    {(q.includes ?? []).length > 0 && (
                      <p className="mt-2 text-sm">
                        <strong>Included:</strong> {q.includes!.join(', ')}
                      </p>
                    )}
                    {(q.excludes ?? []).length > 0 && (
                      <p className="mt-1 text-sm">
                        <strong>Not included:</strong> {q.excludes!.join(', ')}
                      </p>
                    )}
                    {q.notes && (
                      <p className="mt-2 text-sm italic text-muted-foreground">
                        "{q.notes}"
                      </p>
                    )}
                  </div>

                  <div className="shrink-0">
                    <ReleaseContactButton
                      quoteId={q.id}
                      alreadyReleased={!!q.contact_released_at}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function formatPriceRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'On-site estimate';
  if (min != null && max != null && min !== max) {
    return `$${fmt(min)}–$${fmt(max)}`;
  }
  const single = (min ?? max) as number;
  return `$${fmt(single)}`;
}

function fmt(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
