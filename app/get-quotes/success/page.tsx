// /get-quotes/success — shown after Stripe redirects back post-payment.
//
// Two ways a user lands here:
//
//   A) Guest flow, fresh off Stripe:
//      ?session_id=<stripe_cs_id>
//      Stripe appends this via our success_url template. We look up the
//      session → find the quote_request → show a "check your email" card.
//      The magic-link email has already been kicked off by our webhook.
//
//   B) Already-paid, direct link:
//      ?request=<uuid>
//      e.g. coming back from /checkout after we detected status='paid'.
//      Works the same — we show the status, just without the session id.
//
//   C) Post-claim (signed in):
//      After /get-quotes/claim runs, it redirects here with ?request=<id>
//      and the user is now authenticated. We show the full "your quote
//      request is being processed" confirmation.
//
// All lookups use the admin client — guest rows and unclaimed payments
// aren't readable via cookie-client RLS.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';

type Props = {
  searchParams: { session_id?: string; request?: string };
};

type ResolvedState =
  | { kind: 'not-found' }
  | {
      kind: 'ok';
      requestId: string;
      city: string;
      state: string;
      email: string | null;
      status: string;
      paid: boolean;
      userIdOnRequest: string | null;
    };

async function resolveState(sp: Props['searchParams']): Promise<ResolvedState> {
  const admin = createAdminClient();

  // Resolve a quote_request id from either searchParam.
  let requestId: string | null = sp.request ?? null;

  if (!requestId && sp.session_id) {
    // Look up the session in payments — it'll be there if the webhook has
    // processed. If the webhook hasn't landed yet (rare but possible if the
    // user beats it back), show a polling-friendly state.
    const { data: pay } = await admin
      .from('payments')
      .select('quote_request_id')
      .eq('stripe_session_id', sp.session_id)
      .maybeSingle();
    requestId = pay?.quote_request_id ?? null;
  }

  if (!requestId) return { kind: 'not-found' };

  const { data: request } = await admin
    .from('quote_requests')
    .select('id, user_id, status, city, state, intake_data')
    .eq('id', requestId)
    .maybeSingle();

  if (!request) return { kind: 'not-found' };

  type IntakeShape = { contact_email?: string };
  const intake = (request.intake_data ?? {}) as IntakeShape;

  const paidStatuses = new Set(['paid', 'calling', 'processing', 'completed']);

  return {
    kind: 'ok',
    requestId: request.id,
    city: request.city,
    state: request.state,
    email: intake.contact_email ?? null,
    status: request.status,
    paid: paidStatuses.has(request.status),
    userIdOnRequest: request.user_id,
  };
}

export default async function SuccessPage({ searchParams }: Props) {
  const state = await resolveState(searchParams);
  if (state.kind === 'not-found') notFound();

  // Who's viewing? If signed in, we can offer a dashboard link.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If the request is still in 'pending_payment', the user hit success
  // somehow without the payment actually completing. Send them back to
  // the checkout page.
  if (!state.paid) {
    redirect(`/get-quotes/checkout?request=${state.requestId}`);
  }

  // Viewing state selection:
  //  - If signed in and this request belongs to them: show full confirmation.
  //  - If signed in but request is still unclaimed (user_id=NULL): the
  //    auth callback + claim route is supposed to have attached them. If
  //    it didn't, we show the "check your email" card — the user can click
  //    the magic link again.
  //  - If not signed in (guest flow): show "check your email" card.

  const isClaimedByViewer =
    user !== null && state.userIdOnRequest !== null && state.userIdOnRequest === user.id;

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-2xl py-12 sm:py-16">
        <div className="rounded-lg border border-border bg-card p-8">
          <p className="label-eyebrow mb-3">Payment received</p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {isClaimedByViewer
              ? 'Your quotes are in motion.'
              : 'Check your email to finish.'}
          </h1>

          {isClaimedByViewer ? (
            <>
              <p className="mt-3 text-muted-foreground">
                We'll start calling movers in {state.city}, {state.state} shortly. You'll
                get an email with the side-by-side quote report within 24 hours.
              </p>
              <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-sm">
                <p className="font-medium text-foreground">What happens next</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>We call up to 20 local movers on your behalf.</li>
                  <li>Each call is recorded and transcribed.</li>
                  <li>We extract pricing, availability, and notes.</li>
                  <li>You get a single report to compare — no phone tag.</li>
                </ol>
              </div>
              <div className="mt-8 rule-top pt-6">
                <Link
                  href="/dashboard"
                  className="inline-flex h-12 items-center justify-center rounded-md border-2 border-ink bg-lime px-8 text-base font-semibold text-ink shadow-[4px_4px_0_0_hsl(var(--foreground))] transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-lime-deep hover:shadow-[2px_2px_0_0_hsl(var(--foreground))]"
                >
                  Go to your dashboard
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="mt-3 text-muted-foreground">
                We sent a secure sign-in link to{' '}
                <span className="font-medium text-foreground">
                  {state.email ?? 'the email you provided'}
                </span>
                . Click it to see your quote request and we'll start calling movers in
                {' '}
                {state.city}, {state.state}.
              </p>
              <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Didn't get the email?</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>It can take a minute — check spam folders.</li>
                  <li>
                    Still nothing? <Link href="/login" className="underline">Sign in with the same email</Link>
                    {' '}and we'll attach this payment to your account automatically.
                  </li>
                </ul>
              </div>
              <p className="mt-6 text-xs text-muted-foreground">
                Request ID: <span className="font-mono">{state.requestId}</span>
              </p>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Questions? Email <a className="underline" href="mailto:support@evenquote.com">support@evenquote.com</a>.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
