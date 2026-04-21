// Root middleware. Replaces the Phase 1 stub.
// All the logic lives in lib/supabase/middleware.ts so it's testable.

import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
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
