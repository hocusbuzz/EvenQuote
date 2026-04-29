// /admin — overview dashboard.
//
// Single landing page for operators. Gives a 60-second read of what's
// happening in the system: recent quote requests, live call volume,
// quotes collected today, failed-call count. Everything else in /admin
// is linked from here.
//
// Security: gated by requireAdmin() (profiles.role='admin'). All DB
// reads use the service-role admin client — regular RLS would hide
// other users' data from an admin operator.
//
// Scope on purpose:
//   • Read-only. No actions from this page — links out to per-domain
//     admin pages for the few actionable things (failed-calls DLQ).
//   • Counts only where they're cheap; no expensive aggregates.
//   • Last 48h window for "recent" — short enough to be actionable,
//     long enough to include an overnight batch.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  await requireAdmin();
  const admin = createAdminClient();

  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const sinceToday = startOfTodayIso();

  // Parallel count queries — each returns a `count` without rows.
  const [
    requests48h,
    paidAllTime,
    callsInProgress,
    callsToday,
    quotesToday,
    failedDlq,
  ] = await Promise.all([
    admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since48h),
    admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .in('status', ['paid', 'calling', 'processing', 'completed']),
    admin
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'in_progress'),
    admin
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sinceToday),
    admin
      .from('quotes')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sinceToday),
    admin
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .is('started_at', null)
      .gte('retry_count', 1),
  ]);

  // Recent quote requests table (last 48h).
  const { data: recentRequests } = await admin
    .from('quote_requests')
    .select(
      'id, status, city, state, zip_code, total_businesses_to_call, total_calls_completed, total_quotes_collected, created_at, category_id, service_categories:category_id(name, slug)'
    )
    .order('created_at', { ascending: false })
    .limit(12);

  return (
    <>
      <SiteNavbar />
      <main className="container py-12 sm:py-16">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-eyebrow mb-2">Admin</p>
            <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Overview
            </h1>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            <Link
              href="/admin/requests"
              className="rounded-md border-2 border-foreground/80 px-3 py-1.5 hover:bg-lime"
            >
              Requests
            </Link>
            <Link
              href="/admin/users"
              className="rounded-md border-2 border-foreground/80 px-3 py-1.5 hover:bg-lime"
            >
              Users
            </Link>
            <Link
              href="/admin/calls"
              className="rounded-md border-2 border-foreground/80 px-3 py-1.5 hover:bg-lime"
            >
              Calls
            </Link>
            <Link
              href="/admin/businesses"
              className="rounded-md border-2 border-foreground/80 px-3 py-1.5 hover:bg-lime"
            >
              Businesses
            </Link>
            <Link
              href="/admin/failed-calls"
              className="rounded-md border-2 border-foreground/80 px-3 py-1.5 hover:bg-lime"
            >
              Failed calls
            </Link>
          </nav>
        </div>

        {/* KPI cards */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard label="Requests (48h)" value={requests48h.count ?? 0} />
          <KpiCard label="Paid all-time" value={paidAllTime.count ?? 0} />
          <KpiCard label="Calls in progress" value={callsInProgress.count ?? 0} highlight={(callsInProgress.count ?? 0) > 0} />
          <KpiCard label="Calls today" value={callsToday.count ?? 0} />
          <KpiCard label="Quotes today" value={quotesToday.count ?? 0} />
          <KpiCard label="DLQ backlog" value={failedDlq.count ?? 0} warn={(failedDlq.count ?? 0) > 0} />
        </div>

        {/* Recent requests */}
        <section className="mt-14">
          <h2 className="mb-4 font-display text-2xl font-bold tracking-tight">
            Recent requests
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
                {(recentRequests ?? []).map((r) => {
                  const sc = Array.isArray(r.service_categories)
                    ? r.service_categories[0]
                    : r.service_categories;
                  return (
                    <tr key={r.id} className="border-t border-foreground/10">
                      <td className="px-3 py-2 font-mono text-xs">
                        {formatRelative(r.created_at)}
                      </td>
                      <td className="px-3 py-2">{sc?.name ?? '—'}</td>
                      <td className="px-3 py-2">
                        {r.city}, {r.state} {r.zip_code}
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill status={r.status} />
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
                {(!recentRequests || recentRequests.length === 0) && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      No requests yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </>
  );
}

function KpiCard({
  label,
  value,
  warn,
  highlight,
}: {
  label: string;
  value: number;
  warn?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        'rounded-md border-2 border-foreground/80 p-4 ' +
        (warn
          ? 'bg-destructive/10'
          : highlight
          ? 'bg-lime/40'
          : 'bg-background')
      }
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-display text-3xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'bg-foreground/10 text-foreground';
  return (
    <span
      className={
        'inline-block rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ' +
        tone
      }
    >
      {status}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  pending_payment: 'bg-foreground/10 text-foreground',
  paid: 'bg-lime text-ink',
  calling: 'bg-lime/60 text-ink',
  processing: 'bg-lime/40 text-ink',
  completed: 'bg-foreground text-background',
  failed: 'bg-destructive/20 text-destructive',
};

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
