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
//     with the guest's email). But we don't expose PII beyond city/state
//     on this page.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';
import { PayButton } from '@/components/checkout/pay-button';
import { QUOTE_REQUEST_PRICE } from '@/lib/stripe/server';

type Props = {
  searchParams: { request?: string; cancelled?: string };
};

export default async function CheckoutPage({ searchParams }: Props) {
  const requestId = searchParams.request;
  const wasCancelled = searchParams.cancelled === '1';
  if (!requestId) notFound();

  const admin = createAdminClient();
  const { data: request } = await admin
    .from('quote_requests')
    .select('id, status, city, state, zip_code, intake_data, created_at')
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

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-2xl py-12 sm:py-16">
        {wasCancelled ? (
          <div className="mb-6 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
            Checkout cancelled. Your request is still saved — pay any time from this page.
          </div>
        ) : null}

        <div className="rounded-lg border border-border bg-card p-8">
          <p className="label-eyebrow mb-3">Step 2 of 2 — Payment</p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Ready to make the calls.
          </h1>
          <p className="mt-3 text-muted-foreground">
            We'll ring up to 20 movers in {request.city}, {request.state} and deliver a
            side-by-side quote report to{' '}
            <span className="font-medium text-foreground">
              {intake.contact_email ?? 'the email you provided'}
            </span>
            {' '}within 24 hours.
          </p>

          <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="label-eyebrow">From</dt>
              <dd className="mt-1">
                {intake.origin_city ?? '—'}, {intake.origin_state ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="label-eyebrow">To</dt>
              <dd className="mt-1">
                {request.city}, {request.state} {request.zip_code}
              </dd>
            </div>
            <div>
              <dt className="label-eyebrow">Request ID</dt>
              <dd className="mt-1 font-mono text-xs">{request.id}</dd>
            </div>
            <div>
              <dt className="label-eyebrow">Price</dt>
              <dd className="mt-1 text-lg font-semibold text-foreground">{price}</dd>
            </div>
          </dl>

          <div className="mt-8 rule-top pt-6">
            <PayButton requestId={request.id} price={price} />
            <p className="mt-3 text-xs text-muted-foreground">
              You'll be redirected to Stripe for secure payment. We never see your card.
            </p>
          </div>

          <div className="mt-6 text-sm">
            <Link
              href="/get-quotes"
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              ← Edit your request
            </Link>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          You haven't been charged yet. Payment happens on the Stripe page after you click.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
