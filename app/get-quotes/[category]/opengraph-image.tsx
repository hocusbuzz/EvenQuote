// Per-vertical Open Graph card.
//
// Next 14 file-based convention: a route segment that exports
// `opengraph-image.tsx` gets auto-discovered as the OG image for
// that segment. Renders at request time via `next/og`'s
// ImageResponse (satori under the hood) and is cached aggressively
// at the Vercel edge, so the per-vertical look ships on every
// Reddit / Twitter / ProductHunt / iMessage share without per-share
// runtime cost after the first crawler fetch.
//
// Why this matters: every paid-traffic share, every Reddit comment
// linking to /get-quotes/<vertical>, every PH launch post — all of
// them get a strong vertical-specific preview ('Handyman quotes —
// $9.99 flat') instead of the generic homepage card. The CTR delta
// on category-specific OG vs generic is large enough to justify
// 80 lines of layout code.
//
// Design notes
// ────────────
// • Fixed canvas: 1200×630, the OpenGraph standard. Twitter, Meta,
//   LinkedIn, iMessage, Slack — all consume the same dimensions.
// • Cream background + ink text + lime accent ribbon = same brand
//   palette as the site so a share looks like an extension of the
//   landing page, not a different product.
// • System fonts only (no custom font fetch). ImageResponse supports
//   loading WOFF over HTTP but every font fetch is bandwidth on the
//   build edge AND a potential point of failure. Satori falls back
//   to a default sans that renders crisp at this scale.
// • 'edge' runtime — ImageResponse is implemented in WASM (satori +
//   resvg) and the Edge runtime is the supported home for it. Node
//   runtime works too in Next 14 but Edge is the docs-recommended
//   path and warms faster.

import { ImageResponse } from 'next/og';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'edge';
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };
export const alt = 'EvenQuote — quotes from local pros, $9.99 flat';

// Brand palette — kept as literal hex (not Tailwind classes) because
// satori reads computed-style strings, not the Tailwind class system.
// Mirror tailwind.config.ts so a brand-color change propagates here
// (low-frequency change; editing both is fine).
const COLORS = {
  cream: '#F5F1E8',
  ink: '#0A0A0A',
  inkSoft: '#525252',
  lime: '#C7F227',
  limeDeep: '#A6CC1F',
} as const;

// Fallback used when the slug doesn't match any active service_categories
// row (deleted vertical, typo URL, etc.). Still a usable share card so
// a stale link doesn't render as 'Service quotes'.
const FALLBACK_NAME = 'Quotes';

async function loadCategoryName(slug: string): Promise<string> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from('service_categories')
      .select('name')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();
    return data?.name ?? FALLBACK_NAME;
  } catch {
    // If the DB is unreachable at edge-render time, ship a brand-
    // neutral card rather than crashing the share preview. Same
    // graceful-degradation rationale as app/sitemap.ts.
    return FALLBACK_NAME;
  }
}

export default async function OgImage({
  params,
}: {
  params: { category: string };
}) {
  const name = await loadCategoryName(params.category);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: COLORS.cream,
          padding: '72px 80px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: COLORS.ink,
          position: 'relative',
        }}
      >
        {/* Lime accent ribbon — purely decorative, anchors the bottom
            of the card so the EvenQuote mark feels seated. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width: '100%',
            height: '16px',
            backgroundColor: COLORS.lime,
          }}
        />

        {/* Eyebrow — "EVENQUOTE / vertical-slug" in mono, label-style.
            Mirrors the .label-eyebrow class used across the site. */}
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            letterSpacing: '0.25em',
            color: COLORS.inkSoft,
            textTransform: 'uppercase',
            fontWeight: 600,
          }}
        >
          EvenQuote
        </div>

        {/* Headline — vertical name + 'quotes', wrapped tight. The
            96px scale fills the card without overflow at the longest
            real category name we have today ('Junk removal' = 12 chars). */}
        <div
          style={{
            display: 'flex',
            marginTop: 'auto',
            fontSize: 132,
            fontWeight: 800,
            lineHeight: 1.05,
            letterSpacing: '-0.02em',
          }}
        >
          {name} quotes.
        </div>

        {/* Subhead — the price + speed claim, the actual reason to click. */}
        <div
          style={{
            display: 'flex',
            marginTop: 28,
            fontSize: 36,
            color: COLORS.inkSoft,
            fontWeight: 500,
          }}
        >
          $9.99 flat — local pros called for you, report in your inbox.
        </div>

        {/* Domain mark in the bottom-right, above the lime ribbon.
            Acts as a subtle 'this is the source URL' cue when shared
            without a title. */}
        <div
          style={{
            position: 'absolute',
            right: 80,
            bottom: 36,
            display: 'flex',
            fontSize: 20,
            color: COLORS.ink,
            letterSpacing: '0.05em',
            fontWeight: 600,
          }}
        >
          evenquote.com
        </div>
      </div>
    ),
    { ...size },
  );
}
