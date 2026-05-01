// Content Security Policy — nonce-based policy builder.
//
// Used by middleware.ts to set a per-request CSP. We're rolling out in
// Report-Only mode first per docs/CSP_PLAN.md; the policy itself is
// the same whether enforcing or report-only — only the header name
// differs.
//
// Why a separate module:
//   • Pure function = easy unit testing (vs. middleware which is hard
//     to instantiate without Next's runtime).
//   • The middleware file should stay focused on routing decisions;
//     CSP construction is its own concern.
//   • Keeps the connect-src / frame-src allowlist in one place so when
//     we add (e.g.) a Sentry endpoint, there's exactly one file to
//     touch.

/**
 * Builds the CSP header value for a given nonce.
 *
 * Highlights:
 *   • script-src 'self' 'nonce-…' 'strict-dynamic' — only nonced
 *     scripts execute. 'strict-dynamic' lets a nonced script load
 *     dependencies without listing every CDN. Modern browsers honour
 *     this; older browsers fall back to the `'self'` allowlist.
 *   • style-src 'self' 'unsafe-inline' — Tailwind / next/font emit
 *     inline <style> tags that we cannot nonce without invasive
 *     plumbing. 'unsafe-inline' is acceptable for CSS because
 *     style injection is a much weaker attack vector than script
 *     injection (no JS execution).
 *   • connect-src includes Supabase + Stripe + (when present)
 *     NEXT_PUBLIC_SUPABASE_URL's origin so the auth client can talk
 *     to the project. Stripe Checkout uses its own origin.
 *   • frame-src 'self' Stripe — we redirect to Stripe Checkout, not
 *     iframe it; this is defence in depth in case we ever do.
 *   • frame-ancestors 'none' — clickjacking guard. Combined with
 *     X-Frame-Options for legacy browsers (set in next.config.mjs).
 *   • report-uri (when reportEndpoint provided) — violations get
 *     POSTed to that path so we can audit without breaking the site.
 */
export function buildCsp(opts: {
  nonce: string;
  reportEndpoint?: string;
}): string {
  const { nonce, reportEndpoint } = opts;

  const supabaseOrigin = (() => {
    const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!raw) return 'https://*.supabase.co';
    try {
      return new URL(raw).origin;
    } catch {
      return 'https://*.supabase.co';
    }
  })();

  // GA4 hosts. The script-src additions are belt-and-suspenders —
  // 'strict-dynamic' should already let the nonced GA4 loader pull
  // gtag.js, but older browsers without strict-dynamic support fall
  // back to the explicit allowlist.
  //
  // connect-src additions cover the runtime beacons:
  //   • google-analytics.com         — classic /collect endpoint
  //   • analytics.google.com         — newer /g/collect endpoint
  //   • *.analytics.google.com       — region-specific shards
  //   • googletagmanager.com         — config + remote-config requests
  //
  // Only added when GA4 is configured so non-prod environments don't
  // advertise an analytics surface they don't actually use.
  const ga4ScriptHosts = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID
    ? ' https://*.googletagmanager.com'
    : '';
  const ga4ConnectHosts = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID
    ? ' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com'
    : '';

  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${ga4ScriptHosts}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${supabaseOrigin} https://*.supabase.co https://api.stripe.com${ga4ConnectHosts}`,
    `frame-src 'self' https://checkout.stripe.com https://js.stripe.com`,
    `frame-ancestors 'none'`,
    `form-action 'self' https://checkout.stripe.com`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ];

  if (reportEndpoint) {
    directives.push(`report-uri ${reportEndpoint}`);
  }

  return directives.join('; ');
}

/**
 * Generate a fresh nonce. Must be unique per request — the whole point
 * of CSP nonces is that an attacker who can inject a <script> tag
 * cannot guess the right nonce attribute.
 *
 * Uses Web Crypto (available in Edge runtime) — Node's `crypto.randomBytes`
 * is not available in middleware runtime.
 */
export function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  // base64 of 16 bytes = 24 chars; CSP nonces just need to be opaque
  // and high-entropy. Browsers accept any non-empty token.
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  // btoa is available in both Edge and Node 16+.
  return btoa(bin);
}

/**
 * Whether nonce-based CSP plumbing should be active for this request.
 * Default OFF so this is a deliberate opt-in — flip CSP_NONCE_ENABLED=true
 * to begin the Report-Only window per docs/CSP_PLAN.md.
 */
export function isCspNonceEnabled(): boolean {
  return (process.env.CSP_NONCE_ENABLED ?? '').toLowerCase() === 'true';
}

/**
 * Whether the CSP should be enforcing (sets Content-Security-Policy)
 * or report-only (sets Content-Security-Policy-Report-Only). Default
 * is report-only — flip CSP_ENFORCE=true after the 7-day clean window.
 */
export function cspHeaderName(): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return (process.env.CSP_ENFORCE ?? '').toLowerCase() === 'true'
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
}
