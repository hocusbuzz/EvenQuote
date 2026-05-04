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
  //
  // The Today's-pulse cards are funnel-focused (founder's "did launch
  // convert?" question); the Operations cards below are ops-focused
  // (the operator's "what's broken right now?" question). Same data
  // surface, different framing.
  const [
    // ── Today's pulse (founder funnel) ──────────────────────────
    requestsStartedToday,
    paidToday,
    couponRedeemedToday,
    reportsDeliveredToday,
    completedRequestsToday,
    paidAllTimeRows,
    // ── Operations (ops alerting) ───────────────────────────────
    requests48h,
    paidAllTime,
    callsInProgress,
    callsToday,
    quotesToday,
    failedDlq,
  ] = await Promise.all([
    // Today: every quote_request created (any status).
    admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sinceToday),
    // Today: payments rows in 'completed' status (Stripe webhook hit).
    // We pull rows + amounts (not head:true) so we can sum revenue.
    admin
      .from('payments')
      .select('amount, currency')
      .eq('status', 'completed')
      .gte('created_at', sinceToday),
    // Today: quote_requests with a coupon redemption. Coupon-paid
    // rows DON'T create a payments row (the redeem_coupon RPC flips
    // status='paid' directly without inserting payments), so the
    // revenue card above is unaffected — this is a SEPARATE counter
    // so the founder can distinguish "paid customers" from "free
    // friend redemptions" without leaving /admin. Uses created_at
    // (not a stamped redeemed_at) so it counts the request, not the
    // coupon mint event — matches the rest of the day-bounded queries.
    admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .not('coupon_code', 'is', null)
      .gte('created_at', sinceToday),
    // Today: reports actually delivered (Resend send succeeded). Uses
    // report_sent_at because send-reports stamps it on outbox claim
    // BEFORE the email goes out — a row with report_sent_at set is
    // the closest signal to "we put an email on the wire."
    admin
      .from('quote_requests')
      .select('id', { count: 'exact', head: true })
      .gte('report_sent_at', sinceToday),
    // Today: completed requests, with quote counts attached so we can
    // compute avg quotes/report. Cap at 100 — if we ship 100+ requests
    // a day this becomes a problem worth solving with a SQL aggregate.
    admin
      .from('quote_requests')
      .select('id, total_quotes_collected')
      .eq('status', 'completed')
      .gte('created_at', sinceToday)
      .limit(100),
    // All-time revenue. Same cap rationale — a 100-row cap is a
    // tripwire for "we should switch to a SQL sum() RPC."
    admin
      .from('payments')
      .select('amount')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1000),
    // ── Operations queries (unchanged shape) ────────────────────
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

  // Derived metrics for the pulse panel.
  const paidCountToday = paidToday.data?.length ?? 0;
  // Revenue: payments.amount is cents (integer). Sum + format as USD.
  // We assume all payments are USD because the checkout doesn't expose
  // a currency switcher today; if that ever changes, group by currency.
  const revenueTodayCents = (paidToday.data ?? []).reduce(
    (sum, p) => sum + (p.amount ?? 0),
    0,
  );
  const completedToday = completedRequestsToday.data ?? [];
  const avgQuotesPerReportToday =
    completedToday.length > 0
      ? completedToday.reduce(
          (sum, r) => sum + (r.total_quotes_collected ?? 0),
          0,
        ) / completedToday.length
      : null;
  const revenueAllTimeCents = (paidAllTimeRows.data ?? []).reduce(
    (sum, p) => sum + (p.amount ?? 0),
    0,
  );

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

        {/* Today's pulse — funnel-focused founder view. Reads top to
            bottom: did people show up? did they pay? did we deliver?
            were the deliveries good? Revenue is the loudest card on
            purpose — it's the first number you check pre-launch. */}
        <section className="mb-8">
          <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Today&apos;s pulse — {todayHumanLabel()}
          </p>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <PulseCard
              label="Revenue today"
              value={formatUsdCents(revenueTodayCents)}
              tone={revenueTodayCents > 0 ? 'highlight' : 'neutral'}
            />
            <PulseCard
              label="Paid today"
              value={String(paidCountToday)}
              sub={
                paidCountToday > 0
                  ? `${paidCountToday * 999 - revenueTodayCents === 0 ? '@$9.99' : 'mixed'}`
                  : undefined
              }
              tone={paidCountToday > 0 ? 'highlight' : 'neutral'}
            />
            <PulseCard
              label="Coupons today"
              value={String(couponRedeemedToday.count ?? 0)}
              sub={
                (couponRedeemedToday.count ?? 0) > 0
                  ? 'free redemptions'
                  : undefined
              }
            />
            <PulseCard
              label="Requests started"
              value={String(requestsStartedToday.count ?? 0)}
              sub={
                (requestsStartedToday.count ?? 0) > 0
                  ? `${Math.round(
                      (((paidCountToday + (couponRedeemedToday.count ?? 0)) /
                        (requestsStartedToday.count ?? 1)) *
                        100),
                    )}% converted`
                  : undefined
              }
            />
            <PulseCard
              label="Reports delivered"
              value={String(reportsDeliveredToday.count ?? 0)}
            />
            <PulseCard
              label="Avg quotes/report"
              value={
                avgQuotesPerReportToday !== null
                  ? avgQuotesPerReportToday.toFixed(1)
                  : '—'
              }
              sub={
                avgQuotesPerReportToday !== null
                  ? `${completedToday.length} report${completedToday.length === 1 ? '' : 's'}`
                  : 'no completions yet'
              }
            />
          </div>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Lifetime revenue: {formatUsdCents(revenueAllTimeCents)}
          </p>
        </section>

        {/* Operations KPI cards — ops alerting (what's broken right now). */}
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Operations
        </p>
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

/**
 * Pulse cards take a string value (so we can format dollars / decimals
 * before passing in) plus an optional `sub` for context like "30% paid"
 * or "@$9.99". Slightly larger numerals than KpiCard since this row
 * is what the founder reads first.
 */
function PulseCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'highlight' | 'neutral';
}) {
  return (
    <div
      className={
        'rounded-md border-2 border-foreground/80 p-4 ' +
        (tone === 'highlight' ? 'bg-lime/40' : 'bg-background')
      }
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-display text-3xl font-bold tabular-nums sm:text-4xl">
        {value}
      </p>
      {sub ? (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {sub}
        </p>
      ) : null}
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

function todayHumanLabel(): string {
  // Server-side render uses the server's TZ. Operator is in Pacific
  // per CLAUDE.md context — Vercel serverless is UTC. We render the
  // ISO date intentionally (no timezone math) since "today" is
  // already anchored to startOfTodayIso() above using the same TZ.
  // If the operator is reading at midnight UTC, the label flips a few
  // hours before their local midnight — acceptable for v1.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Format a USD-cents integer as "$X.XX" or "$X,XXX.XX". Returns "$0.00"
 * for missing/null. Currency symbol hard-coded to $ — checkout doesn't
 * expose currency switching today. Add a currency arg if that changes.
 */
function formatUsdCents(cents: number): string {
  const dollars = (cents ?? 0) / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(dollars);
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
