// R46(d) — Shared route-catalog source-of-truth.
//
// Four catalog-driven audits used to maintain their own copy of the
// "list of routes I care about" / "non-cacheable routes" / etc. set.
// Each time a new route landed, the maintainer had to remember to
// update FOUR files. R45(a)'s places-proxy add-on touched four
// catalogs; R45(e) explicitly enumerated all four. R45 close noted
// that one catalog (`route-response-headers-exact-shape.test.ts`'s
// NON_CACHEABLE set) was MISSED — drift snuck in despite the
// audits' otherwise tight coverage.
//
// This module is the single source of truth. Each audit imports
// from here. Adding a new route is now a one-edit operation; the
// audits surface coverage gaps automatically.
//
// Layering note: this module contains ONLY pure data — no test
// utilities, no expects, no I/O. Audits compose it with their own
// per-route specs (e.g. expected method sets, response shapes).
// Keeping data and behavior separate means adding a new audit
// doesn't require touching the catalog.

import fs from 'node:fs';
import path from 'node:path';

// ── NON_CACHEABLE ──────────────────────────────────────────────────
//
// Routes whose Cache-Control header MUST be `no-store, no-cache,
// must-revalidate, max-age=0` if set at all. Used by:
//   • app/route-response-headers-drift.test.ts (R43(c) — prefix lock)
//   • app/route-response-headers-exact-shape.test.ts (R44(c) — exact lock)
//
// What goes in this set:
//   - any route that performs work (cron, webhook, api/dev/*)
//   - any route whose response is user-specific (places proxies, auth)
//   - any route that must always reflect current state (status, health)
//
// What does NOT go in this set:
//   - app/api/version/route.ts — explicitly cacheable; see CACHEABLE_VERSION
export const NON_CACHEABLE: ReadonlySet<string> = new Set<string>([
  'app/api/cron/check-status/route.ts',
  'app/api/cron/check-stuck-requests/route.ts',
  'app/api/cron/dispatch-scheduled-requests/route.ts',
  'app/api/cron/reconcile-calls/route.ts',
  'app/api/cron/retry-failed-calls/route.ts',
  'app/api/cron/send-reports/route.ts',
  'app/api/cron/send-winbacks/route.ts',
  'app/api/csp-report/route.ts',
  'app/api/dev/backfill-call/route.ts',
  'app/api/dev/skip-payment/route.ts',
  'app/api/dev/trigger-call/route.ts',
  'app/api/health/route.ts',
  'app/api/places/autocomplete/route.ts',
  'app/api/places/details/route.ts',
  'app/api/status/route.ts',
  'app/api/stripe/webhook/route.ts',
  'app/api/twilio/sms/route.ts',
  'app/api/vapi/inbound-callback/route.ts',
  'app/api/vapi/webhook/route.ts',
  'app/auth/callback/route.ts',
  'app/auth/signout/route.ts',
  'app/auth/verify/route.ts',
  'app/get-quotes/claim/route.ts',
]);

// ── CACHEABLE_VERSION ──────────────────────────────────────────────
//
// Single-entry set kept as a Set (not a constant) so audits can
// uniformly iterate. The version route is locked to:
//   `public, s-maxage=60, stale-while-revalidate=120`
// This value is duplicated in the audit that locks it; this catalog
// only declares membership, not value.
export const CACHEABLE_VERSION: ReadonlySet<string> = new Set<string>([
  'app/api/version/route.ts',
]);

