// Environment variable validation.
//
// Call `validateServerEnv()` at server startup to fail fast if something
// required is missing or malformed. Importing this from a route would
// validate once per serverless cold-start, which is the earliest we can
// catch a bad deploy without adding a separate boot script.
//
// Design:
//   • Split schemas: public vars (anything NEXT_PUBLIC_*) must exist both
//     client- and server-side; private vars only server-side.
//   • Feature-flagged integrations (Vapi, Resend, Anthropic, Google Places)
//     use .optional() — the code has simulation fallbacks and we want
//     staging envs with missing keys to boot rather than crash.
//   • Booleans come in as strings; normalize with a small transformer.
//
// Usage:
//   - Import and call once from a long-lived module (e.g. lib/supabase/admin)
//     if you want fail-fast on a misconfigured deploy.
//   - Run `npx tsx scripts/verify-env.ts` (if added) in CI for pre-deploy
//     validation.

import { z } from 'zod';
import { EnvEmailSchema } from '@/lib/forms/moving-intake';

const BooleanString = z
  .union([z.literal('true'), z.literal('false')])
  .transform((v) => v === 'true');

const ServerEnvSchema = z.object({
  // ─── Supabase (required) ────────────────────────────────────────
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, 'anon key looks short'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'service role key looks short'),

  // ─── Stripe (required for production) ───────────────────────────
  // Optional at parse time so local dev without Stripe still boots; the
  // checkout path throws separately if missing. A staging deploy must set these.
  STRIPE_SECRET_KEY: z.string().startsWith('sk_').optional(),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),

  // ─── Cron secret (required in prod) ─────────────────────────────
  CRON_SECRET: z.string().min(16, 'pick a 16+ char random secret').optional(),

  // ─── Vapi (optional — simulation mode if missing) ──────────────
  VAPI_API_KEY: z.string().optional(),
  VAPI_ASSISTANT_ID: z.string().optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),

  // ─── Resend (optional — simulation mode if missing) ────────────
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  // RESEND_FROM is often a full "Name <email@domain>" string, not a bare
  // email — don't tighten to z.email().
  RESEND_FROM: z.string().optional(),
  // R46(b): use the shared EnvEmailSchema primitive (deliberately
  // loose — no .trim()/.toLowerCase() — so an operator typo like
  // "  Foo@Bar.com  " fails validation rather than getting silently
  // normalized in production).
  EVENQUOTE_SUPPORT_EMAIL: EnvEmailSchema.optional(),

  // ─── Founder "new payment" alert toggle ────────────────────────
  // Defaults to ON when EVENQUOTE_SUPPORT_EMAIL is set. Set to
  // 'false' in Vercel to mute the per-payment alert when volume
  // turns it into noise (the stuck-request and dispute alerts on
  // the same support email stay ON regardless). Loose string here
  // — the runtime check in the webhook is `?.toLowerCase() === 'false'`.
  EVENQUOTE_NEW_PAYMENT_ALERTS: z.string().optional(),

  // ─── Quote extraction (optional) ───────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_EXTRACTION_MODEL: z.string().optional(),

  // ─── Business ingest (optional) ────────────────────────────────
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  // ─── Call batch size (optional; default 5) ─────────────────────
  // Parsed with a coercion + bounds check so a bad value fails at boot
  // rather than at first enqueue. Max 20 — Vapi's per-request cost and
  // our cron retry design don't make sense above this. Default reduced
  // 10 → 5 (#111) after launch cost analysis: at $0.20-0.50 per call
  // × 10 calls = up to $5 worst-case on a $9.99 sale, margin was thin.
  // 5 calls + retry-unreached's optional 5-call top-up gives the same
  // upper bound without the worst-case cost when we don't need it.
  // Most customers compare 3 of the quotes anyway.
  CALL_BATCH_SIZE: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 20),
      { message: 'CALL_BATCH_SIZE must be an integer between 1 and 20' }
    ),

  // ─── App config ────────────────────────────────────────────────
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED: BooleanString.optional(),

  // ─── Analytics — GA4 (optional) ─────────────────────────────────
  // Both vars are optional at schema level so:
  //   • local dev (no analytics needed) and
  //   • staging deploys (where we don't want to pollute prod GA4
  //     stream) can boot cleanly.
  // The analytics module is a graceful no-op when either is missing —
  // see lib/analytics/ga4.ts for the runtime guards. Pre-paid-traffic
  // (#125 / day-8 marketing sprint) prod must have BOTH set.
  //
  // NEXT_PUBLIC_GA4_MEASUREMENT_ID: client-side gtag init + event fire.
  //   Format: 'G-XXXXXXXXXX' (10 alphanumeric after the dash).
  //   NEXT_PUBLIC_ prefix bakes it into the client bundle at build time
  //   — required because the gtag script needs it inline in the layout.
  //
  // GA4_API_SECRET: server-side Measurement Protocol secret. Used for
  //   the quote_request_paid (Stripe webhook) and quote_delivered
  //   (Resend cron) events that have no client to gtag from. Generated
  //   in GA4 Admin → Data Streams → Measurement Protocol API secrets.
  //   NEVER exposed to the client; no NEXT_PUBLIC_ prefix.
  NEXT_PUBLIC_GA4_MEASUREMENT_ID: z
    .string()
    .regex(/^G-[A-Z0-9]+$/, 'GA4 measurement ID looks like G-XXXXXXXXXX')
    .optional(),
  GA4_API_SECRET: z.string().min(8, 'GA4 API secret looks short').optional(),

  // ─── Analytics — Meta Pixel (optional) ──────────────────────────
  // Pixel ID is a 15-16 digit numeric string. Used by the client-
  // side fbq script in lib/analytics/meta-script.tsx. Like GA4, it's
  // optional at schema level — non-prod skips it cleanly.
  //
  // META_CONVERSIONS_API_TOKEN is the SERVER-SIDE complement (Meta's
  // analog of GA4_API_SECRET). NOT required by the Pixel itself —
  // when missing, the client-side fbq still fires and we just skip
  // the server-side Conversions API fan-out for quote_delivered.
  // Generate in Meta Events Manager → Pixel → Settings → CAPI.
  NEXT_PUBLIC_META_PIXEL_ID: z
    .string()
    .regex(/^\d{10,20}$/, 'Meta Pixel ID is 10-20 digits')
    .optional(),
  META_CONVERSIONS_API_TOKEN: z
    .string()
    .min(20, 'Meta CAPI token looks short')
    .optional(),

  // ─── Anti-spam — Cloudflare Turnstile (optional) ────────────────
  // Free invisible CAPTCHA. Both vars must be set for the protection
  // to fire — when either is missing, the entire Turnstile path is a
  // no-op (client widget renders nothing, server verification returns
  // ok). See lib/security/turnstile.ts for the runtime behavior +
  // soft-allow-on-outage rationale.
  //
  // Site keys look like '0x4AAAAAAAxxxxxxxx' (hex-ish, ~22 chars after
  // the 0x prefix). Secret keys are similar shape. Generated in
  // Cloudflare Dashboard → Turnstile → Add Site → free plan.
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z
    .string()
    .min(8, 'Turnstile site key looks short')
    .optional(),
  TURNSTILE_SECRET_KEY: z
    .string()
    .min(8, 'Turnstile secret key looks short')
    .optional(),

  // ─── Maintenance mode ──────────────────────────────────────────
  MAINTENANCE_MODE: BooleanString.optional(),
  MAINTENANCE_PREVIEW_TOKEN: z.string().optional(),

  // ─── Node env (Next sets this) ─────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .optional()
    .default('development'),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let _cached: ServerEnv | null = null;

