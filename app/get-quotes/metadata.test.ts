// Metadata lockdown for the /get-quotes flow.
//
// Three static pages + one dynamic page make up the user-facing quote
// intake flow. Each has a very specific indexability contract that must
// NOT silently regress:
//
//   /get-quotes                → indexable marketing landing page
//   /get-quotes/[category]     → indexable per-vertical intake page
//   /get-quotes/checkout       → NOINDEX (Stripe session URLs, leaks
//                                  per-request state if indexed)
//   /get-quotes/success        → NOINDEX (quote_request_id URL — see above)
//
// This test locks each page's metadata SHAPE so a future refactor can't
// accidentally:
//   (a) index a checkout / success URL and leak a request id to Google,
//   (b) drop the description on the public landing page (breaks OG cards),
//   (c) break the title composition for a vertical page.
//
// Complements:
//   - app/layout.metadata.test.ts  (root OG + robots + formatDetection)
//   - app/legal/metadata.test.ts   (noindex guard for draft legal pages)

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Static-metadata imports — these are plain object exports, safe to
// import directly. The dynamic [category] page is handled separately
// via generateMetadata() at the end of the file.
import { metadata as rootMetadata } from './page';
import { metadata as checkoutMetadata } from './checkout/page';
import { metadata as successMetadata } from './success/page';

describe('/get-quotes (public intake landing)', () => {
  it('has a non-empty title', () => {
    // Plain string OR { default, template } — both are valid Next
    // metadata shapes. We just require that SOMETHING renders.
    const t = rootMetadata.title;
    if (typeof t === 'string') {
      expect(t).toBeTruthy();
    } else if (t && typeof t === 'object') {
      // If a future refactor upgrades to the template shape.
      expect((t as { default?: string }).default).toBeTruthy();
    } else {
      throw new Error('get-quotes landing has no title');
    }
  });

  it('has a non-empty description (required for OG link cards)', () => {
    // Link previews on Slack / iMessage / LinkedIn pull this field.
    // Empty description → blank preview card → nobody clicks.
    expect(rootMetadata.description).toBeTruthy();
    expect(typeof rootMetadata.description).toBe('string');
  });

  it('does NOT set robots: noindex (this page is a public landing)', () => {
    // The sitemap includes /get-quotes — if someone sets noindex here,
    // the sitemap lies and Google drops the entry. This is a public
    // marketing surface.
    //
    // Cast through `unknown` because the source file types `metadata` as
    // a plain literal `{ title, description }` (no robots field today).
    // We want the test to fail LOUDLY if someone adds a noindex robots
    // field to that literal — regardless of whether they also type it.
    const r = (rootMetadata as unknown as { robots?: { index?: boolean } })
      .robots;
    if (r) {
      expect(r.index).not.toBe(false);
    }
    // If robots is undefined, the root layout's indexable default wins.
  });
});

describe('/get-quotes/checkout (NOINDEX — Stripe session URL)', () => {
  it('explicitly sets robots.index=false and robots.follow=false', () => {
    // The URL carries a quote_request_id, which is a short-lived
    // server-side token. If Google indexes this URL:
    //   - The session is likely expired by the time a crawler hits it
    //     (Stripe session invalidation), so the user sees a broken page.
    //   - Worse: the id ends up in a search-engine index, attackable as
    //     long as the request row exists.
    expect(checkoutMetadata.robots).toEqual({ index: false, follow: false });
  });

  it('still has a title (users see it in the tab bar)', () => {
    // Plain string is fine — it composes via the root template.
    expect(checkoutMetadata.title).toBeTruthy();
  });
});

describe('/get-quotes/success (NOINDEX — quote_request_id URL)', () => {
  it('explicitly sets robots.index=false and robots.follow=false', () => {
    // Same reasoning as checkout — this URL encodes a request id. Do
    // not let it into Google's index.
    expect(successMetadata.robots).toEqual({ index: false, follow: false });
  });

  it('still has a title (users see it in the tab bar)', () => {
    expect(successMetadata.title).toBeTruthy();
  });
});

// ─── Dynamic: /get-quotes/[category] ───────────────────────────────
//
// generateMetadata() hits Supabase to look up the category row. We
// mock the admin client so the test is self-contained and stable.

describe('/get-quotes/[category] generateMetadata', () => {
  // Isolate per-test state — vi.doMock() lets us swap the stub BEFORE
  // dynamically importing the page module. We import dynamically so
  // the mock is in place on first-load. resetModules() forces a fresh
  // import each test so the previous test's mock doesn't leak through
  // Vitest's module cache.
  beforeEach(() => {
    vi.resetModules();
  });
  it('returns a branded title with description for a known live vertical', async () => {
    // loadCategory chain is .from().select().eq('slug').eq('is_active').maybeSingle()
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: () => {
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.maybeSingle = () =>
            Promise.resolve({
              data: { name: 'Moving', slug: 'moving', description: null },
              error: null,
            });
          return chain;
        },
      }),
    }));

    const { generateMetadata } = await import('./[category]/page');
    const md = await generateMetadata({ params: { category: 'moving' } });
    expect(md.title).toBeTruthy();
    expect(String(md.title)).toMatch(/Moving/);
    // Live verticals get a description that pitches the quote flow.
    expect(md.description).toBeTruthy();
    expect(String(md.description)).toMatch(/numbers|quote|pros/i);

    vi.doUnmock('@/lib/supabase/admin');
  });

  it('returns a waitlist-phrased description for a deferred vertical', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: () => {
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.maybeSingle = () =>
            Promise.resolve({
              data: { name: 'Roofing', slug: 'roofing', description: null },
              error: null,
            });
          return chain;
        },
      }),
    }));

    const { generateMetadata } = await import('./[category]/page');
    const md = await generateMetadata({ params: { category: 'roofing' } });
    expect(md.title).toBeTruthy();
    expect(String(md.title)).toMatch(/Roofing/);
    // Deferred verticals surface the waitlist, not the quote flow.
    expect(String(md.description ?? '')).toMatch(/waitlist|live/i);

    vi.doUnmock('@/lib/supabase/admin');
  });

  it('falls back to a generic title when the category does not exist', async () => {
    // 404 at the page level — but generateMetadata runs first and needs
    // a sane fallback so the <title> tag isn't undefined during the
    // pre-render pass.
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: () => {
          const chain: Record<string, unknown> = {};
          chain.select = () => chain;
          chain.eq = () => chain;
          chain.maybeSingle = () =>
            Promise.resolve({ data: null, error: null });
          return chain;
        },
      }),
    }));

    const { generateMetadata } = await import('./[category]/page');
    const md = await generateMetadata({ params: { category: 'does-not-exist' } });
    expect(md.title).toBeTruthy();
    // The fallback is a generic 'Get quotes' title — must not leak the
    // unresolved slug into the tab bar or OG card.
    expect(String(md.title)).not.toMatch(/does-not-exist/);

    vi.doUnmock('@/lib/supabase/admin');
  });
});
