// /get-quotes/checkout — Phase 5 real version.
//
// Flow:
//   1. Arrived from the Phase 4 intake with ?request=<uuid> (the guest or
//      authed user's pending quote_request).
//   2. Load the request via admin client (it may be a guest row with
//      user_id=null, so the cookie client's RLS would block the read).
//   3. If the request is already paid or further, redirect to /success.
//   4. Render a checkout summary + Pay $9.99 button. The button is a
//      client component that calls our createCheckoutSession server
//      action and window.location's to Stripe.
//   5. If the user cancelled from Stripe (?cancelled=1), show a
//      dismissible banner.
//
// Security notes:
//   - We intentionally don't require auth here. Guest flow is the spec.
//   - The request UUID is shown in the URL; knowing a UUID doesn't grant
//     payment ability to a third party (they'd still go through Stripe
//     with the guest's email).
//   - Beyond city/state, the only PII echoed back to the page is a MASKED
//     version of the contact email (e.g. b****@hotmail.com) — enough for
//     the legit user to recognize their own, too little for a URL-sharer
//     to harvest.
//
// Layout / brand notes (April 2026 refresh):
//   - Neobrutalist card: 2px ink border + hard 6px drop shadow, matches
//     the hero "price sticker" and maintenance page "scheduled" card.
//   - Vertical-agnostic copy: we join service_categories to pull the
//     noun/slug so the confirmation text doesn't hard-code "movers".
//   - The "From/To" row only renders for moving — it doesn't make sense
//     for cleaning / handyman / lawn care where there's no origin.
//   - A small lime chip bar across the top gives the page a bit of
//     brand personality without overwhelming the purchase moment.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';
import { PayButton } from '@/components/checkout/pay-button';
import { SkipPaymentButton } from '@/components/checkout/skip-payment-button';
import { QUOTE_REQUEST_PRICE } from '@/lib/stripe/server';
import { maskEmail } from '@/lib/text/pii';

// Per-request SSR. Reads quote_request by uuid from search params and
// redirects when already-paid — must run fresh on every visit, not be
// statically baked.
export const dynamic = 'force-dynamic';

// Transactional page keyed on a UUID — noindex so guessable URLs don't
// surface in search. Title is the browser-tab title, still friendly.
export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: { request?: string; cancelled?: string };
};

// Friendly plural for the category, used in confirmation copy. Falls
// back to a generic "local pros" if we ever add a vertical and forget
// to update this map — better than rendering a blank.
const CATEGORY_NOUN: Record<string, string> = {
  moving: 'movers',
  cleaning: 'cleaners',
  handyman: 'handymen',
  'lawn-care': 'lawn crews',
  lawn: 'lawn crews',
  'junk-removal': 'junk removal crews',
};