// ── ALL_ROUTES (R47(b)) ───────────────────────────────────────────
//
// Union of NON_CACHEABLE and CACHEABLE_VERSION — the canonical
// membership list for every `route.ts` in `app/**`. Per-route audits
// (`route-handler-exports-drift`, `route-response-shape-drift`,
// `route-reason-audit`) maintain their own per-route SPECS but
// derive MEMBERSHIP from this set.
//
// Why a derived export rather than asking each audit to take the
// union itself: a downstream audit that scans for "every route" is
// asking the same question every other one does — adding the union
// here means the question has one answer, not three.
//
// Adding a new route is a one-edit operation: add to NON_CACHEABLE
// or CACHEABLE_VERSION above, and every consumer picks it up. The
// route-catalog.test.ts coverage check will fail until you do, so
// drift is impossible to land silently.
export const ALL_ROUTES: ReadonlySet<string> = new Set<string>([
  ...NON_CACHEABLE,
  ...CACHEABLE_VERSION,
]);

// ── Path-format helpers (R47(b)) ──────────────────────────────────
//
// Three downstream audits use three slightly different path formats
// for the SAME route:
//   • route-handler-exports-drift.test.ts  — 'app/api/health/route.ts'
//     (matches the catalog format above)
//   • route-response-shape-drift.test.ts   — 'api/health/route.ts'
//     (drops the leading 'app/' because its discovery walk runs
//     inside app/)
//   • route-reason-audit.test.ts           — 'api/health'
//     (just the route segment used in capture tags)
//
// Rather than force-unify all three (which would touch dozens of
// per-route specs), expose helpers that strip the catalog format to
// each variant. Audits can derive their own subset+format from
// ALL_ROUTES in a single expression.

/** Strip leading `app/` (kept as path-inside-app/, including `/route.ts`). */
export function toAppRelative(catalogPath: string): string {
  if (!catalogPath.startsWith('app/')) {
    throw new Error(
      `toAppRelative: expected catalog path to start with 'app/', got: ${catalogPath}`,
    );
  }
  return catalogPath.slice('app/'.length);
}

/** Strip leading `app/` AND trailing `/route.ts` — segment-only form. */
export function toRouteSegment(catalogPath: string): string {
  if (
    !catalogPath.startsWith('app/') ||
    !catalogPath.endsWith('/route.ts')
  ) {
    throw new Error(
      `toRouteSegment: expected 'app/.../route.ts', got: ${catalogPath}`,
    );
  }
  return catalogPath.slice(
    'app/'.length,
    catalogPath.length - '/route.ts'.length,
  );
}

// ── Canonical Cache-Control values ─────────────────────────────────
//
// Both audits that lock the value can re-export from here. Keeping
// the canonical strings next to the membership sets means a future
// "tighten the canonical no-store" task is a one-edit change rather
// than a sweep.
export const CANONICAL_NO_STORE =
  'no-store, no-cache, must-revalidate, max-age=0' as const;

export const CANONICAL_VERSION_CACHE_CONTROL =
  'public, s-maxage=60, stale-while-revalidate=120' as const;

// ── Canonical route-segment-config values (R49(i)) ─────────────────
//
// Next.js App Router accepts a small set of literal values for the
// `dynamic` and `runtime` route-segment-config exports. Our codebase
// uses exactly one of each. Naming the canonical values up here means
// an audit can compare against the constant rather than re-typing the
// literal in every test, and a future change ("we're switching to
// edge runtime for these routes") is a one-line edit at the catalog
// layer plus a per-route attestation update.
export const CANONICAL_DYNAMIC = 'force-dynamic' as const;
export const CANONICAL_RUNTIME = 'nodejs' as const;

