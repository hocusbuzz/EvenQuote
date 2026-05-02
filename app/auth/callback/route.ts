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
  const tokenHash = searchParams.get('token_hash');
  // `type` is one of 'magiclink' | 'recovery' | 'invite' | 'email_change' |
  // 'signup' — Supabase's verifyOtp accepts the union as a string.
  const otpType = searchParams.get('type');
  const errorCode = searchParams.get('error');
  const errorDesc = searchParams.get('error_description');
  const next = safeNext(searchParams.get('next'));

  // Provider-side error (user denied, OAuth app misconfigured, etc.)
  if (errorCode) {
    const url = new URL('/auth-code-error', origin);
    if (errorDesc) url.searchParams.set('message', errorDesc);
    return NextResponse.redirect(url);
  }

  // Two callback shapes land here:
  //
  //   1. Magic-link / OTP (server-initiated, e.g. post-payment): URL has
  //      `?token_hash=…&type=magiclink`. Use verifyOtp — does NOT need a
  //      PKCE code_verifier (which can't exist for server-initiated OTPs
  //      because there was no preceding client-side auth call to stash
  //      one). This is the path the post-payment magic link uses now
  //      (post-payment.ts pins flowType:'implicit' on the OTP send).
  //
  //   2. OAuth / PKCE (client-initiated, e.g. Google sign-in): URL has
  //      `?code=…`. Use exchangeCodeForSession — needs the
  //      `code_verifier` cookie stashed by the SSR client when the user
  //      kicked off the flow.
  //
  // We dispatch on which params are present. Prior to the May 2026 fix
  // we only handled `code`, which broke every magic link with
  // "PKCE code verifier not found in storage."
  if (!code && !tokenHash) {
    // Third Supabase auth shape we have to tolerate: the IMPLICIT
    // flow puts tokens in the URL fragment (`#access_token=…&refresh_
    // token=…`). This is what `type=signup` confirmation links
    // default to, even when the magic-link flow uses token_hash.
    // The fragment is HTTP-spec-defined as user-agent-only and never
    // arrives at the server, so we MUST hand off to a client page
    // to read it. Browser preserves the fragment across this 302
    // redirect, so the tokens land at /auth/callback/finish intact.
    //
    // Pre-2026-05-01 (May): we returned "Missing authorization code"
    // here, breaking the very first sign-in for every signup flow
    // — exactly what a real customer hit before this fix.
    const finishUrl = new URL('/auth/callback/finish', origin);
    finishUrl.searchParams.set('next', next);
    return NextResponse.redirect(finishUrl);
  }

  const supabase = await createClient();

  // Wrap the verify/exchange so both the error-object path AND a
  // transport throw land on the same capture site. A future Supabase
  // SDK change that starts throwing instead of returning { error }
  // would otherwise fall through to the Next.js error boundary — no
  // Sentry tags, no structured signal, just a 500 on the landing page.
  let exchangeError: { message?: string } | null = null;
  try {
    if (tokenHash) {
      // Magic link / email OTP path. `type` may be missing on
      // older link formats — default to 'magiclink' (the only type
      // we generate today from post-payment.ts).
      const { error } = await supabase.auth.verifyOtp({
        type: (otpType as 'magiclink') || 'magiclink',
        token_hash: tokenHash,
      });
      exchangeError = error ?? null;
    } else if (code) {
      // OAuth / PKCE path.
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      exchangeError = error ?? null;
    }
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
