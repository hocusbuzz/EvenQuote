// Dynamic sitemap.xml.
//
// Pulls active service_categories from Supabase (admin client — this is
// a public-read build-time concern, not a per-user query) and adds each
// /get-quotes/:slug page to the sitemap. Falls back to a static list if
// the DB is unreachable at build time — don't want a sitemap build
// failure to block a deploy.
//
// ── Observability contract (R35 audit) ────────────────────────────
// This generator deliberately does NOT wire captureException on any
// path. Reasoning:
//   1. PUBLIC BOT-CRAWL FREQUENCY — Google's sitemap fetcher hits
//      /sitemap.xml on its own schedule (typically daily, sometimes
//      more often during a recrawl). A captureException on the DB-
//      unreachable branch would flood Sentry at crawler frequency
//      during a transient Supabase outage. Same rationale as the
//      R33 health/version probe attestation and R32 csp-report
//      attestation.
//   2. GRACEFUL DEGRADATION IS THE FEATURE — the bare `try { } catch
//      { categories = []; }` is intentional. A DB hiccup at sitemap-
//      generation time degrades to a static-only sitemap; any other
//      reachable downstream (deploy, dashboard, crons) will surface
//      the underlying Supabase outage with its own canonical capture
//      tags well before this is the first-noticed signal. Wrapping
//      this catch with captureException would (a) double-capture vs
//      whatever app/api/cron/check-status's stripe/vapi probe is
//      already firing, (b) add no new operator signal — they already
//      know the DB is down.
//   3. NEXT.JS PLATFORM OWNS THE ROUTE BOUNDARY — if the function
//      itself throws outside the try-block (it can't on the current
//      code paths — the only operations are Date construction, env
//      read, and template-string interpolation, none of which can
//      throw), the App Router serves a generic 500 and the platform
//      Sentry wrapping kicks in. R26 no-double-capture rule.
//
// Regression-guards in sitemap.test.ts lock this no-capture
// contract. If you ever need to break the rule, update the test AND
// add a comment justifying the new capture site.

import type { MetadataRoute } from 'next';

const BASE =
  (process.env.NEXT_PUBLIC_APP_URL ?? 'https://evenquote.com').replace(/\/$/, '');

// Static surface — always present even if category fetch fails.
const STATIC_ENTRIES: MetadataRoute.Sitemap = [
  {
    url: `${BASE}/`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 1.0,
  },
  {
    url: `${BASE}/get-quotes`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: 0.9,
  },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // We deliberately do NOT import the admin client here at module-load
  // time — it would eagerly require SUPABASE_SERVICE_ROLE_KEY, which
  // would fail the build on an improperly-configured deploy. Late-import.
  let categories: Array<{ slug: string; updated_at?: string | null }> = [];
  try {
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const admin = createAdminClient();
    const { data } = await admin
      .from('service_categories')
      .select('slug, updated_at:created_at')
      .eq('is_active', true);
    if (data) categories = data as typeof categories;
  } catch {
    // DB unreachable at build time — ship the static sitemap.
    categories = [];
  }

  const dynamicEntries: MetadataRoute.Sitemap = categories.map((c) => ({
    url: `${BASE}/get-quotes/${c.slug}`,
    lastModified: c.updated_at ? new Date(c.updated_at) : new Date(),
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  return [...STATIC_ENTRIES, ...dynamicEntries];
}
