'use client';

// /auth/callback/finish — client-side fallback for the URL-fragment
// auth flow.
//
// WHY THIS PAGE EXISTS
// ────────────────────
// /auth/callback/route.ts (server) handles two cases:
//   • ?code=…       (OAuth / PKCE)            → exchangeCodeForSession
//   • ?token_hash=… (server-side OTP via PKCE) → verifyOtp
//
// Supabase has a THIRD case it falls back to for some flows
// (notably first-time signup confirmation): the IMPLICIT flow, where
// the verify endpoint redirects to redirect_to with tokens in the
// URL FRAGMENT — `#access_token=…&refresh_token=…&type=signup`.
//
// Server-side route handlers cannot read the URL fragment (it is
// client-side only by HTTP spec). On 2026-05-01, a real customer
// hit this exact path: paid → got the magic-link email → clicked →
// landed at `/auth/callback#access_token=…` → server saw no code
// AND no token_hash → "Sign-in failed: Missing authorization code".
//
// This client page is the fallback. /auth/callback/route.ts now
// redirects here when neither query-param shape is present. The
// browser preserves the URL fragment across the 302 redirect (per
// HTTP spec — fragments are user-agent-only) so the tokens land
// here intact, and the createBrowserClient from @supabase/ssr
// automatically parses them and persists the session into cookies.
//
// On success → continue to ?next=… (defaults to /dashboard).
// On failure → bounce to /auth-code-error with a readable message.

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return '/dashboard';
  }
  return raw;
}

export default function AuthCallbackFinishPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [message, setMessage] = useState('Signing you in…');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!url || !anon) {
        router.replace(
          '/auth-code-error?message=' +
            encodeURIComponent('Auth client not configured'),
        );
        return;
      }

      // The browser client auto-parses the URL fragment on
      // construction (Supabase auth-js does this for you when it
      // sees `detectSessionInUrl: true`, which is the default for
      // createBrowserClient). After a brief tick we can check
      // getSession() to confirm the session was set.
      const supabase = createBrowserClient(url, anon);

      // Give Supabase a moment to detect + persist the session from
      // the fragment. Then check.
      const { data, error } = await supabase.auth.getSession();
      if (cancelled) return;

      const next = safeNext(searchParams?.get('next') ?? null);

      if (error || !data.session) {
        const msg = error?.message ?? 'Could not establish a session';
        router.replace('/auth-code-error?message=' + encodeURIComponent(msg));
        return;
      }

      // Session established → cookies set on this origin → middleware
      // will see the user on the next request. Strip the fragment by
      // navigating to the next URL (router.replace overwrites the
      // history entry so the back button doesn't return to a
      // single-use fragment URL).
      setMessage('Signed in. Redirecting…');
      router.replace(next);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  return (
    <main
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '24px',
      }}
    >
      <div>
        <p style={{ fontSize: 16, color: '#374151' }}>{message}</p>
      </div>
    </main>
  );
}