// ── DYNAMIC_EXPORT_VALUE / RUNTIME_EXPORT_VALUE (R49(i)) ───────────
//
// R42(c) (`route-handler-exports-drift.test.ts`) locks the SET of
// config exports per route — it requires e.g. `'dynamic'` and
// `'runtime'` to be in the export list, but does NOT lock the
// VALUES those exports carry. A future maintainer who hand-edits
// `dynamic = 'force-static'` (a real, type-valid Next.js value)
// would silently make a webhook route page-cacheable; R42(c) sees
// the export and is satisfied.
//
// These per-route attestation maps lock the VALUE of each declared
// export. `null` means the route deliberately does NOT export the
// config — auth callback / signout fall in this bucket; redirect
// flows don't need force-dynamic, and exporting it accidentally
// would change the route's static-optimization eligibility.
//
// Adding a new route requires adding an entry to BOTH maps.
// `assertConfigAttestationCovers()` runs in the audit's first test
// and trips loudly if either map is missing a route.
//
// Why two maps instead of one richer record:
//   - Each export is independent. Redirect-only routes opt out of
//     `dynamic` AND `runtime`; cron routes opt in to both. There's
//     no overlap structure that combining the maps would express
//     more cleanly.
//   - Both maps share the same domain (ALL_ROUTES). Consumers that
//     only care about one (e.g. a Stripe-specific audit) can import
//     just the map they need.

export const DYNAMIC_EXPORT_VALUE: Readonly<
  Record<string, typeof CANONICAL_DYNAMIC | null>
> = {
  // Every NON_CACHEABLE route except the two redirect-only ones
  // exports `dynamic = 'force-dynamic'`.
  'app/api/cron/check-status/route.ts': CANONICAL_DYNAMIC,
  'app/api/cron/check-stuck-requests/route.ts': CANONICAL_DYNAMIC,
  'app/api/cron/dispatch-scheduled-requests/route.ts': CANONICAL_DYNAMIC,
  'app/api/cron/reconcile-calls/route.ts': CANONICAL_DYNAMIC,
  'app/api/cron/retry-failed-calls/route.ts': CANONICAL_DYNAMIC,
  'app/api/cron/send-reports/route.ts': CANONICAL_DYNAMIC,
  'app/api/cron/send-winbacks/route.ts': CANONICAL_DYNAMIC,
  'app/api/csp-report/route.ts': CANONICAL_DYNAMIC,
  'app/api/dev/backfill-call/route.ts': CANONICAL_DYNAMIC,
  'app/api/dev/skip-payment/route.ts': CANONICAL_DYNAMIC,
  'app/api/dev/trigger-call/route.ts': CANONICAL_DYNAMIC,
  'app/api/health/route.ts': CANONICAL_DYNAMIC,
  'app/api/places/autocomplete/route.ts': CANONICAL_DYNAMIC,
  'app/api/places/details/route.ts': CANONICAL_DYNAMIC,
  'app/api/status/route.ts': CANONICAL_DYNAMIC,
  'app/api/stripe/webhook/route.ts': CANONICAL_DYNAMIC,
  'app/api/twilio/sms/route.ts': CANONICAL_DYNAMIC,
  'app/api/vapi/inbound-callback/route.ts': CANONICAL_DYNAMIC,
  'app/api/vapi/webhook/route.ts': CANONICAL_DYNAMIC,
  'app/get-quotes/claim/route.ts': CANONICAL_DYNAMIC,

  // CACHEABLE_VERSION: version route ALSO uses force-dynamic. The
  // route always renders fresh on the server; CDN / browser
  // caching is governed by the explicit Cache-Control header, not
  // by Next.js's static-optimization layer. Using force-dynamic
  // here disables build-time prerendering so a cold deploy doesn't
  // serve a stale build hash from the .next/server/app cache.
  'app/api/version/route.ts': CANONICAL_DYNAMIC,

  // Redirect-only auth handlers do NOT export dynamic. Auth
  // callbacks issue redirects; force-dynamic on a redirect changes
  // nothing observable but signals an unintended choice. R48(b)
  // locks the absence at the strategy layer; this attestation
  // makes it explicit at the value layer.
  'app/auth/callback/route.ts': null,
  'app/auth/signout/route.ts': null,
  // /auth/verify is a 302 proxy to <project>.supabase.co/auth/v1/verify.
  // Same redirect-only pattern as callback / signout.
  'app/auth/verify/route.ts': null,
};

