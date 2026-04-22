// Root middleware. Replaces the Phase 1 stub.
// All the logic lives in lib/supabase/middleware.ts so it's testable.

import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

// Paths that MUST keep working even when the site is gated.
// Webhooks + cron jobs must continue — otherwise Stripe retries pile up
// and scheduled calls stall. The maintenance page itself obviously needs
// to render. Everything under /_next is Next.js internals.
const MAINTENANCE_ALLOWLIST = [
  '/maintenance',
  '/api/stripe/webhook',
  '/api/vapi/webhook',
  '/api/cron/',
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

  return await updateSession(request);
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
