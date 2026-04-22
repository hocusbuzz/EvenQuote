// Service-role Supabase client. BYPASSES ROW LEVEL SECURITY.
//
// Use ONLY in:
//   • Webhook handlers (Stripe, Vapi) — no user session available
//   • Background jobs / cron tasks
//   • Admin operations that need cross-user access
//   • Seed / migration scripts
//
// NEVER import this from a client component. The service role key
// must never reach the browser. Server-only guard below will throw
// if anyone accidentally bundles this for the client.

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

if (typeof window !== 'undefined') {
  throw new Error('lib/supabase/admin.ts must not be imported on the client');
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  return createSupabaseClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