export const RUNTIME_EXPORT_VALUE: Readonly<
  Record<string, typeof CANONICAL_RUNTIME | null>
> = {
  // Every server-work route runs on Node — Vapi / Stripe / Twilio
  // verification primitives use Node crypto; cron jobs use Supabase
  // SSR clients that pull in `crypto`; dev hooks invoke scripts.
  'app/api/cron/check-status/route.ts': CANONICAL_RUNTIME,
  'app/api/cron/check-stuck-requests/route.ts': CANONICAL_RUNTIME,
  'app/api/cron/dispatch-scheduled-requests/route.ts': CANONICAL_RUNTIME,
  'app/api/cron/reconcile-calls/route.ts': CANONICAL_RUNTIME,
  'app/api/cron/retry-failed-calls/route.ts': CANONICAL_RUNTIME,
  'app/api/cron/send-reports/route.ts': CANONICAL_RUNTIME,
  'app/api/cron/send-winbacks/route.ts': CANONICAL_RUNTIME,
  'app/api/csp-report/route.ts': CANONICAL_RUNTIME,
  'app/api/dev/backfill-call/route.ts': CANONICAL_RUNTIME,
  'app/api/dev/skip-payment/route.ts': CANONICAL_RUNTIME,
  'app/api/dev/trigger-call/route.ts': CANONICAL_RUNTIME,
  'app/api/health/route.ts': CANONICAL_RUNTIME,
  'app/api/places/autocomplete/route.ts': CANONICAL_RUNTIME,
  'app/api/places/details/route.ts': CANONICAL_RUNTIME,
  'app/api/status/route.ts': CANONICAL_RUNTIME,
  'app/api/stripe/webhook/route.ts': CANONICAL_RUNTIME,
  'app/api/twilio/sms/route.ts': CANONICAL_RUNTIME,
  'app/api/vapi/inbound-callback/route.ts': CANONICAL_RUNTIME,
  'app/api/vapi/webhook/route.ts': CANONICAL_RUNTIME,
  'app/api/version/route.ts': CANONICAL_RUNTIME,

  // get-quotes/claim does not export runtime — R42(c) catalog
  // declares config: ['dynamic'] only. This route inherits the
  // App Router default. Documenting null at the attestation layer
  // means a future PR that flips it to nodejs/edge requires an
  // explicit catalog edit.
  'app/get-quotes/claim/route.ts': null,

  // Redirect-only auth handlers: same as dynamic — no runtime
  // export, default behavior is correct.
  'app/auth/callback/route.ts': null,
  'app/auth/signout/route.ts': null,
  'app/auth/verify/route.ts': null,
};

/**
 * Throws if any ALL_ROUTES entry lacks a value in either
 * DYNAMIC_EXPORT_VALUE or RUNTIME_EXPORT_VALUE, or if either map
 * has an orphan entry that's not in ALL_ROUTES.
 *
 * This is the "adding a new route requires updating attestations"
 * tripwire. Run it as the first test in the per-config audit so a
 * coverage drift fails the whole audit immediately rather than
 * cascading into N stale per-route assertions.
 */
export function assertConfigAttestationCovers(): void {
  const missingDynamic: string[] = [];
  const missingRuntime: string[] = [];
  for (const r of ALL_ROUTES) {
    if (!(r in DYNAMIC_EXPORT_VALUE)) missingDynamic.push(r);
    if (!(r in RUNTIME_EXPORT_VALUE)) missingRuntime.push(r);
  }
  const orphanDynamic = Object.keys(DYNAMIC_EXPORT_VALUE).filter(
    (r) => !ALL_ROUTES.has(r),
  );
  const orphanRuntime = Object.keys(RUNTIME_EXPORT_VALUE).filter(
    (r) => !ALL_ROUTES.has(r),
  );

  const errs: string[] = [];
  if (missingDynamic.length > 0) {
    errs.push(
      `ALL_ROUTES routes missing DYNAMIC_EXPORT_VALUE: ${missingDynamic.join(', ')}`,
    );
  }
  if (missingRuntime.length > 0) {
    errs.push(
      `ALL_ROUTES routes missing RUNTIME_EXPORT_VALUE: ${missingRuntime.join(', ')}`,
    );
  }
  if (orphanDynamic.length > 0) {
    errs.push(
      `DYNAMIC_EXPORT_VALUE has entries not in ALL_ROUTES: ${orphanDynamic.join(', ')}`,
    );
  }
  if (orphanRuntime.length > 0) {
    errs.push(
      `RUNTIME_EXPORT_VALUE has entries not in ALL_ROUTES: ${orphanRuntime.join(', ')}`,
    );
  }
  if (errs.length > 0) throw new Error(errs.join(' | '));
}

