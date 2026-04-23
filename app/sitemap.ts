// Dynamic sitemap.xml.
//
// Pulls active service_categories from Supabase (admin client — this is
// a public-read build-time concern, not a per-user query) and adds each
// /get-quotes/:slug page to the sitemap. Falls back to a static list if
// the DB is unreachable at build time — don't want a sitemap build
// failure to block a deploy.

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
