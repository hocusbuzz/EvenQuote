// GA4 script injection — drops the `gtag.js` snippet into the root layout.
//
// Renders nothing when NEXT_PUBLIC_GA4_MEASUREMENT_ID is missing, so
// staging deploys / local dev / preview branches without the env var
// don't pollute the production GA4 stream and the page payload stays
// lean.
//
// Strategy = "afterInteractive": the script loads AFTER the page is
// hydrated. We deliberately do NOT use "beforeInteractive" — it
// blocks the Largest Contentful Paint, which is exactly the metric
// the Day-8 paid-traffic landing pages need to optimize. The trade-
// off is that the very first pageview event fires ~50-200ms later
// than it could; for funnel measurement at our scale, irrelevant.
//
// Nonce: the project's CSP middleware sets `x-nonce` per request when
// CSP_NONCE_ENABLED=true. The root layout reads it and threads it
// through to every inline <script>. We accept it as a prop so this
// component stays a server component (no useEffect needed) and the
// nonce attribute renders into the static HTML.

import Script from 'next/script';

export function GA4Script({ nonce }: { nonce?: string }) {
  const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  if (!measurementId) return null;

  return (
    <>
      {/* Loader — pulls gtag.js from Google's CDN. CSP must allow
          *.googletagmanager.com for this to load (see middleware.ts). */}
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
        nonce={nonce}
      />
      {/* Inline init — defines window.dataLayer + window.gtag, then
          calls gtag('config', ...) to register the property. The
          dangerouslySetInnerHTML is a constant string built from the
          measurement ID env var (validated by the lib/env.ts schema:
          must match /^G-[A-Z0-9]+$/). No user input, no injection
          surface.

          send_page_view stays at default true so SPA navigations get
          counted automatically via Next's App Router instrumentation.

          anonymize_ip is GA4's default but stating it explicitly
          documents the privacy stance — IPs are truncated before
          being stored. */}
      <Script
        id="ga4-init"
        strategy="afterInteractive"
        nonce={nonce}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${measurementId}', { anonymize_ip: true });
          `,
        }}
      />
    </>
  );
}
