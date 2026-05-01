// Meta Pixel script injection — drops the `fbevents.js` snippet into
// the root layout. Sibling of GA4Script.
//
// Renders nothing when NEXT_PUBLIC_META_PIXEL_ID is missing, so non-
// prod environments don't pollute the production Pixel data and the
// page payload stays lean.
//
// Strategy = "afterInteractive": same rationale as GA4 — does NOT
// block LCP, fires the auto PageView a few hundred ms after hydration.
//
// Nonce: same per-request CSP nonce as the JSON-LD + GA4 scripts in
// app/layout.tsx. CSP must additionally allow connect.facebook.net
// (script load) + facebook.com (event beacons + noscript fallback img).
//
// The inline init body is the standard Meta Pixel snippet, lightly
// edited:
//   • Removed the `fbq('track', 'PageView')` call — kept inside the
//     init block so the auto-PageView still fires on first load.
//   • Removed the <noscript> <img> fallback — adds another asset
//     request and JS-disabled visitors are not the audience our paid
//     ads are targeting. If a CSV-export campaign needs it later we
//     can opt in.

import Script from 'next/script';

export function MetaPixelScript({ nonce }: { nonce?: string }) {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!pixelId) return null;

  return (
    <Script
      id="meta-pixel"
      strategy="afterInteractive"
      nonce={nonce}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{
        __html: `
          !function(f,b,e,v,n,t,s)
          {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
          n.callMethod.apply(n,arguments):n.queue.push(arguments)};
          if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
          n.queue=[];t=b.createElement(e);t.async=!0;
          t.src=v;s=b.getElementsByTagName(e)[0];
          s.parentNode.insertBefore(t,s)}(window, document,'script',
          'https://connect.facebook.net/en_US/fbevents.js');
          fbq('init', '${pixelId}');
          fbq('track', 'PageView');
        `,
      }}
    />
  );
}
