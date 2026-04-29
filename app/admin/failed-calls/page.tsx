// /admin/failed-calls — Dead Letter Queue for dispatch-failed calls.
//
// Phase 7's retry worker stops at retry_count >= 3. After that, the
// row sits in status='failed' forever with no further retries, and
// ops had no surface to see them. This page is that surface.
//
// Scope on purpose:
//   • Read-only for now. No one-click "retry this one anyway" button —
//     that's Phase 11 territory. If ops needs to kick a row, they do
//     it in SQL and the existing cron picks it up.
//   • Service-role query. Regular RLS scopes by request owner, which
//     would hide failures across the whole user base from an admin.
//     requireAdmin() gates the page, admin client does the read.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';
import { createLogger } from '@/lib/logger';

const log = createLogger('admin/failed-calls');

// Admin-only surface. Don't confirm existence to crawlers or unauthed users.
export const metadata: Metadata = {
  title: 'Failed calls',
  robots: { index: false, follow: false },
};

type FailedCall = {
  id: string;
  quote_request_id: string;
  business_id: string;
  status: string;
  retry_count: number;
  last_retry_at: string | null;
  created_at: string;
  summary: string | null;
  business: { name: string; phone: string; email: string | null } | null;
  quote_request: { city: string; state: string; zip_code: string } | null;
};

export default async function FailedCallsPage() {
  await requireAdmin();
  const admin = createAdminClient();

  // DLQ definition = dispatch-fail row that has exhausted retries.
  // started_at IS NULL scopes to dispatch-fails only (mid-call failures
  // are intentionally left out of retry, so they'd inflate the DLQ
  // without being actionable).
  const { data: rows, error } = await admin
    .from('calls')
    .select(
      `
      id,
      quote_request_id,
      business_id,
      status,
      retry_count,
      last_retry_at,
      created_at,
      summary,
      business:businesses!calls_business_id_fkey(name, phone, email),
      quote_request:quote_requests!calls_quote_request_id_fkey(city, state, zip_code)
    `
    )
    .eq('status', 'failed')
    .is('started_at', null)
    .gte('retry_count', 3)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    log.error('query failed', { err: error });
  }

  const calls: FailedCall[] = (rows ?? []).map((r) => {
    const biz = (r as { business?: unknown }).business;
    const qr = (r as { quote_request?: unknown }).quote_request;
    return {
      ...r,
      business: Array.isArray(biz) ? biz[0] : biz,
      quote_request: Array.isArray(qr) ? qr[0] : qr,
    } as FailedCall;
  });

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-6xl py-12">
        <header className="mb-8">
          <p className="label-eyebrow mb-2">
            <Link href="/admin" className="hover:underline">Admin</Link> / Failed calls
          </p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Dead letter queue
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Dispatch-failed calls that exhausted {3} retries. Showing{' '}
            {calls.length} (up to 200).
          </p>
        </header>

        {calls.length === 0 ? (
          <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
            <h2 className="font-display text-xl font-semibold">Nothing stuck</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Every dispatch-failed call is either under the retry cap or has
              since succeeded.
            </p>
          </section>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Location</th>
                  <th className="px-4 py-3 font-medium">Retries</th>
                  <th className="px-4 py-3 font-medium">Last retry</th>
                  <th className="px-4 py-3 font-medium">Request</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(c.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        {c.business?.name ?? '—'}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {c.business?.phone ?? ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {c.quote_request
                        ? `${c.quote_request.city}, ${c.quote_request.state} ${c.quote_request.zip_code}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3">{c.retry_count}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {c.last_retry_at
                        ? new Date(c.last_retry_at).toLocaleString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <Link
                        href={`/dashboard/requests/${c.quote_request_id}`}
                        className="underline hover:no-underline"
                      >
                        {c.quote_request_id.slice(0, 8)}…
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-6 text-xs text-muted-foreground">
          To re-queue a row for retry, in SQL: <code>update calls set status='failed', retry_count=0, last_retry_at=null where id='…'</code>
        </p>
      </main>
    </>
  );
}
