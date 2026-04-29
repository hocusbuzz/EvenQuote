// Unified rate-limit "assert" helper.
//
// Today `lib/rate-limit.ts` is a low-level token-bucket returning a
// `RateLimitResult` with ok/remaining/resetAt/retryAfterSec. Route
// handlers then manually turn a `!ok` result into a 429 NextResponse
// with the right headers. Each call site reimplements the same
// three-line pattern:
//
//     const hit = rateLimit(clientKey(req, 'waitlist'), { limit: 5 });
//     if (!hit.ok) {
//       return NextResponse.json(
//         { ok: false, error: 'Too many requests' },
//         { status: 429, headers: { 'Retry-After': String(hit.retryAfterSec) } },
//       );
//     }
//
// This helper collapses it to one line matching the shape of
// `assertCronAuth` / `assertDevToken`:
//
//     const deny = assertRateLimit(req, { prefix: 'waitlist', limit: 5 });
//     if (deny) return deny;
//
// Why we're landing the helper ahead of the Upstash migration
// (user-input #2, still pending): when Upstash credentials arrive, we
// want the swap to be a one-file patch inside `lib/rate-limit.ts`. If
// the ergonomics helper is ALSO a separate module, call sites can
// migrate independently of the backing store. Writing it now means
// the migration PR doesn't also need to sweep call sites.
//
// For server actions (which don't receive a `Request` and can't return
// a `NextResponse`), see `assertRateLimitFromHeaders` further down. It
// shares the same bucket backing store and the same prefix namespacing
// rules — the only difference is the call surface.
//
// NOTE the helper was landed in advance of any call-site migration so
// the rollout is zero-behaviour-change per PR. Waitlist (server action)
// was migrated to `assertRateLimitFromHeaders` in Round 20.

import { NextResponse } from 'next/server';
import {
  rateLimit,
  clientKey,
  clientKeyFromHeaders,
  type RateLimitOptions,
} from '@/lib/rate-limit';

export type AssertRateLimitOptions = RateLimitOptions & {
  /**
   * Key prefix for bucketing. Picks the namespace for this endpoint
   * (e.g. 'waitlist', 'checkout', 'auth'). Buckets are scoped per-IP
   * within a prefix so hitting /waitlist does not consume /checkout
   * budget.
   */
  prefix: string;
  /**
   * Optional explicit key — overrides the IP-derived key. Useful when
   * the caller has already resolved a user/session id and wants to
   * bucket per-user instead of per-IP. When set, `prefix` is still
   * used as the namespace: final key is `${prefix}:${key}`.
   */
  key?: string;
  /**
   * Optional message for the 429 body. Default: 'Too many requests'.
   * Keep it generic — specific hints help attackers characterize the
   * rate limiter.
   */
  message?: string;
};

/**
 * Assert that `req` is within the configured rate limit. Returns a
 * 429 NextResponse on limit-exceeded, or `null` to let the caller
 * continue.
 *
 * Response shape on 429:
 *   • Body: `{ ok: false, error: <message> }`
 *   • Header: `Retry-After: <seconds>` — standard across the web.
 *   • Header: `X-RateLimit-Reset: <unix-ms>` — optional, included so
 *     a client UI can show a countdown without recomputing from
 *     Retry-After.
 *
 * Mirrors the `assertCronAuth` / `assertDevToken` contract so all
 * three auth-adjacent helpers feel uniform at the call site.
 */
export function assertRateLimit(
  req: Request,
  opts: AssertRateLimitOptions,
): NextResponse | null {
  const bucketKey = opts.key
    ? `${opts.prefix}:${opts.key}`
    : clientKey(req, opts.prefix);
  const hit = rateLimit(bucketKey, {
    limit: opts.limit,
    windowMs: opts.windowMs,
  });
  if (hit.ok) return null;

  return NextResponse.json(
    { ok: false, error: opts.message ?? 'Too many requests' },
    {
      status: 429,
      headers: {
        'Retry-After': String(hit.retryAfterSec),
        'X-RateLimit-Reset': String(hit.resetAt),
      },
    },
  );
}

/**
 * Refusal shape returned by `assertRateLimitFromHeaders` when a caller
 * is over the limit. Server actions own their own return shape (plain
 * serializable values, not NextResponse), so this helper hands back a
 * neutral object the caller can translate into whatever shape its own
 * return type uses. See `lib/actions/waitlist.ts` for a canonical
 * server-action translation.
 */
export type RateLimitRefusal = {
  /**
   * Integer seconds the client should wait before retrying. Mirrors
   * the HTTP Retry-After semantics used by `assertRateLimit` — server
   * actions can surface this number in a user-facing error message.
   */
  retryAfterSec: number;
  /**
   * Unix-ms timestamp when the bucket resets. Included so a server
   * action can forward it to the client for a countdown UI without
   * reimplementing the clock math.
   */
  resetAt: number;
  /**
   * Human-readable message. Matches the `opts.message ?? 'Too many
   * requests'` fallback used by `assertRateLimit` so the two helpers
   * stay consistent.
   */
  message: string;
};

/**
 * Server-action variant of `assertRateLimit`. Server actions in Next's
 * App Router don't receive a `Request` — they receive form/state args
 * plus access to `headers()` from `next/headers`. They also cannot
 * return a `NextResponse`; they return plain serializable values that
 * the client component re-renders into an error state.
 *
 * This helper mirrors `assertRateLimit`'s contract but:
 *   • Accepts a `Headers`-like bag (what `headers()` returns) instead
 *     of a `Request`.
 *   • Returns a plain `RateLimitRefusal` object on deny, so the caller
 *     can wrap it in its own return type — e.g. `{ ok: false, error }`
 *     for `joinWaitlist`, or a thrown Error inside a `useFormState`
 *     action, or a form-field validation object.
 *
 * Usage inside a server action:
 *
 *     import { headers } from 'next/headers';
 *     import { assertRateLimitFromHeaders } from '@/lib/security/rate-limit-auth';
 *
 *     const deny = assertRateLimitFromHeaders(headers(), {
 *       prefix: 'waitlist', limit: 5, windowMs: 60_000,
 *     });
 *     if (deny) {
 *       return {
 *         ok: false,
 *         error: `Too many requests. Try again in ${deny.retryAfterSec}s.`,
 *       };
 *     }
 *
 * Buckets are shared with `assertRateLimit` — a client hitting both a
 * route handler and a server action under the same prefix contends on
 * the same token bucket. That's the intended behaviour; prefixes are
 * the unit of rate-limit isolation, not transport type.
 */
export function assertRateLimitFromHeaders(
  h: { get: (name: string) => string | null },
  opts: AssertRateLimitOptions,
): RateLimitRefusal | null {
  const bucketKey = opts.key
    ? `${opts.prefix}:${opts.key}`
    : clientKeyFromHeaders(h, opts.prefix);
  const hit = rateLimit(bucketKey, {
    limit: opts.limit,
    windowMs: opts.windowMs,
  });
  if (hit.ok) return null;

  return {
    retryAfterSec: hit.retryAfterSec,
    resetAt: hit.resetAt,
    message: opts.message ?? 'Too many requests',
  };
}
