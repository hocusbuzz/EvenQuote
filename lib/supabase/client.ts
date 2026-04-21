// Browser (client component) Supabase client.
// Uses the anon key — all access is governed by RLS policies.
// Do NOT use this in server code; use lib/supabase/server.ts instead.

import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