/**
 * Validate server-side env. Returns parsed env on success, throws on
 * failure with a human-readable error listing every problem.
 *
 * Cached after first successful call. In a serverless environment this
 * runs once per cold-start.
 */
export function validateServerEnv(): ServerEnv {
  if (_cached) return _cached;

  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        `Copy .env.example → .env.local and fill in the required values.`
    );
  }

  _cached = parsed.data;

  // ─── Production-only required vars ──────────────────────────────
  // These are optional at schema level (for dev ergonomics) but MUST
  // be present in production. Bail loudly if missing.
  //
  // Why each one is here:
  //
  //   • RESEND_API_KEY / RESEND_FROM — sendEmail() degrades to a
  //     simulated fake-id success when these are missing. The cron
  //     and contact-release paths only check `.ok`, so a prod
  //     without Resend silently stamps reports as delivered + flips
  //     contact_released_at while no email ships.
  //
  //   • VAPI_* (R47.4) — startOutboundCall() degrades to a sim_*
  //     fake call id when these are missing. The end-of-call webhook
  //     never fires, but the engine has already incremented
  //     total_calls_made and the request advances toward 'processing'
  //     on synthetic data. Customers paid us, no calls happened.
  //
  //   • TEST_OVERRIDE_PHONE — fail loudly if this leaks into prod.
  //     The dialer uses it to redirect every contractor call. With
  //     it set in prod, every customer's calls go to one number —
  //     usually the developer's phone. Worst-possible failure mode.
  if (_cached.NODE_ENV === 'production') {
    const missingInProd: string[] = [];
    if (!_cached.STRIPE_SECRET_KEY) missingInProd.push('STRIPE_SECRET_KEY');
    if (!_cached.STRIPE_WEBHOOK_SECRET) missingInProd.push('STRIPE_WEBHOOK_SECRET');
    if (!_cached.CRON_SECRET) missingInProd.push('CRON_SECRET');
    if (!_cached.NEXT_PUBLIC_APP_URL) missingInProd.push('NEXT_PUBLIC_APP_URL');
    if (!_cached.RESEND_API_KEY) missingInProd.push('RESEND_API_KEY');
    if (!_cached.RESEND_FROM) missingInProd.push('RESEND_FROM');

    // Vapi quartet — all four needed for real calls. Missing any
    // single one degrades startOutboundCall() into simulation, which
    // is what we're hard-disabling in prod.
    if (!_cached.VAPI_API_KEY) missingInProd.push('VAPI_API_KEY');
    if (!_cached.VAPI_ASSISTANT_ID) missingInProd.push('VAPI_ASSISTANT_ID');
    if (!_cached.VAPI_PHONE_NUMBER_ID) missingInProd.push('VAPI_PHONE_NUMBER_ID');
    if (!_cached.VAPI_WEBHOOK_SECRET) missingInProd.push('VAPI_WEBHOOK_SECRET');

    if (missingInProd.length) {
      throw new Error(
        `Production env missing required vars: ${missingInProd.join(', ')}`
      );
    }

    // Hard refuse: TEST_OVERRIDE_PHONE in prod. We read directly from
    // process.env (not the cached schema) so this guard fires even if
    // the schema added it as optional later.
    if (process.env.TEST_OVERRIDE_PHONE) {
      throw new Error(
        'TEST_OVERRIDE_PHONE is set in production. ' +
          'This redirects every contractor call to one number — ' +
          'remove from your prod env immediately. ' +
          'See lib/calls/vapi.ts for context.'
      );
    }
  }

  return _cached;
}

