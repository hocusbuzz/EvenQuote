// /dashboard — list of the signed-in user's quote requests.
//
// Phase 8 upgrade: was a Phase 2 checkpoint stub; now pulls the user's
// quote_requests with a light per-request quote count so they can drill
// into a detail page and release their contact to specific businesses.
//
// Data pulled through the cookie-bound client so RLS filters to the
// current user automatically — no service-role here.

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser, getProfile } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { SiteNavbar } from '@/components/site/navbar';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/lib/logger';

const log = createLogger('dashboard');

// Private — don't let it show up in search; browser tab still gets a useful title.
export const metadata: Metadata = {
  title: 'Your quote requests',
  robots: { index: false, follow: false },
};

type RequestRow = {
  id: string;
  status: string;
  city: string;
  state: string;
  created_at: string;
  total_businesses_to_call: number;
  total_calls_completed: number;
  total_quotes_collected: number;
  category: { name: string; slug: string } | null;
};

export default async function DashboardPage() {
  // Middleware already guards this path — defense in depth.
  await requireUser('/dashboard');
  const profile = await getProfile();
  const supabase = await createClient();

  // RLS policy "quote_requests: owner read" constrains this to the
  // current user automatically.
  const { data: rows, error } = await supabase
    .from('quote_requests')
    .select(
      `
      id,
      status,
      city,
      state,
      created_at,
      total_businesses_to_call,
      total_calls_completed,
      total_quotes_collected,
      category:service_categories!quote_requests_category_id_fkey(name, slug)
    `
    )
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    log.error('list failed', { err: error });
  }

  const requests = (rows ?? []).map((r) => {
    const catRaw = (r as { category?: unknown }).category;
    const category = Array.isArray(catRaw) ? catRaw[0] : catRaw;
    return { ...r, category: category ?? null } as RequestRow;
  });

  return (
    <>
      <SiteNavbar />
      <main className="container max-w-4xl py-12">
        <header className="mb-10 flex items-start justify-between gap-4">
          <div>
            <p className="label-eyebrow mb-2">Your account</p>
            <h1 className="font-display text-4xl font-bold tracking-tight">
              Your quote requests
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Signed in as {profile?.email ?? '—'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Admin shortcut, only visible to profiles.role='admin'.
                The navbar also surfaces this, but a lot of flows land
                people directly on /dashboard (post-login redirect),
                so having it here too saves a click. */}
            {profile?.role === 'admin' ? (
              <Link
                href="/admin"
                className="rounded-md border-2 border-lime px-3 py-1.5 text-sm font-medium hover:bg-lime"
              >
                Admin
              </Link>
            ) : null}
            <Link
              href="/dashboard/billing"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-lime"
            >
              Billing
            </Link>
            <form action="/auth/signout" method="POST">
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </header>

        {requests.length === 0 ? (
          <section className="rounded-lg border border-border bg-card p-8 text-center text-card-foreground">
            <h2 className="font-display text-xl font-semibold">No requests yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Tell us what you need and we'll call local pros on your behalf.
            </p>
            <Link href="/get-quotes" className="mt-6 inline-block">
              <Button size="lg">Start a quote request</Button>
            </Link>
          </section>
        ) : (
          <ul className="space-y-4">
            {requests.map((r) => (
              <li
                key={r.id}
                className="rounded-lg border border-border bg-card p-5 text-card-foreground"
              >
                <Link
                  href={`/dashboard/requests/${r.id}`}
                  className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-display text-lg font-semibold">
                        {r.category?.name ?? 'Service'} in {r.city}, {r.state}
                      </span>
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Submitted {new Date(r.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <div>
                      {r.total_quotes_collected} of {r.total_businesses_to_call}{' '}
                      quote{r.total_businesses_to_call === 1 ? '' : 's'}
                    </div>
                    <div className="text-xs">
                      {r.total_calls_completed} call
                      {r.total_calls_completed === 1 ? '' : 's'} completed
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'completed'
      ? 'bg-green-100 text-green-800 border-green-200'
      : status === 'calling' || status === 'processing'
        ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
        : status === 'pending_payment'
          ? 'bg-gray-100 text-gray-800 border-gray-200'
          : 'bg-muted text-muted-foreground border-border';
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${color}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