// ── CACHE_CONTROL_ATTESTATION (R48(b)) ─────────────────────────────
//
// Per-route declaration of HOW each NON_CACHEABLE route addresses
// Cache-Control. R44(c) locks the VALUE when the header is set; this
// catalog locks the STRATEGY each route uses, so a route can't drift
// from "explicit no-store" → "neither" without an explicit edit here.
//
// Three strategies:
//
//   • 'explicit-no-store' — route sets `'Cache-Control': '<canonical>'`
//     in its response Headers. Explicit is best-practice for any route
//     a CDN, browser, or proxy might otherwise cache by default.
//
//   • 'dynamic-only' — route exports `dynamic = 'force-dynamic'` but
//     does NOT set Cache-Control. Next.js's force-dynamic disables
//     route-level caching at the framework boundary, so for routes
//     that always run on the server (cron, webhooks, server actions)
//     the header is redundant. Documented choice; not a bug.
//
//   • 'redirect-only' — route always issues `NextResponse.redirect()`
//     and never returns a body. Cache-Control on a redirect would be
//     misapplied to the 302/303 response itself, not the destination.
//     Auth callback / signout routes use this pattern.
//
// Adding a new NON_CACHEABLE route REQUIRES adding its strategy here.
// The audit will fail discovery until you do.
export type CacheControlStrategy =
  | 'explicit-no-store'
  | 'dynamic-only'
  | 'redirect-only';

export const CACHE_CONTROL_ATTESTATION: Readonly<
  Record<string, CacheControlStrategy>
> = {
  // Explicit no-store: routes whose body shape consumers / monitors
  // hit at high frequency. Explicit header is belt-and-braces against
  // any framework default change.
  'app/api/cron/check-status/route.ts': 'explicit-no-store',
  'app/api/health/route.ts': 'explicit-no-store',
  'app/api/status/route.ts': 'explicit-no-store',

  // Dynamic-only: server-side work routes (cron, webhooks, dev hooks,
  // proxies, intake claim). force-dynamic disables route caching at
  // the framework boundary; setting Cache-Control as well is
  // redundant for these.
  'app/api/cron/check-stuck-requests/route.ts': 'dynamic-only',
  'app/api/cron/dispatch-scheduled-requests/route.ts': 'dynamic-only',
  'app/api/cron/reconcile-calls/route.ts': 'dynamic-only',
  'app/api/cron/retry-failed-calls/route.ts': 'dynamic-only',
  'app/api/cron/send-reports/route.ts': 'dynamic-only',
  'app/api/cron/send-winbacks/route.ts': 'dynamic-only',
  'app/api/csp-report/route.ts': 'dynamic-only',
  'app/api/dev/backfill-call/route.ts': 'dynamic-only',
  'app/api/dev/skip-payment/route.ts': 'dynamic-only',
  'app/api/dev/trigger-call/route.ts': 'dynamic-only',
  'app/api/places/autocomplete/route.ts': 'dynamic-only',
  'app/api/places/details/route.ts': 'dynamic-only',
  'app/api/stripe/webhook/route.ts': 'dynamic-only',
  'app/api/twilio/sms/route.ts': 'dynamic-only',
  'app/api/vapi/inbound-callback/route.ts': 'dynamic-only',
  'app/api/vapi/webhook/route.ts': 'dynamic-only',
  'app/get-quotes/claim/route.ts': 'dynamic-only',

  // Redirect-only: auth flows whose only return is a redirect. No
  // body, so no body-cache concern. R42(c) per-route config catalog
  // already locks that these don't export `dynamic`.
  'app/auth/callback/route.ts': 'redirect-only',
  'app/auth/signout/route.ts': 'redirect-only',
  'app/auth/verify/route.ts': 'redirect-only',
};