/**
 * Safer access — returns { ok, env } or { ok, issues }. Use when you
 * want to render a configuration error page instead of crashing.
 */
export function safeServerEnv():
  | { ok: true; env: ServerEnv }
  | { ok: false; error: string } {
  try {
    return { ok: true, env: validateServerEnv() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Production readiness report — which optional feature integrations are
 * live and which are in simulation mode. Not a throw-on-failure; we want
 * the app to still boot if e.g. Resend is down and we're using simulation.
 * Surfaced by /api/health and used by the startup banner in lib/logger.
 */
export function featureReadiness(): {
  stripe: boolean;
  vapi: boolean;
  resend: boolean;
  anthropic: boolean;
  placesIngest: boolean;
} {
  return {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
    vapi: Boolean(
      process.env.VAPI_API_KEY &&
        process.env.VAPI_ASSISTANT_ID &&
        process.env.VAPI_PHONE_NUMBER_ID &&
        process.env.VAPI_WEBHOOK_SECRET
    ),
    resend: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    placesIngest: Boolean(process.env.GOOGLE_PLACES_API_KEY),
  };
}

/**
 * Parse CALL_BATCH_SIZE with a sane default. Bounds are enforced by the
 * schema above; if that validation passed, the coerce-to-number here is
 * safe. Default 5 (#111) — sized to keep per-request Vapi cost bounded
 * (~$1-2.50 worst case vs. $9.99 revenue). retry-unreached can dispatch
 * up to 5 more on top if the first batch doesn't yield enough quotes.
 */
export function getCallBatchSize(): number {
  const raw = process.env.CALL_BATCH_SIZE;
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 5;
}
