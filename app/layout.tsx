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
import { Analytics } from '@vercel/analytics/next';
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

export const metadata: Metadata = {
  title: 'EvenQuote — Get 20+ quotes in an hour, not a week',
  description:
    'We dial local pros for you. You get a clean comparison report in your inbox. $9.99 flat.',
  openGraph: {
    title: 'EvenQuote',
    description: 'AI-powered quote collection from local service providers.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
