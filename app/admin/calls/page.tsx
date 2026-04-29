// /admin/calls — recent calls across all requests. A diagnostic list
// for ops: latest dials, duration, cost, status. Filter by status via
// ?status=completed etc. Links each row to its parent request detail.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';

export const metadata: Metadata = {
  title: 'Calls · Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const VALID_STATUSES = [
  'all',
  'queued',
  'in_progress',
  'completed',
  'failed',
  'no_answer',
  'refused',
] as const;

export default async function AdminCallsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const sp = await searchParams;
  const status = (sp.status ?? 'all') as typeof VALID_STATUSES[number];

  let q = admin
    .from('calls')
    .select(
      `id, quote_request_id, vapi_call_id, status,
       started_at, ended_at, duration_seconds, cost,
       retry_count, created_at,
       business:business_id(name, phone)`
    )
    .order('created_at', { ascending: false })
    .limit(200);

  if (status !== 'all' && VALID_STATUSES.includes(status)) {
    q = q.eq('status', status);
  }

  const { data: rows } = await q;

  const totalCost = (rows ?? []).reduce(
    (acc, r) => acc + (typeof r.cost === 'number' ? Number(r.cost) : 0),
    0
  );

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-eyebrow mb-1">
              <Link href="/admin" className="hover:underline">Admin</Link> / Calls
            </p>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Recent calls
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              last {rows?.length ?? 0} · ∑ cost ${totalCost.toFixed(2)}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {VALID_STATUSES.map((s) => (
              <Link
                key={s}
                href={s === 'all' ? '/admin/calls' : `/admin/calls?status=${s}`}
                className={
                  'rounded-md border-2 px-2.5 py-1 font-mono uppercase tracking-widest ' +
                  (s === status
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/40 hover:bg-lime')
                }
              >
                {s}
              </Link>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-md border-2 border-foreground/80">
          <table className="w-full text-sm">
            <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">Started</th>
                <th className="px-3 py-2">Business</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Dur</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Retry</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((c) => {
                const biz = Array.isArray(c.business) ? c.business[0] : c.business;
                const isSms = c.vapi_call_id?.startsWith('sms_') ?? false;
                return (
                  <tr key={c.id} className="border-t border-foreground/10">
                    <td className="px-3 py-2 font-mono text-xs">
                      {new Date(c.started_at ?? c.created_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      <div>{biz?.name ?? '—'}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {biz?.phone ?? ''} {isSms ? '· SMS' : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest">
                      {c.status}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.duration_seconds ?? 0}s
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.cost != null ? '$' + Number(c.cost).toFixed(4) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.retry_count ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/admin/requests/${c.quote_request_id}`}
                        className="font-mono text-xs uppercase tracking-widest underline"
                      >
                        Request
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {(!rows || rows.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No calls for this filter.
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