/**
 * Throws if any NON_CACHEABLE route lacks an attestation entry, or
 * any attestation entry references a route not in NON_CACHEABLE.
 */
export function assertAttestationCovers(): void {
  const missing: string[] = [];
  for (const r of NON_CACHEABLE) {
    if (!(r in CACHE_CONTROL_ATTESTATION)) missing.push(r);
  }
  const orphan: string[] = [];
  for (const r of Object.keys(CACHE_CONTROL_ATTESTATION)) {
    if (!NON_CACHEABLE.has(r)) orphan.push(r);
  }
  const errs: string[] = [];
  if (missing.length > 0) {
    errs.push(
      `NON_CACHEABLE routes missing CACHE_CONTROL_ATTESTATION: ${missing.join(', ')}`,
    );
  }
  if (orphan.length > 0) {
    errs.push(
      `CACHE_CONTROL_ATTESTATION has entries not in NON_CACHEABLE: ${orphan.join(', ')}`,
    );
  }
  if (errs.length > 0) throw new Error(errs.join(' | '));
}

// ── walkRouteFiles ─────────────────────────────────────────────────
//
// Two of the audits had near-identical fs walks looking for `route.ts`
// under `app/`. Lifting the walk here keeps a single canonical
// implementation. The walker:
//   - returns absolute paths
//   - sorts the result for deterministic test output
//   - skips `node_modules` defensively (test files don't run inside
//     node_modules but the helper is generic)
//
// Note: this returns ABSOLUTE paths; the audits convert to repo-
// relative when needed. (Some audits prefer `app/`-relative — see
// each audit's local path-normalization step.)
export function walkRouteFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name === 'route.ts') {
        out.push(full);
      }
    }
  }
  walk(root);
  return out.sort();
}

// ── Sanity check (used by all consuming audits) ────────────────────
//
// Every entry in NON_CACHEABLE / CACHEABLE_VERSION must be a real
// file. A typo in a path silently exempts a route from the audit it
// was supposed to be in. Each audit calls `assertCatalogPathsExist()`
// in a setup test so a typo shows up at the audit boundary.
//
// This is a function (not a static check) because process.cwd() is
// evaluated at test runtime.
export function assertCatalogPathsExist(): void {
  const missing: string[] = [];
  for (const rel of [...NON_CACHEABLE, ...CACHEABLE_VERSION]) {
    const full = path.join(process.cwd(), rel);
    if (!fs.existsSync(full)) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new Error(
      `route-catalog.ts references files that do not exist: ${missing.join(', ')}`,
    );
  }
}

// ── Disjointness ───────────────────────────────────────────────────
//
// A route cannot be both NON_CACHEABLE and CACHEABLE_VERSION. If
// both contain the same path the maintainer's intent is unclear and
// downstream audits will conflict.
export function assertCatalogsDisjoint(): void {
  const overlap: string[] = [];
  for (const rel of NON_CACHEABLE) {
    if (CACHEABLE_VERSION.has(rel)) overlap.push(rel);
  }
  if (overlap.length > 0) {
    throw new Error(
      `route-catalog.ts: paths appear in both NON_CACHEABLE and CACHEABLE_VERSION: ${overlap.join(', ')}`,
    );
  }
}
