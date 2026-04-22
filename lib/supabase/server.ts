// Server-side Supabase client for Server Components, Route Handlers,
// and Server Actions. Reads the user's auth cookies so RLS applies
// under their identity.
//
// For operations that must bypass RLS (webhooks, admin tasks, background
// jobs), use lib/supabase/admin.ts instead.

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — cookies are read-only there.
            // The middleware refreshes the session separately, so this is fine.
          }
        },
      },
    }
  );
}
