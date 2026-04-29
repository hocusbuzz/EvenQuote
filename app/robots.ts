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
//
// ── Observability contract (R35 audit) ────────────────────────────
// This generator deliberately does NOT wire captureException on any
// path. Reasoning:
//   1. PURE FUNCTION — no I/O, no async, no upstream call. The only
//      branchable input is one optional env var. There is nothing
//      to fail except the env-var read, which TypeScript guarantees
//      cannot throw at runtime (string | undefined). Adding a
//      try/catch around a pure expression is dead code.
//   2. PUBLIC BOT-CRAWL FREQUENCY — Google's robotstxt fetcher hits
//      this endpoint on every recrawl pass (multiple times per day
//      per property). A captureException here would flood Sentry at
//      crawler frequency on any transient deploy hiccup. Same
//      rationale as the R33 health/version probe attestation.
//   3. NEXT.JS PLATFORM OWNS THE ROUTE BOUNDARY — if this function
//      ever throws (it can't, by point 1), the App Router serves a
//      generic 500 and @sentry/nextjs's RouteHandler wrapping kicks
//      in at the platform level. Wrapping again here would double-
//      capture the same throw with a different stack trace (R26
//      no-double-capture rule).
//
// Regression-guards in robots.test.ts lock this no-capture contract.
// If you ever need to break the rule, update the test AND add a
// comment justifying the new capture site.

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
