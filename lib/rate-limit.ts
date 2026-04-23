// In-memory token-bucket rate limiter.
//
// Scope:
//   • Intended for per-serverless-instance throttling of obvious abuse
//     (bots spamming the waitlist, someone scripting checkout creation).
//   • NOT a substitute for a distributed rate limiter like Upstash/Redis
//     — serverless functions scale horizontally and each instance has
//     its own map. Follow-up when we have real scale: swap the backing
//     store to Upstash Ratelimit.
//   • Safe to deploy as-is: worst case a determined attacker hits many
//     cold instances; they still can't exceed DB/payment provider
//     rate limits we already enforce server-side.
//
// Default policy: 10 requests per 60 seconds per key. Callers tune.
//
// Usage:
//   const hit = await rateLimit(`waitlist:${ip}`, { limit: 5, windowMs: 60_000 });
//   if (!hit.ok) return Response.json({ error: 'Too many requests' }, { status: 429 });

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

// Periodic cleanup to keep the map bounded. Runs at most once per minute
// when a rate-limit call happens to land after the interval.
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000;

function maybeCleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitOptions = {
  /** Max requests per window. Default 10. */
  limit?: number;
  /** Window length in ms. Default 60_000 (1 min). */
  windowMs?: number;
};

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
};

export function rateLimit(key: string, opts: RateLimitOptions = {}): RateLimitResult {
  const limit = opts.limit ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const now = Date.now();

  maybeCleanup(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return {
      ok: true,
      remaining: limit - 1,
      resetAt: now + windowMs,
      retryAfterSec: 0,
    };
  }

  if (existing.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSec: Math.ceil((existing.resetAt - now) / 1000),
    };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
    retryAfterSec: 0,
  };
}

/**
 * Extract a best-effort client identifier from a Request. Prefers
 * x-forwarded-for (Vercel sets this), then x-real-ip, then falls back
 * to 'unknown' which groups all requests into one bucket — intentional,
 * so an attacker stripping headers can't escape the limiter.
 */
export function clientKey(req: Request, prefix: string): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  // x-forwarded-for can be "client, proxy1, proxy2" — first is the real client.
  const ip = fwd.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
  return `${prefix}:${ip}`;
}

/**
 * Same semantic as clientKey() but accepts a Headers-like shape (what
 * `headers()` from next/headers returns inside server actions and server
 * components). Factored out so route handlers and server actions share
 * the exact same keying rules.
 */
export function clientKeyFromHeaders(
  h: { get: (name: string) => string | null },
  prefix: string
): string {
  const fwd = h.get('x-forwarded-for') ?? '';
  const ip = fwd.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  return `${prefix}:${ip}`;
}
