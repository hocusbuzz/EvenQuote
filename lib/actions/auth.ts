'use server';

// Auth server actions.
//
// The client pages (login/signup forms) call these via React's <form action>
// pattern. Returning a plain object with { error } keeps things framework-
// agnostic — easy to wire up to useFormState if we add that later.
//
// Security notes:
//   - All user input is validated with Zod. Never trust raw FormData.
//   - We don't reveal whether an email is registered: magic link behavior
//     is the same for existing vs new users (Supabase default).
//   - Google OAuth is gated by NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED so the
//     button doesn't appear in environments where Supabase isn't configured.

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { headers } from 'next/headers';

const EmailSchema = z.object({
  email: z.string().email('Please enter a valid email').toLowerCase().trim(),
  next: z.string().optional(),
});

/**
 * Build a safe absolute redirect URL for auth callbacks.
 *
 * In production we prefer NEXT_PUBLIC_APP_URL so Supabase's email links
 * always match the configured domain (Supabase rejects mismatches).
 *
 * In dev/preview we fall back to request headers so localhost and Vercel
 * preview deployments work without hardcoding.
 */
function getSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  }
  const h = headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

/**
 * Sanitize a 'next' redirect target to prevent open-redirect attacks.
 * Only same-origin relative paths are allowed.
 */
function safeNext(next?: string | null): string {
  if (!next) return '/dashboard';
  // Reject anything with a scheme, protocol-relative URLs, or backslashes.
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/dashboard';
  }
  return next;
}

// ─── Magic link ───────────────────────────────────────────────────

export type ActionResult = { error: string } | { ok: true };

export async function signInWithMagicLink(formData: FormData): Promise<ActionResult> {
  const parsed = EmailSchema.safeParse({
    email: formData.get('email'),
    next: formData.get('next'),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid email' };
  }

  const { email, next } = parsed.data;
  const supabase = await createClient();
  const siteUrl = getSiteUrl();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Where Supabase will redirect after the user clicks the link.
      // Our callback route then exchanges the code and sends them to `next`.
      emailRedirectTo: `${siteUrl}/auth/callback?next=${encodeURIComponent(safeNext(next))}`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    // Rate limits and SMTP failures surface here. Keep the message generic
    // so we don't leak internal state.
    console.error('[signInWithMagicLink]', error);
    return { error: 'Could not send magic link. Please try again.' };
  }

  return { ok: true };
}

// ─── Google OAuth ─────────────────────────────────────────────────

export async function signInWithGoogle(formData: FormData): Promise<ActionResult> {
  if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== 'true') {
    return { error: 'Google sign-in is not enabled.' };
  }

  const next = safeNext(formData.get('next') as string | null);
  const supabase = await createClient();
  const siteUrl = getSiteUrl();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${siteUrl}/auth/callback?next=${encodeURIComponent(next)}`,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
      },
    },
  });

  if (error || !data.url) {
    console.error('[signInWithGoogle]', error);
    return { error: 'Could not start Google sign-in.' };
  }

  // signInWithOAuth returns a URL we must redirect the browser to.
  // redirect() throws a NEXT_REDIRECT error by design; it doesn't return.
  redirect(data.url);
}

// ─── Sign out ─────────────────────────────────────────────────────

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/');
}
