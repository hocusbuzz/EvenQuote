// Root middleware. Replaces the Phase 1 stub.
// All the logic lives in lib/supabase/middleware.ts so it's testable.
//
// ── Observability contract (R34 audit) ────────────────────────────
// This file deliberately does NOT wire captureException/captureMessage
// on any path. Reasoning, in priority order:
//   1. Request-frequency flood. Middleware runs on EVERY matched
//      request (the matcher excludes only static/image/file-extension
//      paths — every API route, every page render, every asset refresh
//      traverses this code). A capture call here is multiplied by the
//      entire traffic firehose; a misbehaving edge-runtime shim would
//      blow the Sentry quota in seconds. Uptime dashboards + Vercel's
//      platform-level error capture already surface middleware crashes
//      without per-request amplification.
//   2. Platform-level instrumentation owns middleware errors. Next's
//      `instrumentation.ts` boot hook + `@sentry/nextjs`'s middleware
//      wrapper (once DSN unlocks) already install a top-level capture
//      around the exported `middleware` function. Adding our own
//      captureException inside the handler would double-capture the
//      same throw with a different stack trace — R26 no-double-capture
//      rule.
//   3. Session refresh errors are steady-state, not incidents.
//      `updateSession()` hitting a transient Supabase cookie-refresh
//      error recovers on the next request; capturing at every stale-
//      token edge flood would drown out real anomalies.
//   4. CSP nonce generation is pure (`crypto.randomUUID()`) and cannot
//      throw at the application layer. The maintenance-mode gate is
//      pure URL manipulation and also cannot throw.
//   5. Cookie-decode errors are noisy and user-caused (stale browser
//      cookies, clock skew, third-party devtools). Not actionable at
//      the capture site — they're a UX signal, not an incident signal.
//
// Regression guards in tests/middleware.test.ts lock this no-capture
// contract — if a future maintainer wires captureException here, the
// "observability contract — no capture" block fails. If you need to
// break the rule (e.g. a genuinely rare, bounded-frequency middleware
// path worth paging on), update the test AND leave a justification
// comment on the new capture site.

import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import {
  buildCsp,
  cspHeaderName,
  generateNonce,
  isCspNonceEnabled,
} from '@/lib/security/csp';

// Paths that MUST keep working even when the site is gated.
// Webhooks + cron jobs must continue — otherwise Stripe retries pile up
// and scheduled calls stall. The maintenance page itself obviously needs
// to render. Everything under /_next is Next.js internals.
const MAINTENANCE_ALLOWLIST = [
  '/maintenance',
  '/api/stripe/webhook',
  '/api/vapi/webhook',
  '/api/cron/',
  '/api/csp-report',
  '/_next/',
  '/favicon.ico',
  '/robots.txt',
];

// Optional bypass so the operator can still browse the live site while it's
// gated. Append `?preview=<token>` matching MAINTENANCE_PREVIEW_TOKEN and we
// drop a short-lived cookie so you don't have to keep re-pasting it.
const PREVIEW_COOKIE = 'eq_maint_bypass';

function isMaintenanceMode(): boolean {
  return (process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true';
}

function isAllowlisted(pathname: string): boolean {
  return MAINTENANCE_ALLOWLIST.some((p) =>
    p.endsWith('/') ? pathname.startsWith(p) : pathname === p
  );
}

export async function middleware(request: NextRequest) {
  if (isMaintenanceMode()) {
    const { pathname, searchParams } = request.nextUrl;

    // Preview token handoff: `?preview=<token>` sets the bypass cookie
    // and strips the query so share links look clean.
    const previewToken = process.env.MAINTENANCE_PREVIEW_TOKEN;
    if (previewToken && searchParams.get('preview') === previewToken) {
      const cleanUrl = request.nextUrl.clone();
      cleanUrl.searchParams.delete('preview');
      const res = NextResponse.redirect(cleanUrl);
      res.cookies.set(PREVIEW_COOKIE, previewToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        maxAge: 60 * 60 * 8, // 8h
        path: '/',
      });
      return res;
    }

    const hasBypassCookie =
      previewToken !== undefined &&
      request.cookies.get(PREVIEW_COOKIE)?.value === previewToken;

    if (!hasBypassCookie && !isAllowlisted(pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = '/maintenance';
      url.search = '';
      // Rewrite (not redirect) so the URL bar stays on whatever the user
      // clicked — less confusing, and crawlers will see a 200 on / instead
      // of a 302 chain.
      return NextResponse.rewrite(url);
    }
  }

  // Run the Supabase session refresh first so we get the response we'd
  // normally return. Then layer CSP nonce headers on top if enabled.
  const sessionResponse = await updateSession(request);

  if (isCspNonceEnabled()) {
    const nonce = generateNonce();
    const csp = buildCsp({
      nonce,
      reportEndpoint: '/api/csp-report',
    });

    // Forward the nonce to the rendering layer via a request header.
    // app/layout.tsx reads `headers().get('x-nonce')` so server
    // components can pass it to <Script nonce={…}> components.
    //
    // We attach the header to BOTH the inbound request (so server
    // components see it during render) AND the outbound response (so
    // the browser receives the CSP). The inbound trick is documented
    // in Next's official CSP guide.
    sessionResponse.headers.set('x-nonce', nonce);
    sessionResponse.headers.set(cspHeaderName(), csp);
  }

  return sessionResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static (static files)
     * - _next/image  (image optimization)
     * - favicon.ico, robots.txt, sitemap.xml
     * - any file extension (png, svg, etc.)
     *
     * We specifically DO want middleware to run on /api routes so that
     * auth cookies refresh there too — webhook routes opt out by not
     * relying on user sessions.
     */
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
