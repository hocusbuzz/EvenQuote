// Contract lock for the root Open Graph / Twitter / robots metadata.
//
// Why this exists:
//   1. Link-preview art (public/og-image.png) and favicons are still
//      placeholders. When real art lands, a careless edit could
//      accidentally drop a required OG field (e.g. twitter:card, og:url,
//      metadataBase) and every shared link silently degrades to a
//      no-image preview. This file fails LOUDLY on that regression.
//   2. The root layout must stay indexable (robots.index = true) — the
//      legal-page metadata.test.ts locks the INVERSE for draft legal
//      pages. Two orthogonal contracts, each with its own test.
//   3. We also lock the canonical alternate (`/`) so UTM variants don't
//      split link equity, and the metadataBase so relative URLs resolve
//      at build time without "metadataBase is unset" warnings on Vercel.
//
// Whenever the metadata shape intentionally changes, update the lock.

import { describe, expect, it, vi } from 'vitest';

// next/font + geist both do dynamic resolution that Vitest/Vite cannot
// follow (Node ESM rejects the "next/font/local" directory import that
// geist ships). These mocks cover ONLY the surface layout.tsx uses —
// font loader calls that return a CSS-variable-shaped object. We only
// care about the `metadata` export here; rendered font classes are
// unused in this test.
vi.mock('next/font/google', () => ({
  Fraunces: () => ({ variable: '--font-fraunces' }),
}));
vi.mock('geist/font/sans', () => ({
  GeistSans: { variable: '--font-geist-sans' },
}));
vi.mock('geist/font/mono', () => ({
  GeistMono: { variable: '--font-geist-mono' },
}));
vi.mock('next/headers', () => ({
  headers: () => ({ get: () => null }),
}));

import { metadata } from './layout';

describe('root layout metadata', () => {
  it('resolves metadataBase to an absolute URL (required for relative OG paths)', () => {
    // next/metadata needs an absolute base to turn `/og-image.png` into a
    // crawler-resolvable absolute URL. Without this, OG scrapers warn
    // and some (LinkedIn, older iMessage) drop the image entirely.
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(metadata.metadataBase?.protocol).toMatch(/^https?:$/);
    expect(metadata.metadataBase?.host).toBeTruthy();
  });

  it('sets a title (with default + template shape so sub-pages compose)', () => {
    // title as object → Next formats child page titles via `template`.
    // If a refactor flattens it to a plain string, the " | EvenQuote"
    // suffix disappears everywhere.
    expect(metadata.title).toBeDefined();
    expect(typeof metadata.title).toBe('object');
    const t = metadata.title as { default: string; template: string };
    expect(t.default).toBeTruthy();
    expect(t.template).toContain('EvenQuote');
  });

  it('sets a non-empty description', () => {
    expect(metadata.description).toBeTruthy();
    expect(typeof metadata.description).toBe('string');
  });

  it('sets canonical alternate to "/" so UTM variants do not split link equity', () => {
    expect(metadata.alternates?.canonical).toBe('/');
  });

  describe('Open Graph block (required for link previews)', () => {
    it('carries all crawler-required OG fields', () => {
      const og = metadata.openGraph;
      expect(og).toBeDefined();
      if (!og) throw new Error('openGraph missing');
      // Next's OpenGraph is a discriminated union (website|article|…);
      // we want plain structural checks, so assert-through Record<string>.
      const ogAny = og as unknown as Record<string, unknown>;
      // Each of these is a separate failure mode:
      //  - missing type → LinkedIn renders as "website" by default (ok) but
      //    Facebook flags an OG warning.
      //  - missing url → previews become non-canonical when shared from
      //    query-string variants.
      //  - missing title / description → zero-text card.
      //  - missing siteName → no "from EvenQuote" attribution row.
      expect(ogAny.type).toBe('website');
      expect(ogAny.url).toBeTruthy();
      expect(ogAny.title).toBeTruthy();
      expect(ogAny.description).toBeTruthy();
      expect(ogAny.siteName).toBe('EvenQuote');
      expect(ogAny.locale).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
    });
  });

  describe('Twitter card block', () => {
    it('uses summary_large_image (the big-card preview) with title+description', () => {
      const tw = metadata.twitter;
      expect(tw).toBeDefined();
      if (!tw) throw new Error('twitter missing');
      // summary_large_image is the 2:1 card. Without this, links render
      // as the tiny square variant which is measurably worse for CTR.
      expect((tw as { card?: string }).card).toBe('summary_large_image');
      expect((tw as { title?: string }).title).toBeTruthy();
      expect((tw as { description?: string }).description).toBeTruthy();
    });
  });

  describe('robots block (crawler directives)', () => {
    it('is indexable at the site root (legal pages lock the inverse)', () => {
      // Complement to app/legal/metadata.test.ts which locks
      // index:false for draft legal pages. If someone inverts THIS
      // test to noindex, the homepage drops out of Google.
      const r = metadata.robots as {
        index?: boolean;
        follow?: boolean;
        googleBot?: Record<string, unknown>;
      };
      expect(r.index).toBe(true);
      expect(r.follow).toBe(true);
      expect(r.googleBot?.index).toBe(true);
    });
  });

  describe('format detection (trust signals)', () => {
    it('disables automatic linkification of emails / addresses / phones', () => {
      // iOS and some mobile browsers auto-linkify anything that LOOKS
      // like a phone or email in body copy. That turns EvenQuote's
      // prose into accidental tel: / mailto: links. Disabling keeps
      // typography + brand voice stable.
      expect(metadata.formatDetection).toEqual({
        email: false,
        address: false,
        telephone: false,
      });
    });
  });
});
