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

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { SiteNavbar } from '@/components/site/navbar';
import { ReleaseContactButton } from './release-button';
import { createLogger } from '@/lib/logger';
import { decideEmptyState } from '@/lib/dashboard/empty-state';

const log = createLogger('request-detail');

// Per-user data under a UUID — explicitly keep out of search indexes.
export const metadata: Metadata = {
  title: 'Quote details',
  robots: { index: false, follow: false },
};

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
      report_data,
      category:service_categories!quote_requests_category_id_fkey(name)
    `
    )
    .eq('id', id)
    .maybeSingle();

  if (reqErr) {
    log.error('load failed', { requestId: id, err: reqErr });
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
    log.error('quotes load failed', { requestId: id, err: qErr });
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
          /* Empty-state branching, R47.6 expanded.
             Three distinct *terminal* states + the one mid-flight
             default. Order matters — most specific first.
              1. Coverage gap: status='completed' AND
                 total_businesses_to_call === 0. The webhook's
                 advanced:false path (no businesses matched any tier)
                 parks the row with 0/0/0 and send-reports refunds it.
                 Copy: "we couldn't find any pros in your area —
                 refund issued". Distinct from "we called X and they
                 didn't quote" because no calls happened.
              2. Calls done, no usable quote: total_businesses_to_call > 0
                 AND calls completed AND status terminal. Copy: "we
                 reached pros but none gave a usable price — refund
                 issued."
              3. Failed mid-flight: status='failed' but didn't reach
                 either of the above (e.g. seeding error mid-batch).
                 Ops will follow up.
              4. Default: still working through the call list. */
          (() => {
            // R47.6: branching extracted to lib/dashboard/empty-state
            // for unit-testability. The page just maps the kind +
            // refundDescriptor to JSX.
            const reportData = (request.report_data ?? null) as
              | { refund_outcome?: string }
              | null;
            const decision = decideEmptyState({
              status: request.status,
              totalBusinessesToCall: request.total_businesses_to_call,
              totalCallsCompleted: request.total_calls_completed,
              refundOutcome: reportData?.refund_outcome ?? null,
            });

            const refundLine = (capitalize: boolean): string => {
              const Y = capitalize ? 'Y' : 'y';
              if (decision.refundDescriptor === 'issued') {
                return `${Y}our $9.99 has been refunded to the card you used at checkout — it typically lands within 5–10 business days.`;
              }
              if (decision.refundDescriptor === 'pending_support') {
                return capitalize
                  ? 'Our team is processing your refund manually — expect an email within one business day.'
                  : 'our team is processing your refund manually — expect an email within one business day.';
              }
              return `${Y}our $9.99 will be refunded to the card you used at checkout.`;
            };

            if (decision.kind === 'coverage_gap') {
              return (
                <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
                  <h2 className="font-display text-xl font-semibold">
                    No pros in your area yet
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    We searched, but couldn&rsquo;t find any{' '}
                    {categoryName.toLowerCase()} businesses to call near{' '}
                    {request.city}, {request.state}. Nothing was billed
                    against any pro&rsquo;s time, and {refundLine(false)}
                  </p>
                </section>
              );
            }

            if (decision.kind === 'no_quote') {
              return (
                <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
                  <h2 className="font-display text-xl font-semibold">
                    No movers gave a usable quote
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    We finished the call list, but none of the pros we
                    reached gave a clear price we could pass on.{' '}
                    {refundLine(true)}
                  </p>
                </section>
              );
            }

            if (decision.kind === 'failed') {
              return (
                <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
                  <h2 className="font-display text-xl font-semibold">
                    We hit a snag
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Something went sideways while gathering your quotes.
                    Our team has been notified and will be in touch with
                    next steps &mdash; including a full refund if we
                    can&rsquo;t get the report to you.
                  </p>
                </section>
              );
            }

            // 'in_flight'
            return (
              <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
                <h2 className="font-display text-xl font-semibold">
                  Quotes still coming in
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  We&rsquo;re working through the call list. You&rsquo;ll
                  get an email when the full report is ready.
                </p>
              </section>
            );
          })()
        ) : (
          <>
            {/* R47.5: provenance disclosure. Every quote on this page
                was extracted by AI from a recorded phone call — not
                typed in by a contractor and not reviewed by a human
                before render. Surfacing this once at the top of the
                list (instead of on every card) keeps the cards readable
                while making the source explicit. Mirrors the disclosure
                wording in the report email's intro. */}
            <p className="mb-5 rounded-md border border-amber-200/60 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <strong>Heads up:</strong> these quotes were extracted by AI
              from recorded phone calls. They&rsquo;re a starting point for
              comparison, not a binding offer. Always confirm price + scope
              in writing with the pro before paying anything.
            </p>
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
                      {/* R47.5: confidence pill when the extractor
                          had limited certainty about the quote
                          (verbal ballpark, partial price, ambiguous
                          response). Threshold 0.7 picked to match
                          the prompt's own band: ≥0.9 confident
                          number, 0.5–0.8 verbal ballpark, <0.4
                          onsite-only. */}
                      {q.confidence_score != null && q.confidence_score < 0.7 && (
                        <span className="rounded border border-foreground/20 bg-foreground/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Low confidence — verify
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
                        <strong>Extras / fees:</strong> {q.excludes!.join(', ')}
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
          </>
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
