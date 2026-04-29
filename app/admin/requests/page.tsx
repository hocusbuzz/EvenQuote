// /admin/requests — every quote request in the system, R47.2 rebuild.
//
// Data layer here is small: parse search params, run one Supabase
// query with all filters applied, hand the rows + pagination math
// off to the <RequestsExplorer> client component which owns the
// entire interactive surface (filter bar, sortable headers,
// checkbox selection, per-row action menu, sticky bulk-action bar).
//
// All filter / sort state lives in the URL — the explorer pushes
// updates via router.replace and the server re-renders. The server
// is the single source of truth for which rows are visible.
//
// Search behavior: Postgres OR ilike across city, intake_data ->>
// 'contact_name', intake_data ->> 'contact_email'. Not a full-text
// index — at our pre-launch volume a sequential scan is fine. Add
// a tsvector + GIN index when this slows down (probably 10k+ rows).
//
// Sort keys map onto real columns:
//   created_at | status | total_calls_completed (calls)
//   total_quotes_collected (quotes) | city (location)

import type { Metadata } from 'next';
import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { SiteNavbar } from '@/components/site/navbar';
import {
  RequestsExplorer,
  type ExplorerRow,
  type ExplorerCategory,
  type SortKey,
  type SortDir,
} from '@/components/admin/requests-explorer';

export const metadata: Metadata = {
  title: 'Requests · Admin',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const VALID_STATUSES = new Set([
  'pending_payment',
  'paid',
  'calling',
  'processing',
  'completed',
  'failed',
]);

const VALID_SORTS = new Set<SortKey>([
  'created_at',
  'status',
  'calls',
  'quotes',
  'location',
]);

// Sort key → actual column for the .order() call. We expose
// "calls" / "quotes" / "location" as friendlier API surface than
// raw column names.
const SORT_COLUMN: Record<SortKey, string> = {
  created_at: 'created_at',
  status: 'status',
  calls: 'total_calls_completed',
  quotes: 'total_quotes_collected',
  location: 'city',
};

function maskEmail(s: unknown): string | null {
  if (typeof s !== 'string' || !s) return null;
  return s.replace(/(.{2}).+(@.+)/, '$1…$2');
}

export default async function AdminRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    status?: string;
    include_archived?: string;
    q?: string;
    from?: string;
    to?: string;
    category?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const sp = await searchParams;

  // ── Parse + clamp inputs ──────────────────────────────────────
  const page = Math.max(1, Number(sp.page ?? 1) | 0);
  const status = sp.status && VALID_STATUSES.has(sp.status) ? sp.status : '';
  const includeArchived = sp.include_archived === '1';
  const q = (sp.q ?? '').trim();
  const from = (sp.from ?? '').trim();
  const to = (sp.to ?? '').trim();
  const category = (sp.category ?? '').trim();
  const sort: SortKey = VALID_SORTS.has(sp.sort as SortKey)
    ? (sp.sort as SortKey)
    : 'created_at';
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc';

  const fromIdx = (page - 1) * PAGE_SIZE;
  const toIdx = fromIdx + PAGE_SIZE - 1;

  // ── Categories for the dropdown + filter resolution ──
  // One query returns id+slug+name. The dropdown only renders
  // {slug, name} but the id is needed to translate the URL's
  // ?category=slug into a category_id eq filter on quote_requests.
  const { data: catData } = await admin
    .from('service_categories')
    .select('id, slug, name')
    .eq('is_active', true)
    .order('name');
  const categories: ExplorerCategory[] = (catData ?? []).map((c) => ({
    slug: c.slug as string,
    name: c.name as string,
  }));

  let categoryId: string | null = null;
  if (category) {
    const match = (catData ?? []).find(
      (c) => (c as { slug?: string }).slug === category
    );
    categoryId = (match as { id?: string } | undefined)?.id ?? null;
  }

  // ── Build the query ──────────────────────────────────────────
  let query = admin
    .from('quote_requests')
    .select(
      `id, status, city, state, zip_code,
       total_businesses_to_call, total_calls_completed, total_quotes_collected,
       intake_data, archived_at, created_at,
       service_categories:category_id(name, slug)`,
      { count: 'exact' }
    );

  if (status) query = query.eq('status', status);
  if (!includeArchived) query = query.is('archived_at', null);
  if (categoryId) query = query.eq('category_id', categoryId);
  if (from) query = query.gte('created_at', `${from}T00:00:00Z`);
  if (to) query = query.lte('created_at', `${to}T23:59:59Z`);

  if (q) {
    // PostgREST or-filter: city OR contact_name OR contact_email
    // matches a case-insensitive substring of q. JSONB ->> path is
    // valid in PostgREST or-clauses.
    const term = q.replace(/[(),]/g, ' '); // strip syntax-significant chars
    const safe = `%${term}%`;
    query = query.or(
      [
        `city.ilike.${safe}`,
        `intake_data->>contact_name.ilike.${safe}`,
        `intake_data->>contact_email.ilike.${safe}`,
        `zip_code.ilike.${safe}`,
      ].join(',')
    );
  }

  query = query
    .order(SORT_COLUMN[sort], { ascending: dir === 'asc', nullsFirst: false })
    // Stable secondary sort so same-key rows have a deterministic
    // order page-to-page (avoids row jitter in pagination).
    .order('id', { ascending: true })
    .range(fromIdx, toIdx);

  const { data: rawRows, count } = await query;
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Shape rows for the client component — flatten the joined category
  // and pre-mask the email so the client never sees the raw string.
  const rows: ExplorerRow[] = (rawRows ?? []).map((r) => {
    const sc = Array.isArray(r.service_categories)
      ? r.service_categories[0]
      : r.service_categories;
    const intake = (r.intake_data ?? {}) as Record<string, unknown>;
    return {
      id: r.id as string,
      status: r.status as string,
      city: (r.city as string) ?? '',
      state: (r.state as string) ?? '',
      zip_code: (r.zip_code as string) ?? '',
      total_businesses_to_call: (r.total_businesses_to_call as number | null) ?? 0,
      total_calls_completed: (r.total_calls_completed as number | null) ?? 0,
      total_quotes_collected: (r.total_quotes_collected as number | null) ?? 0,
      archived_at: (r.archived_at as string | null) ?? null,
      created_at: r.created_at as string,
      category_name:
        (sc as { name?: string } | null | undefined)?.name ?? null,
      contact_name:
        typeof intake.contact_name === 'string'
          ? (intake.contact_name as string)
          : null,
      contact_email_masked: maskEmail(intake.contact_email),
    };
  });

  return (
    <>
      <SiteNavbar />
      <main className="container py-10 sm:py-14">
        <div className="mb-6">
          <p className="label-eyebrow mb-1">
            <Link href="/admin" className="hover:underline">
              Admin
            </Link>{' '}
            / Requests
          </p>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Quote requests
          </h1>
        </div>

        <RequestsExplorer
          rows={rows}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          pages={pages}
          categories={categories}
          initial={{
            q,
            from,
            to,
            category,
            status: status || 'all',
            includeArchived,
            sort,
            dir,
          }}
        />
      </main>
    </>
  );
}
