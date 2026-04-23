// Dynamic robots.txt.
//
// Strategy:
//   • Allow everything on the marketing surface (/, /get-quotes, /get-quotes/:category).
//   • Disallow authenticated and transactional paths. These return 200s
//     with near-empty content for unauthenticated crawlers anyway (thanks
//     to middleware redirects), but telling Google not to bother keeps
//     the crawl budget focused on pages that actually convert.
//   • Disallow /api and /auth — no SEO value, pure noise if indexed.
//   • Point sitemaps at the Next.js route handler (app/sitemap.ts).

import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? 'https://evenquote.com').replace(/\/$/, '');

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: [
          '/api/',
          '/auth/',
          '/dashboard',
          '/dashboard/',
          '/admin',
          '/admin/',
          '/get-quotes/checkout',
          '/get-quotes/success',
          '/maintenance',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
