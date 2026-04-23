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
  EVENQUOTE_SUPPORT_EMAIL: z.string().email().optional(),

  // ─── Quote extraction (optional) ───────────────────────────────
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_EXTRACTION_MODEL: z.string().optional(),

  // ─── Business ingest (optional) ────────────────────────────────
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  // ─── Call batch size (optional; default 5) ─────────────────────
  // Parsed with a coercion + bounds check so a bad value fails at boot
  // rather than at first enqueue. Max 20 — Vapi's per-request cost and
  // our cron retry design don't make sense above this.
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
  if (_cached.NODE_ENV === 'production') {
    const missingInProd: string[] = [];
    if (!_cached.STRIPE_SECRET_KEY) missingInProd.push('STRIPE_SECRET_KEY');
    if (!_cached.STRIPE_WEBHOOK_SECRET) missingInProd.push('STRIPE_WEBHOOK_SECRET');
    if (!_cached.CRON_SECRET) missingInProd.push('CRON_SECRET');
    if (!_cached.NEXT_PUBLIC_APP_URL) missingInProd.push('NEXT_PUBLIC_APP_URL');

    if (missingInProd.length) {
      throw new Error(
        `Production env missing required vars: ${missingInProd.join(', ')}`
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
 * safe. Default 5 matches the original inline default in queue/enqueue-calls.
 */
export function getCallBatchSize(): number {
  const raw = process.env.CALL_BATCH_SIZE;
  if (!raw) return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : 5;
}
