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
//
// R47.4: this module is also where we enforce server env validation
// at cold-start. Every server-side route that does anything mutating
// imports createAdminClient(). Calling validateServerEnv() at module
// load means a misconfigured prod deploy fails LOUDLY on the first
// request instead of silently degrading into simulation mode for
// Vapi / Resend / etc. The validation is cached so we pay the parse
// cost once per cold-start, not per request.

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { validateServerEnv } from '@/lib/env';

if (typeof window !== 'undefined') {
  throw new Error('lib/supabase/admin.ts must not be imported on the client');
}

// Run prod-required env validation on first load. Throws a
// human-readable error listing every missing/malformed var if
// anything is wrong. In dev, missing optional vars are tolerated
// (the schema marks them .optional()); in production, the
// production-only block in validateServerEnv() escalates them to
// hard failures — including Vapi credentials, Resend, Stripe live
// keys, and a TEST_OVERRIDE_PHONE refusal.
//
// Exception path: tests routinely import this module without setting
// every prod var. We skip the validation gate when NODE_ENV is
// 'test' so vitest stays green.
if (process.env.NODE_ENV !== 'test') {
  validateServerEnv();
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
