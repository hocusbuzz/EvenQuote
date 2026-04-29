// /dashboard/billing — the signed-in user's payment history.
//
// Pulls every `payments` row for the current user (cookie-bound
// client → RLS scopes to user_id = auth.uid() automatically). Shows
// date, amount, Stripe charge id, and which quote request the payment
// funded. Links back to each request's detail view.
//
// No actions from this page for now (refunds go through our cron +
// Stripe dashboard). This is a "receipt surface" — customers
// looking for proof of what they paid and when.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser, getProfile } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { SiteNavbar } from '@/components/site/navbar';

export const metadata: Metadata = {
  title: 'Billing',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  await requireUser('/dashboard/billing');
  const profile = await getProfile();
  const supabase = await createClient();

  // RLS restricts to this user's payments. Join quote_requests so we
  // can show a link to "what this paid for". Column names match the
  // schema in migrations 0001 + 0003: `amount` is the cents integer,
  // there's no `stripe_charge_id` (we only persist session + intent),
  // and `claimed_at` is set when a guest payment was linked to a user.
  const { data: payments } = await supabase
    .from('payments')
    .select(
      `id, amount, currency, status, stripe_payment_intent_id,
       stripe_session_id, created_at, claimed_at,
       quote_request:quote_request_id (
         id, city, state, zip_code,
         service_categories:category_id(name, slug)
       )`
    )
    .order('created_at', { ascending: false });

  const totalPaidCents = (payments ?? [])
    .filter((p) => p.status === 'succeeded' || p.status === 'paid' || p.status === 'completed')
    .reduce((acc, p) => acc + (p.amount ?? 0), 0);

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <p className="label-eyebrow mb-1">
          <Link href="/dashboard" className="hover:underline">Dashboard</Link> / Billing
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Billing
            </h1>
            {profile?.email ? (
              <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
                {profile.email}
              </p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Paid to date
            </p>
            <p className="font-display text-2xl font-bold tabular-nums">
              ${(totalPaidCents / 100).toFixed(2)}
            </p>
          </div>
        </div>

        <div className="mt-8 overflow-hidden rounded-md border-2 border-foreground/80">
          <table className="w-full text-sm">
            <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">For</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Receipt ID</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((p) => {
                const qr = Array.isArray(p.quote_request)
                  ? p.quote_request[0]
                  : p.quote_request;
                const sc = qr
                  ? Array.isArray(qr.service_categories)
                    ? qr.service_categories[0]
                    : qr.service_categories
                  : null;
                return (
                  <tr key={p.id} className="border-t border-foreground/10">
                    <td className="px-3 py-2 font-mono text-xs">
                      {new Date(p.created_at).toLocaleDateString([], {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {sc?.name ?? '—'}
                      {qr ? (
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          {qr.city}, {qr.state}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
                      {p.status}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      ${((p.amount ?? 0) / 100).toFixed(2)}
                      {p.currency && p.currency.toLowerCase() !== 'usd' ? (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                          {p.currency}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                      {p.stripe_payment_intent_id ?? p.stripe_session_id ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {qr ? (
                        <Link
                          href={`/dashboard/requests/${qr.id}`}
                          className="font-mono text-xs uppercase tracking-widest underline"
                        >
                          Report
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {(!payments || payments.length === 0) && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-12 text-center text-muted-foreground"
                  >
                    No payments yet. When you pay for a quote request, it will
                    show up here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          Charges are processed by Stripe. For a formal receipt or refund
          questions, contact{' '}
          <a href="mailto:hello@evenquote.com" className="underline">
            hello@evenquote.com
          </a>
          .
        </p>
      </main>
    </>
  );
}
