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
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('auth/callback');

// ── Canonical Sentry tag shape for this route ──
// R30 audit: paired with get-quotes/claim (R29). If this fails silently
// the magic-link breaks BEFORE the claim route can run, stranding a
// paying customer at /auth-code-error with no ops signal.
//
// Only ONE path genuinely warrants capture: exchangeCodeForSession
// returning an error object. That indicates either Supabase auth
// downtime, a real provider misconfig, or a tampered code. Deliberately
// NOT captured:
//   - Provider-side ?error=... — user denied OAuth or OAuth app
//     misconfig; user-facing, not an ops incident.
//   - Missing ?code= — bot crawlers / expired links / share-link
//     misuse; flooding risk.
//   - Exception from createClient()/exchangeCodeForSession itself
//     (transport throw) — covered separately below so the single
//     "auth exchange failed" alert captures both error-object and
//     throw shapes.
export type AuthCallbackReason = 'exchangeCodeForSessionFailed';

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

  // Wrap the exchange so both the error-object path AND a transport
  // throw land on the same capture site. A future Supabase SDK change
  // that starts throwing instead of returning { error } would otherwise
  // fall through to the Next.js error boundary — no Sentry tags, no
  // structured signal, just a 500 on the magic-link landing page.
  let exchangeError: { message?: string } | null = null;
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    exchangeError = error ?? null;
  } catch (thrown) {
    exchangeError = thrown instanceof Error ? { message: thrown.message } : { message: String(thrown) };
  }

  if (exchangeError) {
    log.error('exchangeCodeForSession failed', { err: exchangeError });
    // Controlled prefix stabilizes Sentry fingerprint across provider
    // message rewording. PII contract: no email, no code, no IP —
    // only route + reason identifiers in tags.
    const wrapped = new Error(
      `exchangeCodeForSession failed: ${exchangeError.message ?? 'unknown'}`
    );
    captureException(wrapped, {
      tags: {
        route: 'auth/callback',
        reason: 'exchangeCodeForSessionFailed' satisfies AuthCallbackReason,
      },
    });
    const url = new URL('/auth-code-error', origin);
    url.searchParams.set('message', exchangeError.message || 'Sign-in failed');
    return NextResponse.redirect(url);
  }

  // At this point the sb-* cookies are set on the response and the user
  // is authenticated. Middleware will pick it up on the next request.
  return NextResponse.redirect(new URL(next, origin));
}