export default async function CheckoutPage({ searchParams }: Props) {
  const requestId = searchParams.request;
  const wasCancelled = searchParams.cancelled === '1';
  if (!requestId) notFound();

  const admin = createAdminClient();
  const { data: request } = await admin
    .from('quote_requests')
    .select(
      `
      id, status, city, state, zip_code, intake_data, created_at,
      service_categories ( name, slug )
    `
    )
    .eq('id', requestId)
    .single();

  if (!request) notFound();

  // If they've already paid (or further), skip the checkout page.
  if (request.status !== 'pending_payment') {
    redirect(`/get-quotes/success?request=${request.id}`);
  }

  type IntakeShape = {
    contact_name?: string;
    contact_email?: string;
    origin_city?: string;
    origin_state?: string;
  };
  const intake = (request.intake_data ?? {}) as IntakeShape;
  const price = `$${(QUOTE_REQUEST_PRICE.amountCents / 100).toFixed(2)}`;

  // service_categories comes back as an object (one-to-one) per the FK.
  // Defensive in case the relation is ever null.
  type CategoryRel = { name?: string; slug?: string } | null;
  const category = (request as { service_categories?: CategoryRel })
    .service_categories;
  const categorySlug = category?.slug ?? 'moving';
  const categoryName = category?.name ?? 'Moving';
  const noun = CATEGORY_NOUN[categorySlug] ?? 'local pros';
  const isMoving = categorySlug === 'moving';

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-2xl py-12 sm:py-16">
        {wasCancelled ? (
          <div className="mb-6 rounded-md border-2 border-ink bg-white px-4 py-3 text-sm shadow-[3px_3px_0_0_#0A0A0A]">
            <span className="mr-2 inline-flex h-5 w-5 shrink-0 translate-y-[3px] items-center justify-center rounded-full bg-lime text-[11px] font-bold">
              ←
            </span>
            Checkout cancelled. Your request is still saved — pay any time from this page.
          </div>
        ) : null}

        {/* Category chip + step indicator */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-lime px-3 py-1 text-xs font-semibold uppercase tracking-wider">
            <span className="h-2 w-2 rounded-full bg-ink" aria-hidden />
            {categoryName}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Step 2 of 2
          </span>
        </div>

        <div className="relative rounded-lg border-2 border-ink bg-card p-8 shadow-[6px_6px_0_0_hsl(var(--foreground))]">
          {/* Soft lime blob behind the headline, brand flourish */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-8 -right-8 -z-0 h-32 w-32 rounded-full bg-lime blur-2xl opacity-40"
          />

          <p className="label-eyebrow mb-3 relative z-10">One step away</p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl relative z-10">
            Ready to make the calls.
          </h1>
          <p className="mt-3 text-muted-foreground relative z-10">
            We&rsquo;ll ring up to <span className="font-semibold text-foreground">5 {noun}</span>{' '}
            in <span className="font-semibold text-foreground">{request.city}, {request.state}</span>{' '}
            and deliver a side-by-side quote report to{' '}
            <span className="font-semibold text-foreground">
              {maskEmail(intake.contact_email) ?? 'the email you provided'}
            </span>
            {' '}within 24 hours.
          </p>

          <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2 relative z-10">
            {isMoving ? (
              <>
                <div>
                  <dt className="label-eyebrow">From</dt>
                  <dd className="mt-1 font-medium">
                    {intake.origin_city ?? '—'}
                    {intake.origin_state ? `, ${intake.origin_state}` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="label-eyebrow">To</dt>
                  <dd className="mt-1 font-medium">
                    {request.city}, {request.state} {request.zip_code}
                  </dd>
                </div>
              </>
            ) : (
              <div className="sm:col-span-2">
                <dt className="label-eyebrow">Service area</dt>
                <dd className="mt-1 font-medium">
                  {request.city}, {request.state} {request.zip_code}
                </dd>
              </div>
            )}

            <div>
              <dt className="label-eyebrow">Request ID</dt>
              <dd className="mt-1 font-mono text-xs text-muted-foreground">{request.id}</dd>
            </div>
            <div>
              <dt className="label-eyebrow">Price</dt>
              <dd className="mt-1 inline-flex items-baseline gap-1">
                <span className="font-display text-2xl font-bold text-foreground">{price}</span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  one-time
                </span>
              </dd>
            </div>
          </dl>

          <div className="mt-8 rule-top pt-6 relative z-10">
            <PayButton requestId={request.id} price={price} />
            <p className="mt-3 text-xs text-muted-foreground">
              You&rsquo;ll be redirected to Stripe for secure payment. We never see your card.
            </p>
            {/* R47.5: explicit consent line — clicking Pay constitutes
                acceptance per the Terms section 1. Footer also links
                both pages, but the placement here is the legally-
                meaningful one (presented at the moment of purchase). */}
            <p className="mt-2 text-xs text-muted-foreground">
              By paying, you agree to our{' '}
              <Link
                href="/legal/terms"
                className="underline-offset-2 hover:underline"
              >
                Terms
              </Link>{' '}
              and{' '}
              <Link
                href="/legal/privacy"
                className="underline-offset-2 hover:underline"
              >
                Privacy Policy
              </Link>
              .
            </p>

            {/* Dev-only payment bypass. Only rendered off-production.
                In prod this entire block is tree-shaken away because
                the check is a compile-time constant from process.env
                inlined at build. */}
            {process.env.NODE_ENV !== 'production' ? (
              <SkipPaymentButton requestId={request.id} />
            ) : null}
          </div>

          <div className="mt-6 text-sm relative z-10">
            <Link
              href="/get-quotes"
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              ← Edit your request
            </Link>
          </div>
        </div>

        {/* Three-line value strip under the card */}
        <ul className="mt-6 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <li className="flex items-start gap-2 rounded-md border border-border bg-white/60 p-3">
            <span className="mt-0.5 inline-block h-2 w-2 rounded-full bg-lime" aria-hidden />
            <span><span className="font-semibold text-foreground">No subscription.</span> One request, one charge.</span>
          </li>
          <li className="flex items-start gap-2 rounded-md border border-border bg-white/60 p-3">
            <span className="mt-0.5 inline-block h-2 w-2 rounded-full bg-lime" aria-hidden />
            <span><span className="font-semibold text-foreground">No phone tag.</span> We do the calling.</span>
          </li>
          <li className="flex items-start gap-2 rounded-md border border-border bg-white/60 p-3">
            <span className="mt-0.5 inline-block h-2 w-2 rounded-full bg-lime" aria-hidden />
            <span><span className="font-semibold text-foreground">Report in 24 hours.</span> Straight to your inbox.</span>
          </li>
        </ul>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          You haven&rsquo;t been charged yet. Payment happens on the Stripe page after you click.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
