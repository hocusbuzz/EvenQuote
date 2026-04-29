// /admin/users/[id] — per-user CRM detail.
//
// Everything an operator needs in one place to support or refund
// this customer:
//
//   • Profile header: email, name, role, signed-up, lifetime spend
//   • Every quote_request (active + archived, links to detail)
//   • Every payment (amount, status, stripe ids, date)
//   • Unclaimed guest requests matching this user's email — so ops
//     can see "this customer probably meant to claim these but never
//     clicked the magic link"

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';

export const metadata: Metadata = {
  title: 'User · Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const { id } = await params;

  const { data: profile } = await admin
    .from('profiles')
    .select('id, email, full_name, phone, role, created_at')
    .eq('id', id)
    .maybeSingle();

  if (!profile) notFound();

  // Parallel: user's requests + user's payments + unclaimed guest
  // requests whose intake_data.contact_email matches this profile.
  const [requests, payments, unclaimedGuests] = await Promise.all([
    admin
      .from('quote_requests')
      .select(
        `id, status, city, state, zip_code, created_at, archived_at,
         total_businesses_to_call, total_calls_completed, total_quotes_collected,
         service_categories:category_id(name, slug)`
      )
      .eq('user_id', id)
      .order('created_at', { ascending: false }),
    admin
      .from('payments')
      .select(
        `id, amount, currency, status,
         stripe_session_id, stripe_payment_intent_id,
         created_at, claimed_at,
         quote_request_id`
      )
      .eq('user_id', id)
      .order('created_at', { ascending: false }),
    // Unclaimed-with-matching-email: user_id IS NULL AND the intake
    // contact_email matches this profile (case-insensitive).
    admin
      .from('quote_requests')
      .select(
        `id, status, city, state, zip_code, created_at, intake_data,
         service_categories:category_id(name, slug)`
      )
      .is('user_id', null)
      .ilike('intake_data->>contact_email', profile.email)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const totalPaidCents = (payments.data ?? [])
    .filter((p) => ['succeeded', 'paid', 'completed'].includes(p.status))
    .reduce((acc, p) => acc + (p.amount ?? 0), 0);

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <p className="label-eyebrow mb-1">
          <Link href="/admin" className="hover:underline">Admin</Link> /{' '}
          <Link href="/admin/users" className="hover:underline">Users</Link>
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {profile.full_name ?? profile.email}
              {profile.role === 'admin' ? (
                <span className="ml-3 align-middle inline-block rounded-sm bg-foreground px-2 py-0.5 font-mono text-[11px] uppercase tracking-widest text-background">
                  admin
                </span>
              ) : null}
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              {profile.email}
              {profile.phone ? ` · ${profile.phone}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-6 text-right font-mono text-xs uppercase tracking-widest">
            <div>
              <div className="text-muted-foreground">Signed up</div>
              <div className="text-foreground">
                {new Date(profile.created_at).toLocaleDateString([], {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Requests</div>
              <div className="text-foreground">{requests.data?.length ?? 0}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Lifetime spend</div>
              <div className="text-foreground">${(totalPaidCents / 100).toFixed(2)}</div>
            </div>
          </div>
        </div>

        {/* Requests */}
        <section className="mt-10">
          <h2 className="mb-2 font-display text-xl font-bold tracking-tight">
            Quote requests ({requests.data?.length ?? 0})
          </h2>
          <div className="overflow-hidden rounded-md border-2 border-foreground/80">
            <table className="w-full text-sm">
              <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
                <tr>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Calls</th>
                  <th className="px-3 py-2 text-right">Quotes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(requests.data ?? []).map((r) => {
                  const sc = Array.isArray(r.service_categories)
                    ? r.service_categories[0]
                    : r.service_categories;
                  return (
                    <tr
                      key={r.id}
                      className={
                        'border-t border-foreground/10 ' +
                        (r.archived_at ? 'opacity-60' : '')
                      }
                    >
                      <td className="px-3 py-2 font-mono text-xs">
                        {new Date(r.created_at).toLocaleDateString()}
                        {r.archived_at ? (
                          <span className="ml-1 rounded-sm bg-foreground/10 px-1 py-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">
                            archived
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{sc?.name ?? '—'}</td>
                      <td className="px-3 py-2">
                        {r.city}, {r.state}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
                        {r.status}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {r.total_calls_completed ?? 0}/{r.total_businesses_to_call ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {r.total_quotes_collected ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/admin/requests/${r.id}`}
                          className="font-mono text-xs uppercase tracking-widest underline"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {(!requests.data || requests.data.length === 0) && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                      No quote requests.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Payments */}
        <section className="mt-10">
          <h2 className="mb-2 font-display text-xl font-bold tracking-tight">
            Payments ({payments.data?.length ?? 0})
          </h2>
          <div className="overflow-hidden rounded-md border-2 border-foreground/80">
            <table className="w-full text-sm">
              <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Stripe</th>
                  <th className="px-3 py-2">Claimed</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(payments.data ?? []).map((p) => {
                  const isDev = p.stripe_session_id?.startsWith('dev_') ?? false;
                  return (
                    <tr key={p.id} className="border-t border-foreground/10">
                      <td className="px-3 py-2 font-mono text-xs">
                        {new Date(p.created_at).toLocaleDateString()}
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
                        {isDev ? (
                          <span className="rounded-sm bg-foreground/10 px-1 py-0.5 uppercase tracking-widest">
                            dev
                          </span>
                        ) : (
                          p.stripe_payment_intent_id ?? p.stripe_session_id ?? '—'
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px]">
                        {p.claimed_at
                          ? new Date(p.claimed_at).toLocaleDateString()
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/admin/requests/${p.quote_request_id}`}
                          className="font-mono text-xs uppercase tracking-widest underline"
                        >
                          Request
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {(!payments.data || payments.data.length === 0) && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      No payments.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Unclaimed guest requests with matching email */}
        {unclaimedGuests.data && unclaimedGuests.data.length > 0 ? (
          <section className="mt-10">
            <h2 className="mb-2 font-display text-xl font-bold tracking-tight">
              Unclaimed guest requests matching {profile.email}
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Guest quote requests with the same intake contact email but no
              user_id. The customer probably never clicked the magic link
              after paying — consider reaching out manually.
            </p>
            <div className="overflow-hidden rounded-md border-2 border-foreground/80">
              <table className="w-full text-sm">
                <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
                  <tr>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {unclaimedGuests.data.map((r) => {
                    const sc = Array.isArray(r.service_categories)
                      ? r.service_categories[0]
                      : r.service_categories;
                    return (
                      <tr key={r.id} className="border-t border-foreground/10">
                        <td className="px-3 py-2 font-mono text-xs">
                          {new Date(r.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2">{sc?.name ?? '—'}</td>
                        <td className="px-3 py-2">
                          {r.city}, {r.state}
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
                          {r.status}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Link
                            href={`/admin/requests/${r.id}`}
                            className="font-mono text-xs uppercase tracking-widest underline"
                          >
                            Open
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </main>
    </>
  );
}
