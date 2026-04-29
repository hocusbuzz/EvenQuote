// Root layout.
//
// Fonts are loaded via `next/font` which:
//   1. self-hosts the font files (no Google CDN = no external request)
//   2. inlines subset CSS at build time (no FOUT)
//   3. exposes a CSS variable we reference in tailwind.config.ts
//
// Fraunces is our display serif (variable font with SOFT and WONK axes).
// Geist Sans is our body. Geist Mono for eyebrow labels and data.
// Explicitly avoiding Inter / system-ui — too generic.
//
// Geist is loaded via the `geist` npm package (published by Vercel) rather
// than next/font/google — Next 14 doesn't expose Geist/Geist_Mono via the
// Google Fonts helper (those are Next 15+). The `geist` package gives us
// the same self-hosted, CSS-variable-based API with no external requests.

import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { headers } from 'next/headers';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  weight: ['400', '500', '600', '700', '800', '900'],
  // Fraunces has custom SOFT and WONK axes — skipping them here because
  // next/font's axes prop support for non-standard Google Fonts axes is
  // inconsistent across Next versions. Weights alone give us plenty of
  // expressive range. We can revisit if we want to animate the axes later.
  display: 'swap',
});

// Base URL for metadata resolution (OG images, canonical URLs). Falls
// back to the production apex so `next build` at prerender time doesn't
// warn about relative URLs when NEXT_PUBLIC_APP_URL is unset locally.
const METADATA_BASE = new URL(
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://evenquote.com'
);

export const metadata: Metadata = {
  metadataBase: METADATA_BASE,
  title: {
    default: 'EvenQuote — Get 10 real quotes in an hour, not a week',
    template: '%s | EvenQuote',
  },
  description:
    'We dial local pros for you. You get a clean comparison report in your inbox. $9.99 flat.',
  keywords: [
    'quote comparison',
    'local services',
    'moving quotes',
    'cleaning quotes',
    'AI quote collection',
    'contractor quotes',
  ],
  authors: [{ name: 'EvenQuote' }],
  creator: 'EvenQuote',
  publisher: 'EvenQuote',
  applicationName: 'EvenQuote',
  category: 'Services',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  // Canonical URL — without this, Google may treat /?utm=… variants as
  // separate pages and split link equity. metadataBase scoped, so '/'
  // resolves to the canonical root.
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    title: 'EvenQuote — Get 10 real quotes in an hour',
    description:
      'We dial local pros for you. You get a clean comparison report in your inbox. $9.99 flat.',
    siteName: 'EvenQuote',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'EvenQuote — Get 10 real quotes in an hour',
    description:
      'AI-powered quote collection from local service providers. $9.99 flat.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

// JSON-LD structured data for Google Search. Organization + WebSite +
// Service schemas help search render a richer listing (sitelinks,
// knowledge panel, service category). Kept literal rather than
// generated from env so the shape is obvious on PR review.
//
// See https://schema.org/Organization and
// https://developers.google.com/search/docs/appearance/structured-data/logo
const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'EvenQuote',
  url: 'https://evenquote.com',
  logo: 'https://evenquote.com/og-image.png',
  slogan: 'Stop chasing quotes. Start comparing them.',
  description:
    'EvenQuote calls local service providers on your behalf and returns a structured quote comparison — a $9.99 flat-fee alternative to spending your Saturday on the phone.',
  sameAs: [],
};

const websiteSchema = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'EvenQuote',
  url: 'https://evenquote.com',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware (behind CSP_NONCE_ENABLED) sets this per-request so
  // server components can nonce any inline <script> they render.
  // When the flag is OFF, the header is absent and `nonce` is
  // undefined — in that mode the static CSP from next.config.mjs is
  // in force and inline JSON-LD is allowed without a nonce attribute.
  // When the flag is ON, the header carries a fresh base64 nonce per
  // request; we thread it through the dangerouslySetInnerHTML scripts
  // below so they pass `script-src 'self' 'nonce-…' 'strict-dynamic'`.
  const nonce = headers().get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {/* Skip-to-content link. Visually hidden by default (see the
            .sr-only utility in globals.css) but becomes visible when
            keyboard-focused — the standard pattern for a11y skip links.
            Lets keyboard / screen-reader users bypass the navbar on
            every page without tabbing through its contents. Targets
            the #main-content wrapper below, which receives tabIndex=-1
            so focus lands there cleanly after the activation. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-background focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        {/* JSON-LD structured data. Emitted as script tags so Google can
            parse them. dangerouslySetInnerHTML is the standard React way
            to inject raw JSON here — the content is a literal constant
            above, not user input, so there's no injection surface.

            Nonce: when CSP_NONCE_ENABLED=true, middleware generates a
            fresh base64 nonce per request and sets `x-nonce` on the
            request headers. We read that above and apply it here so
            these inline <script> tags pass `script-src 'nonce-…'`. When
            the flag is off, `nonce` is undefined and React omits the
            attribute — matching the current static-CSP behavior. */}
        <script
          type="application/ld+json"
          nonce={nonce}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
        <script
          type="application/ld+json"
          nonce={nonce}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteSchema) }}
        />
        {/* Non-interactive wrapper, target for the skip link. tabIndex
            -1 makes it programmatically focusable without being in the
            natural tab order. */}
        <div id="main-content" tabIndex={-1} className="outline-none">
          {children}
        </div>
      </body>
    </html>
  );
}
