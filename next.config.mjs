/** @type {import('next').NextConfig} */

import { execSync } from 'node:child_process';

// ─── Build-time commit SHA ─────────────────────────────────────────
// Vercel deploys populate `VERCEL_GIT_COMMIT_SHA` at runtime, so the
// canonical /api/version + /api/health payloads carry a real SHA on
// production. Non-Vercel environments (self-hosted Docker, a staging
// box, a `next build && next start` on a laptop for a customer demo)
// have no such var — falling through to the `'dev'` sentinel made
// support triage harder, because a support screenshot from one of
// those environments carried no commit identity at all.
//
// This block runs once at build time, shells out to `git rev-parse
// --short HEAD`, and exposes the result as `NEXT_PUBLIC_BUILD_SHA`.
// lib/observability/version.ts consumes it as the middle tier of a
// 3-tier preference: Vercel runtime var → build-time injection →
// 'dev'.
//
// Why `NEXT_PUBLIC_`: Next's build pipeline inlines `NEXT_PUBLIC_*`
// vars into server AND client bundles at build time, which is exactly
// the capture semantics we want — the SHA is frozen at build and
// never changes for that deployment.
//
// Graceful failure: if `git` isn't available (e.g. Docker build from
// a tarball with no .git directory), the catch leaves the var
// unset — the version helper will then fall through to 'dev' as
// today. No CI breakage.
function detectBuildSha() {
  // Respect an explicit override — CI pipelines that pass a SHA via
  // env (e.g. buildx with --build-arg SOURCE_COMMIT) shouldn't have
  // it overwritten by a local `git` call against whatever ref the
  // build checkout happens to be on.
  if (process.env.NEXT_PUBLIC_BUILD_SHA) return process.env.NEXT_PUBLIC_BUILD_SHA;
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}
const buildSha = detectBuildSha();

// ─── Security headers ──────────────────────────────────────────────
// Applied to every response via headers(). Balanced to keep our
// runtime deps (Stripe Checkout redirect, Supabase auth, Resend tracking
// pixels in outbound email — not this app) working.
//
// Notes on choices:
//   • frame-ancestors 'none' — we don't embed EvenQuote in iframes; this
//     blocks clickjacking. Combined with X-Frame-Options for legacy
//     browsers.
//   • Referrer-Policy strict-origin-when-cross-origin — prevents leaking
//     full guest-URL paths (which contain UUIDs) via Referer headers to
//     third-party links (Stripe checkout, Resend links in email bodies
//     still work because they honor redirect flow, not referrer).
//   • Permissions-Policy — lock down sensors/cameras we don't use.
//   • HSTS — only has effect on HTTPS, harmless on http dev; 1 year +
//     includeSubDomains is standard.
//   • CSP intentionally omitted for now — Next.js 14 App Router inlines
//     hashed scripts that need nonces, and configuring a nonce-based CSP
//     via middleware is a larger change. Tracked as a follow-up.

// Minimal static CSP. Scope: frame-ancestors only.
//
// Why this limited form is worth shipping today:
//   • `frame-ancestors 'none'` is the CSP-native version of X-Frame-Options
//     DENY. Modern browsers honour this over XFO and it works cross-domain
//     where XFO behaves inconsistently. Both are present for defence in
//     depth and legacy-browser support.
//   • `form-action 'self' https://checkout.stripe.com` blocks an XSS
//     payload from redirecting form POSTs to an attacker-controlled
//     origin — a cheap, no-deploy-risk win.
//   • `base-uri 'self'` blocks <base> tag injection from changing the
//     resolution of relative URLs on the page.
//
// What's intentionally NOT here:
//   • script-src / style-src — Next's App Router inlines scripts and
//     styles that need nonces to pass CSP. Adding those without nonce
//     middleware plumbing would either break the site (no 'unsafe-inline')
//     or give no real protection (with 'unsafe-inline'). See
//     docs/CSP_PLAN.md for the proper nonce-middleware rollout plan.
//
// Safe to enable today — no page scripts or stylesheets are affected.
//
// IMPORTANT: do NOT add `default-src 'self'` here until nonce plumbing
// lands (docs/CSP_PLAN.md). `default-src` acts as the fallback for
// `script-src`, and Next.js 14 App Router inlines bootstrap scripts
// for React hydration that would be blocked by a 'self'-only script
// policy. Keep these directives narrow — they each target a specific
// attack class (clickjacking, form-action hijack, base-uri poisoning,
// object embeds) without breaking hydration.
const minimalCsp = [
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.stripe.com"), interest-cohort=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains; preload',
  },
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
  {
    // NOTE: no `script-src` / `style-src` here — see comment above
    // `minimalCsp`. This directive is intentionally narrow and safe.
    key: 'Content-Security-Policy',
    value: minimalCsp,
  },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false, // don't advertise Next.js version
  // Exposes the build-time-detected SHA to both server and client
  // bundles. Consumed by lib/observability/version.ts. Empty string
  // falls through to the 'dev' sentinel in the helper — see that
  // module's doc comment for the preference order.
  env: {
    NEXT_PUBLIC_BUILD_SHA: buildSha,
  },
  experimental: {
    // Server Actions are enabled by default in Next 14+, but pinning
    // body size for the quote-request form payloads (which can carry
    // sizeable intake JSON) doesn't hurt.
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
