// Auth callback route.
//
// Supabase sends users here after:
//   • Clicking a magic-link email (flow=pkce, ?code=...)
//   • Completing an OAuth provider flow (Google) with ?code=...
//
// We exchange the auth code for a session (which sets the sb-* cookies
// via the response), then redirect the user to their intended destination.
//
// If the exchange fails — expired link, tampered code, provider error —
// we send them to /auth-code-error with a readable message.

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/dashboard';
  }
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const errorCode = searchParams.get('error');
  const errorDesc = searchParams.get('error_description');
  const next = safeNext(searchParams.get('next'));

  // Provider-side error (user denied, OAuth app misconfigured, etc.)
  if (errorCode) {
    const url = new URL('/auth-code-error', origin);
    if (errorDesc) url.searchParams.set('message', errorDesc);
    return NextResponse.redirect(url);
  }

  if (!code) {
    const url = new URL('/auth-code-error', origin);
    url.searchParams.set('message', 'Missing authorization code');
    return NextResponse.redirect(url);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth/callback] exchangeCodeForSession failed', error);
    const url = new URL('/auth-code-error', origin);
    url.searchParams.set('message', error.message || 'Sign-in failed');
    return NextResponse.redirect(url);
  }

  // At this point the sb-* cookies are set on the response and the user
  // is authenticated. Middleware will pick it up on the next request.
  return NextResponse.redirect(new URL(next, origin));
}
