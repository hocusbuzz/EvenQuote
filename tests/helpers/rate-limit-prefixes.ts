// R48(a) — Shared rate-limit prefix registry.
//
// `assertRateLimit` / `assertRateLimitFromHeaders` namespace each
// caller via a `prefix` string. Two callers that pass the SAME prefix
// share a bucket — a flooder on one drains the other's budget.
// Two callers that pass different prefixes that one of them MEANT to
// match (typo'd `csp-reports` vs `csp-report`) silently desync.
//
// R47(a) introduced an inline `KNOWN_PREFIXES` array in
// `app/api/csp-report/csp-report-rate-limit-drift.test.ts` to detect
// bucket collisions. R47 close noted the obvious follow-up: when
// rate-limited routes proliferate (places R46(a), csp-report R47(a),
// dev/* R48(h) candidate, future checkout/auth flows), the inline
// list becomes a duplication hazard. Lift the registry now while it
// has only one consumer; future audits can `import { KNOWN_PREFIXES }`
// without re-curating their own copy.
//
// Layering note: this module contains ONLY the registry data + a
// shape check. No test utilities, no I/O, no expects. Audits compose
// it with their own per-route locks. Keeping data and behavior
// separate means a new audit doesn't have to extend this file.

// ── KNOWN_PREFIXES ─────────────────────────────────────────────────
//
// All rate-limit `prefix:` values used in production code paths AND
// reserved for in-flight or anticipated routes / server actions.
// Audits use this list for collision detection ("is this new prefix
// already in use elsewhere?").
//
// What goes in this set:
//   - every prefix that appears in `prefix: '...'` inside a `route.ts`
//     POST/GET body that calls `assertRateLimit(...)`
//   - every prefix that appears in a server action (`lib/actions/*.ts`)
//     that calls `assertRateLimitFromHeaders(...)`
//   - prefixes RESERVED for routes that are anticipated but not yet
//     shipped — claiming the namespace early prevents an unrelated
//     route from squatting on it later
//
// What does NOT go in this set:
//   - prefixes used only inside `lib/security/rate-limit-auth.test.ts`
//     unit tests (`'test'`, `'sa'`, `'shared'`, etc.) — those exercise
//     the rate-limiter primitive, not real callers
//   - prefixes used inside `lib/security/exports.test.ts` smoke tests
//     (`'exports-check'`, `'exports-check-headers'`)
//
// When you add a real rate-limited caller, ALSO add its prefix here.
// The audits that import this list will surface a missing entry.
export const KNOWN_PREFIXES: readonly string[] = [
  // ── Production: HTTP routes ────────────────────────────────────────
  'csp-report', // app/api/csp-report/route.ts (R47(a))
  'places-autocomplete', // app/api/places/autocomplete/route.ts (R46(a))
  'places-details', // app/api/places/details/route.ts (R46(a))

  // ── Production: server actions ────────────────────────────────────
  'waitlist', // lib/actions/waitlist.ts
  'coupon-redeem', // 2026-05-04 — lib/actions/coupons.ts redeemCoupon (5 attempts / 5 min per IP).

  // ── Dev-only routes (R48(h) defense-in-depth) ─────────────────────
  // These routes 404 in prod (assertDevToken NODE_ENV gate). The
  // rate-limit prefix is still reserved here so a future maintainer
  // who promotes one of these to prod can't reuse the prefix on a
  // public route by accident.
  'dev-trigger-call', // app/api/dev/trigger-call/route.ts
  'dev-backfill-call', // app/api/dev/backfill-call/route.ts
  'dev-skip-payment', // app/api/dev/skip-payment/route.ts

  // ── Reserved: anticipated but not yet wired ───────────────────────
  // These names appear in `lib/security/rate-limit-auth.test.ts` as
  // representative scenarios because the corresponding routes /
  // actions are planned. Reserving the namespace here prevents an
  // unrelated route landing on the same prefix and silently fusing
  // buckets.
  'checkout', // anticipated: get-quotes/checkout flow
  'auth', // anticipated: auth/* flows (broad)
  'auth-magic-link', // anticipated: magic-link send
  'magic-link-resend', // anticipated: magic-link resend
] as const;

// ── KNOWN_PREFIX_SET ───────────────────────────────────────────────
//
// Set form for O(1) `.has(prefix)` lookups. Most consumers want
// inclusion / exclusion, not iteration order.
export const KNOWN_PREFIX_SET: ReadonlySet<string> = new Set<string>(
  KNOWN_PREFIXES,
);

// ── isKnownPrefix ──────────────────────────────────────────────────
//
// Audits should call this rather than reaching into KNOWN_PREFIX_SET
// directly so that future renames or stricter validation (e.g.
// regex shape check) land in one place.
export function isKnownPrefix(prefix: string): boolean {
  return KNOWN_PREFIX_SET.has(prefix);
}

// ── assertPrefixesUnique (registry sanity check) ──────────────────
//
// Defensive: if a maintainer ever lands a duplicate entry by accident
// (e.g. paste-merging two PRs), this asserts the shape of the
// registry itself. Consumers can call it once at the top of their
// describe() block.
export function assertKnownPrefixesUnique(): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of KNOWN_PREFIXES) {
    if (seen.has(p)) dupes.push(p);
    seen.add(p);
  }
  if (dupes.length > 0) {
    throw new Error(
      `rate-limit-prefixes.ts: duplicate entries in KNOWN_PREFIXES: ${dupes.join(', ')}`,
    );
  }
}

// ── PREFIX_SHAPE_RE ────────────────────────────────────────────────
//
// Prefixes are namespace strings. The rate-limit primitive doesn't
// enforce a shape, but a chaotic prefix ('csp_report'? 'CSP-Report'?
// 'csp/report'?) makes collision detection brittle. Lock to lower
// kebab-case so any new prefix passes the shape filter or fails
// loudly at the audit boundary.
export const PREFIX_SHAPE_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

export function assertKnownPrefixShape(): void {
  const bad: string[] = [];
  for (const p of KNOWN_PREFIXES) {
    if (!PREFIX_SHAPE_RE.test(p)) bad.push(p);
  }
  if (bad.length > 0) {
    throw new Error(
      `rate-limit-prefixes.ts: prefixes do not match shape ${PREFIX_SHAPE_RE}: ${bad.join(', ')}`,
    );
  }
}
