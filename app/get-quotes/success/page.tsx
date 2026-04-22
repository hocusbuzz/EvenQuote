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
//
// Layout / brand notes (April 2026 refresh):
//   - Neobrutalist card with 2px ink border + hard 6px drop shadow.
//   - Copy is vertical-aware via service_categories join; no more
//     hard-coded "movers" when the request was for cleaning or handyman.
//   - The "in motion" state adds a subtle SVG dotted route as a visual
//     metaphor for "we're working on it". Respects reduced-motion.

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';

type Props = {
  searchParams: { session_id?: string; request?: string };
};

// Friendly plural per category. Kept in sync with /get-quotes/checkout.
const CATEGORY_NOUN: Record<string, string> = {
  moving: 'movers',
  cleaning: 'cleaners',
  handyman: 'handymen',
  'lawn-care': 'lawn crews',
  lawn: 'lawn crews',
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
      categorySlug: string;
      categoryName: string;
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
    .select(
      `
      id, user_id, status, city, state, intake_data,
      service_categories ( name, slug )
    `
    )
    .eq('id', requestId)
    .maybeSingle();

  if (!request) return { kind: 'not-found' };

  type IntakeShape = { contact_email?: string };
  const intake = (request.intake_data ?? {}) as IntakeShape;

  type CategoryRel = { name?: string; slug?: string } | null;
  const category = (request as { service_categories?: CategoryRel })
    .service_categories;

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
    categorySlug: category?.slug ?? 'moving',
    categoryName: category?.name ?? 'Moving',
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

  const noun = CATEGORY_NOUN[state.categorySlug] ?? 'local pros';

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-2xl py-12 sm:py-16">
        {/* Top strip: category chip + "Paid" pill */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wider">
            <span className="h-2 w-2 rounded-full bg-ink" aria-hidden />
            {state.categoryName}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-lime px-3 py-1 text-xs font-semibold uppercase tracking-wider">
            <CheckIcon className="h-3 w-3" />
            Paid
          </span>
        </div>

        <div className="relative overflow-hidden rounded-lg border-2 border-ink bg-card p-8 shadow-[6px_6px_0_0_hsl(var(--foreground))]">
          {/* Brand flourish: soft lime blob + grid */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-10 -right-10 -z-0 h-44 w-44 rounded-full bg-lime blur-2xl opacity-40"
          />

          <p className="label-eyebrow mb-3 relative z-10">Payment received</p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl relative z-10">
            {isClaimedByViewer
              ? 'Your quotes are in motion.'
              : 'Check your email to finish.'}
          </h1>

          {isClaimedByViewer ? (
            <>
              <p className="mt-3 text-muted-foreground relative z-10">
                We&rsquo;ll start calling {noun} in{' '}
                <span className="font-semibold text-foreground">
                  {state.city}, {state.state}
                </span>{' '}
                shortly. You&rsquo;ll get an email with the side-by-side quote report within 24 hours.
              </p>

              {/* Dotted "route" visual — SVG, no JS */}
              <div
                aria-hidden
                className="mt-6 flex items-center gap-3 rounded-md border-2 border-ink bg-white p-4 relative z-10"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lime">
                  <PhoneIcon className="h-4 w-4" />
                </div>
                <DottedRoute />
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-white">
                  <InboxIcon className="h-4 w-4" />
                </div>
              </div>

              <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-sm relative z-10">
                <p className="font-semibold text-foreground">What happens next</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                  <li>We call up to 20 local {noun} on your behalf.</li>
                  <li>Each call is recorded and transcribed.</li>
                  <li>We extract pricing, availability, and notes.</li>
                  <li>You get a single report to compare — no phone tag.</li>
                </ol>
              </div>
              <div className="mt-8 rule-top pt-6 relative z-10">
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
              <p className="mt-3 text-muted-foreground relative z-10">
                We sent a secure sign-in link to{' '}
                <span className="font-semibold text-foreground">
                  {state.email ?? 'the email you provided'}
                </span>
                . Click it to see your quote request and we&rsquo;ll start calling {noun} in{' '}
                <span className="font-semibold text-foreground">
                  {state.city}, {state.state}
                </span>
                .
              </p>

              <div className="mt-6 rounded-md border-2 border-ink bg-white p-5 relative z-10">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lime">
                    <MailIcon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Magic link on the way</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Usually lands in under a minute. It expires in 1 hour — click it while it&rsquo;s fresh.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground relative z-10">
                <p className="font-semibold text-foreground">Didn&rsquo;t get the email?</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>It can take a minute — and sometimes it lands in spam.</li>
                  <li>
                    Still nothing?{' '}
                    <Link href="/login" className="underline">
                      Sign in with the same email
                    </Link>
                    {' '}and we&rsquo;ll attach this payment to your account automatically.
                  </li>
                </ul>
              </div>

              <p className="mt-6 text-xs text-muted-foreground relative z-10">
                Request ID: <span className="font-mono">{state.requestId}</span>
              </p>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Questions? Email{' '}
          <a className="underline" href="mailto:support@evenquote.com">
            support@evenquote.com
          </a>
          .
        </p>
      </main>
      <SiteFooter />
    </>
  );
}

// ─── Inline icons ──────────────────────
// Keeping these local (not lucide-react) so the page has no client-component
// dependencies — all icons render server-side.

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M22 16.92V21a1 1 0 0 1-1.09 1 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 3.13 4.09 1 1 0 0 1 4.11 3h4.09a1 1 0 0 1 1 .75l1 4a1 1 0 0 1-.29 1L8.21 10.2a16 16 0 0 0 6 6l1.45-1.7a1 1 0 0 1 1-.29l4 1a1 1 0 0 1 .75 1z" />
    </svg>
  );
}

function InboxIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="22 6 12 13 2 6" />
    </svg>
  );
}

function DottedRoute() {
  // Horizontal row of dots that flow left-to-right with a subtle animation.
  // motion-safe only — reduced-motion users see a static dotted line.
  return (
    <div className="relative flex-1 overflow-hidden" aria-hidden>
      <div className="motion-safe:animate-[marquee_6s_linear_infinite] motion-reduce:translate-x-0 flex w-[200%] items-center gap-2 text-ink/60">
        {Array.from({ length: 40 }).map((_, i) => (
          <span
            key={i}
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          />
        ))}
      </div>
    </div>
  );
}
