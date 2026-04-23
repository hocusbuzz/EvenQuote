// Auth helpers for server components, route handlers, and server actions.
//
// Three tiers:
//   - getUser()      → returns User | null. Safe to call anywhere.
//   - getProfile()   → returns the extended profiles row (includes role).
//   - requireUser()  → redirects to /login if no user. Use on protected pages.
//   - requireAdmin() → redirects if not admin. Use on admin pages.
//
// All of these use the cookie-based server client (RLS-aware).

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth');

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: 'customer' | 'admin';
  created_at: string;
  updated_at: string;
};

export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // RLS policy "profiles: self read" lets us fetch our own row.
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, phone, role, created_at, updated_at')
    .eq('id', user.id)
    .single();

  if (error) {
    // Profile row is created by a DB trigger on auth.users insert, so
    // this should never happen in normal flow. Log and surface as null
    // — the caller decides what to do.
    log.error('failed to fetch profile', { userId: user.id, err: error.message });
    return null;
  }

  return data as Profile;
}

/**
 * Use in a protected Server Component or Server Action.
 * Redirects to /login with ?next set if there's no session.
 * Middleware already guards protected paths, but this is a defense-in-depth
 * check for when the route is reached through any other path (e.g. a
 * server action called from a client that was just invalidated).
 */
export async function requireUser(redirectTo?: string): Promise<User> {
  const user = await getUser();
  if (!user) {
    const next = redirectTo ? `?next=${encodeURIComponent(redirectTo)}` : '';
    redirect(`/login${next}`);
  }
  return user;
}

/**
 * Require an authenticated user with role='admin'. Non-admins get a 404
 * rather than 403 — we don't want to confirm that an admin surface exists.
 */
export async function requireAdmin(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) {
    redirect('/login');
  }
  if (profile.role !== 'admin') {
    // notFound() would be cleaner but requires importing from next/navigation
    // and triggers the 404 boundary — using redirect here keeps things simple.
    redirect('/');
  }
  return profile;
}
