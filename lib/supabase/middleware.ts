// Supabase session middleware helper.
//
// Pattern is from the official Supabase + Next.js docs:
//   1. Every request goes through middleware.
//   2. Middleware reads cookies, creates a short-lived server client,
//      calls getUser() which auto-refreshes the access token if needed,
//      and writes any updated cookies back to the response.
//   3. Without this, sessions expire in ~1h and the user appears logged
//      out even though they technically still have a valid refresh token.
//
// Also handles route protection: unauthenticated users hitting /dashboard
// or /admin get bounced to /login with ?next=<original path>.

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Paths that require an authenticated user. Prefix match.
const PROTECTED_PATHS = ['/dashboard', '/admin'];

// Paths that should redirect TO /dashboard if the user is already signed in.
// (no point in showing /login to a logged-in user)
const AUTH_ONLY_PATHS = ['/login', '/signup'];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          // Write to the request so downstream server components see fresh cookies,
          // then rebuild the response so the browser also gets them.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: getUser() both validates the JWT with Supabase AND triggers
  // a refresh if the access token is near expiry. Using getSession() here
  // would NOT refresh. Do not "optimize" this away.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Route protection -------------------------------------------------
  const needsAuth = PROTECTED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (needsAuth && !user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  const isAuthOnly = AUTH_ONLY_PATHS.some((p) => pathname === p);
  if (isAuthOnly && user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/dashboard';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
