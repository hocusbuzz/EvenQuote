// /admin/users — every registered user, with rollup counts.
//
// Data shown per user:
//   • email, full_name, role (customer/admin), created_at
//   • # of quote_requests (filtered to non-archived)
//   • total $ paid (sum of completed payments)
//   • last activity (most recent quote_request created)
//
// All counts are computed admin-side via separate queries and joined
// by user_id in the page. This is fine at pre-launch scale. Once we
// pass ~500 users we should move this to a database view.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';

export const metadata: Metadata = {
  title: 'Users · Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const sp = await searchParams;
  const queryText = (sp.q ?? '').trim();

  // 1. Fetch profiles (all or filtered by email-ilike).
  let profilesQ = admin
    .from('profiles')
    .select('id, email, full_name, role, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (queryText.length > 0) {
    profilesQ = profilesQ.ilike('email', `%${queryText}%`);
  }
  const { data: profiles } = await profilesQ;

  // 2. In a single round trip, fetch all quote_requests + payments for
  //    THESE users (not every row in the DB) and build in-memory counts.
  const userIds = (profiles ?? []).map((p) => p.id);

  const [reqsRes, paymentsRes] = await Promise.all([
    userIds.length
      ? admin
          .from('quote_requests')
          .select('id, user_id, created_at, status, archived_at')
          .in('user_id', userIds)
      : Promise.resolve({ data: [] as Array<{
          id: string;
          user_id: string;
          created_at: string;
          status: string;
          archived_at: string | null;
        }> }),
    userIds.length
      ? admin
          .from('payments')
          .select('user_id, amount, status')
          .in('user_id', userIds)
      : Promise.resolve({ data: [] as Array<{
          user_id: string;
          amount: number;
          status: string;
        }> }),
  ]);

  // Bucket by user_id.
  const statsByUser = new Map<
    string,
    { requests: number; archived: number; lastActivity: string | null; paidCents: number }
  >();
  for (const uid of userIds) {
    statsByUser.set(uid, { requests: 0, archived: 0, lastActivity: null, paidCents: 0 });
  }
  for (const r of reqsRes.data ?? []) {
    const s = statsByUser.get(r.user_id);
    if (!s) continue;
    if (r.archived_at) s.archived += 1;
    else s.requests += 1;
    if (!s.lastActivity || r.created_at > s.lastActivity) {
      s.lastActivity = r.created_at;
    }
  }
  for (const p of paymentsRes.data ?? []) {
    const s = statsByUser.get(p.user_id);
    if (!s) continue;
    if (['succeeded', 'paid', 'completed'].includes(p.status)) {
      s.paidCents += p.amount ?? 0;
    }
  }

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-eyebrow mb-1">
              <Link href="/admin" className="hover:underline">Admin</Link> / Users
            </p>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Users
            </h1>
            <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
              {profiles?.length ?? 0} shown · top 200 by signup date
            </p>
          </div>

          <form action="/admin/users" className="flex gap-2">
            <input
              name="q"
              defaultValue={queryText}
              placeholder="Search email…"
              className="rounded-md border-2 border-foreground/40 bg-background px-2 py-1 font-mono text-xs"
            />
            <button
              type="submit"
              className="rounded-md border-2 border-foreground/80 px-3 py-1 font-mono text-xs uppercase tracking-widest hover:bg-lime"
            >
              Search
            </button>
          </form>
        </div>

        <div className="overflow-hidden rounded-md border-2 border-foreground/80">
          <table className="w-full text-sm">
            <thead className="bg-foreground/5 text-left font-mono text-[11px] uppercase tracking-widest">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Signed up</th>
                <th className="px-3 py-2 text-right">Requests</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Last activity</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(profiles ?? []).map((p) => {
                const s = statsByUser.get(p.id) ?? {
                  requests: 0,
                  archived: 0,
                  lastActivity: null,
                  paidCents: 0,
                };
                return (
                  <tr key={p.id} className="border-t border-foreground/10">
                    <td className="px-3 py-2 font-mono text-xs">{p.email}</td>
                    <td className="px-3 py-2">{p.full_name ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          'inline-block rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest ' +
                          (p.role === 'admin'
                            ? 'bg-foreground text-background'
                            : 'bg-foreground/10')
                        }
                      >
                        {p.role}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {new Date(p.created_at).toLocaleDateString([], {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {s.requests}
                      {s.archived ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          (+{s.archived} arch)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      ${(s.paidCents / 100).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[11px]">
                      {s.lastActivity
                        ? new Date(s.lastActivity).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/admin/users/${p.id}`}
                        className="font-mono text-xs uppercase tracking-widest underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {(!profiles || profiles.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    No matches.
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
