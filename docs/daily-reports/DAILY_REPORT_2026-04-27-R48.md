# Daily Report — 2026-04-27 (Round 48)

**Run type:** autonomous scheduled run
**Baseline (R47 close):** 2091 tests / 126 files; tsc clean; lint clean; 5 vulns (4 moderate, 1 high)
**Pre-R48 measured:** 2108 tests / 127 files; tsc clean; **5 lint errors** (regression — see R48(d)); 5 vulns (unchanged)
**Final (R48 close):** 2172 tests / 130 files; tsc clean; lint clean; 5 vulns (unchanged)
**Delta vs. R47:** +81 tests, +4 files. Five items shipped (a, b, c, d, h). Items e/f/g still blocked on user input.

---

## What shipped

### R48(d) — Lint regression fix in `lib/ingest/seed-on-demand.test.ts`

Pre-existing untracked test file carried five `// eslint-disable-next-line @typescript-eslint/no-explicit-any` directives. The repo's eslint config (`.eslintrc.json` extends `next/core-web-vitals` only) does NOT register the `@typescript-eslint/no-explicit-any` rule, so each disable directive itself triggered a lint error: *"Definition for rule '@typescript-eslint/no-explicit-any' was not found."*

Fix: stripped the five disable directives. The underlying `as any` casts are still in place (and are fine — `next/core-web-vitals` doesn't ban `any`); only the dead disable comments needed removing. `next lint` is clean again. Five tests in the file still pass unchanged.

Files: `lib/ingest/seed-on-demand.test.ts` (untracked → still untracked, just cleaner).

### R48(a) — Lift `KNOWN_PREFIXES` to a shared registry

R47(a) introduced an inline `KNOWN_PREFIXES` list inside `csp-report-rate-limit-drift.test.ts` for collision detection. R47 close noted the obvious duplication risk: as more rate-limited routes land (places R46(a), csp-report R47(a), dev/* R48(h) below, anticipated checkout/auth flows), the inline list becomes a copy-paste hazard. R48(a) lifts it into a single source of truth.

**Shipped:**

1. **NEW** `tests/helpers/rate-limit-prefixes.ts` — exports:
   - `KNOWN_PREFIXES: readonly string[]` — every `prefix:` value used in production code paths plus reserved-but-not-yet-wired prefixes (`checkout`, `auth`, `auth-magic-link`, `magic-link-resend`).
   - `KNOWN_PREFIX_SET: ReadonlySet<string>` — set form for `O(1)` lookups (kept in sync via the test file).
   - `isKnownPrefix(prefix)` — wrapper so future renames or shape validation land in one place.
   - `assertKnownPrefixesUnique()` / `assertKnownPrefixShape()` — registry sanity checks.
   - `PREFIX_SHAPE_RE` — locks the canonical lower-kebab-case shape (`/^[a-z][a-z0-9-]*[a-z0-9]$/`). A future maintainer landing `'CSP-Report'` or `'csp_report'` fails the audit at the registry boundary.

2. **NEW** `tests/helpers/rate-limit-prefixes.test.ts` (+8 tests). Walks `app/api/**/route.ts` and `lib/actions/*.ts` looking for `prefix: '<value>'` literals — any prefix found in real production code that's NOT registered fails the audit. `lib/security/rate-limit-auth.test.ts` and `lib/security/exports.test.ts` are intentionally NOT walked (they exercise the rate-limiter primitive with throwaway prefixes like `'test'`/`'sa'`).

3. **`csp-report-rate-limit-drift.test.ts` refactor** — removed the inline `KNOWN_PREFIXES` array; the audit now imports `isKnownPrefix` and asserts `csp-report` IS registered (the polarity flips: the registry is the canonical list, so a route's audit asserts INCLUSION rather than NON-inclusion against a hardcoded peer list). Same test count; tighter contract.

4. **`places-rate-limit-drift.test.ts` extension** (+1 test) — every prefix in `EXPECTED_ROUTES` (`places-autocomplete`, `places-details`) must be registered.

Files: `tests/helpers/rate-limit-prefixes.ts` (NEW), `tests/helpers/rate-limit-prefixes.test.ts` (NEW), `app/api/csp-report/csp-report-rate-limit-drift.test.ts`, `app/api/places/places-rate-limit-drift.test.ts`.

### R48(b) — Per-route Cache-Control attestation coverage

R44(c) (`route-response-headers-exact-shape.test.ts`) locks the VALUE of Cache-Control when a NON_CACHEABLE route sets it. A route that NEVER sets the header silently passes. That left an attestation gap: a future refactor could quietly drop both Cache-Control AND `force-dynamic`, and every existing audit would still pass. R48(b) closes the gap.

**Shipped:**

1. **NEW exports** in `tests/helpers/route-catalog.ts`:
   - `type CacheControlStrategy = 'explicit-no-store' | 'dynamic-only' | 'redirect-only'`.
   - `CACHE_CONTROL_ATTESTATION: Record<string, CacheControlStrategy>` — per-route declaration of HOW each NON_CACHEABLE route addresses Cache-Control. 18 entries (one per NON_CACHEABLE route): 3 `explicit-no-store` (cron/check-status, health, status), 13 `dynamic-only` (cron/retry-failed-calls, cron/send-reports, csp-report, dev/*, places/*, stripe/webhook, twilio/sms, vapi/*, get-quotes/claim), 2 `redirect-only` (auth/callback, auth/signout).
   - `assertAttestationCovers()` — throws if NON_CACHEABLE has any route without an attestation entry, or any attestation entry not in NON_CACHEABLE.

2. **NEW** `app/route-cache-control-attestation.test.ts` (+21 tests). Per-strategy locks:
   - **explicit-no-store** routes (3): MUST have a `'Cache-Control': '<canonical>'` literal pair.
   - **dynamic-only** routes (13): MUST export `dynamic = 'force-dynamic'` AND MUST NOT set Cache-Control (mismatched strategy is a real failure mode the audit catches).
   - **redirect-only** routes (2): MUST NOT set Cache-Control AND MUST NOT export `dynamic`.
   - Plus three meta-tests: every NON_CACHEABLE route is attested, attestation strategies are one of the three known values, and at least one route uses each strategy (anti-vacuous-pass tripwire).

Files: `tests/helpers/route-catalog.ts`, `app/route-cache-control-attestation.test.ts` (NEW).

### R48(c) — Stripe webhook FORBIDDEN_EVENT_TYPES expansion

R41(b) (`route-event-type-drift.test.ts`) locked 10 forbidden Stripe event types covering subscription / refund space. Stripe ships dozens more event families that fall outside our product scope (`tax.*`, `treasury.*`, `terminal.*`, `issuing.*`, `capital.*`, `climate.*`, `identity.*`, `billing_portal.*`, `subscription_schedule.*`, `mandate.*`, `setup_intent.*`, `invoiceitem.*`). R48(c) expands the list AND adds a family-level catch-all so events Stripe ships AFTER this audit was written still trip the lock.

**Shipped:**

1. **`FORBIDDEN_EVENT_TYPES` grew from 10 → 60 entries.** Each entry carries an inline reason in the surrounding comment block. Categories:
   - `invoice.*` — subscription billing (not sold).
   - `invoiceitem.*` — subscription line-item lifecycle (not used).
   - `customer.subscription.*` — subscription lifecycle (not sold).
   - `subscription_schedule.*` — subscription schedules (not used).
   - `refund.*` / `charge.refund*` — no refunds flow built (R39 retro: the "false refund promise" bug).
   - `tax.*` — Stripe Tax (not used).
   - `treasury.*` — Stripe Treasury (not used).
   - `terminal.*` — in-person Terminal hardware (not used).
   - `issuing_*` — card issuing (not used).
   - `capital.*` — Stripe Capital loans (not used).
   - `climate.*` — Stripe Climate carbon removal (not used).
   - `identity.*` — Stripe Identity KYC (not used).
   - `billing_portal.*` — Customer Portal (not used).
   - `mandate.*` — direct-debit mandates (not used).
   - `setup_intent.*` — saved payment methods for off-session charges (we charge once at checkout).

2. **NEW `FORBIDDEN_EVENT_FAMILIES`** — 16 prefix entries (each with trailing dot or underscore). The audit iterates every switch case and trips if any literal `startsWith(family)`. Catches new Stripe events Stripe ships in any forbidden category AFTER this audit was written.

3. **+5 tests** in `app/api/stripe/webhook/route-event-type-drift.test.ts` (15 → 20):
   - `R48(c) — no switch case matches a forbidden event-type family`.
   - `R48(c) — FORBIDDEN_EVENT_TYPES contains entries from each forbidden family (registry sanity)` — caught a real bug mid-round: I added `invoiceitem.` to the family list but no representative event in FORBIDDEN_EVENT_TYPES. Audit failed; I added three `invoiceitem.*` entries; audit passed.
   - `R48(c) — every FORBIDDEN_EVENT_TYPES entry is a syntactically valid Stripe event type` — locks shape `[a-z_]+(\.[a-z_]+)+`. A typo'd `'inviice.paid'` would silently match nothing and weaken the lock.
   - `R48(c) — FORBIDDEN_EVENT_TYPES has no duplicates`.
   - `R48(c) — EXPECTED_HANDLED and EXPECTED_ACK_ONLY are disjoint from FORBIDDEN_EVENT_TYPES` — a maintainer can't move an event into HANDLED while it's still FORBIDDEN.

Files: `app/api/stripe/webhook/route-event-type-drift.test.ts`.

### R48(h) — `api/dev/*` rate-limit defense-in-depth

R47 close documented the deliberate decision to leave `/api/dev/*` at single-layer auth (`assertDevToken` returns 404 in prod with no probe signal AND 401 on token mismatch). R48(h) adds a third layer: `assertRateLimit` AFTER `assertDevToken`. The ORDERING is the security-critical part — putting rate-limit BEFORE the dev-token check would let a flooder in prod observe 429 responses (a probe signal) where today they only see 404. AFTER the token check, every reject path is still 404 in prod; the limiter only fires once a token-holding caller is already through the gate.

**Shipped:**

1. **`app/api/dev/trigger-call/route.ts`** — added `assertRateLimit(req, { prefix: 'dev-trigger-call', limit: 30, windowMs: 60_000 })` AFTER `assertDevToken`.

2. **`app/api/dev/backfill-call/route.ts`** — added `assertRateLimit(req, { prefix: 'dev-backfill-call', limit: 30, windowMs: 60_000 })` AFTER `assertDevToken`.

3. **`app/api/dev/skip-payment/route.ts`** — added `assertRateLimit(req, { prefix: 'dev-skip-payment', limit: 30, windowMs: 60_000 })` AFTER `assertDevToken`.

4. **Three new prefixes registered** in `tests/helpers/rate-limit-prefixes.ts`: `dev-trigger-call`, `dev-backfill-call`, `dev-skip-payment`. Reserved at the registry boundary so a future maintainer who promotes one of these to prod can't reuse the prefix on a public route.

5. **NEW** `app/api/dev/dev-rate-limit-drift.test.ts` (+29 tests). Posterity lock per dev route:
   - Imports `assertDevToken` and `assertRateLimit`.
   - Exports the right async handler (`GET` / `POST`).
   - **`assertDevToken(req)` is invoked BEFORE `assertRateLimit(req, ...)`** — the no-probe-in-prod ordering. If a future PR moves rate-limit above the token check, this test fails with a precise message explaining why ordering matters.
   - Prefix matches the documented value AND is in `KNOWN_PREFIXES`.
   - `if-deny-return` short-circuit pattern (regex matches `const X = assertRateLimit(...); if (X) return X;`).
   - Numeric `limit` ∈ [10, 100] and `windowMs` ∈ [30s, 120s] (the bands; not exact values, so tuning doesn't churn the audit).
   - Plus two cross-route checks: distinct prefixes (no bucket fusion) and coverage of every route under `app/api/dev/`.

**Decision noted:** chose 30 calls / 60s as the band midpoint. Dev routes are hand-driven (one click in the address bar at a time) — even an aggressive testing session is well below 30/min. A token-holding script burning Vapi quota or hammering the call-batch trigger is the precise failure mode this catches; 30/min cuts that runaway loop fast while leaving plenty of headroom for normal use.

Files: `app/api/dev/trigger-call/route.ts`, `app/api/dev/backfill-call/route.ts`, `app/api/dev/skip-payment/route.ts`, `tests/helpers/rate-limit-prefixes.ts`, `app/api/dev/dev-rate-limit-drift.test.ts` (NEW).

---

## Verification

- **Full suite:** `vitest run` → **2172 / 130 passing** (R47 baseline: 2091 / 126). Net delta: +81 tests, +4 files.
- **Type check:** `tsc --noEmit` clean.
- **Lint:** `next lint` clean (regression from R47 → pre-R48 fixed in R48(d)).
- **npm audit:** identical to R47 (5 vulns: 4 moderate, 1 high — `next`, `postcss`, `uuid`, `svix`, `resend`; all cross-major; still blocked on user pre-approval).
- **Determinism:** 5/5 runs of R48-touched files: 119/119 pass every run.

Per-file delta:
| File | R47 close | R48 close | Δ |
|---|---|---|---|
| `tests/helpers/rate-limit-prefixes.test.ts` | — | 8 | +8 (NEW) |
| `tests/helpers/route-catalog.ts` (no test file delta — exports added) | — | — | — |
| `app/route-cache-control-attestation.test.ts` | — | 21 | +21 (NEW) |
| `app/api/dev/dev-rate-limit-drift.test.ts` | — | 29 | +29 (NEW) |
| `app/api/csp-report/csp-report-rate-limit-drift.test.ts` | 8 | 8 | 0 (refactor, not extension) |
| `app/api/places/places-rate-limit-drift.test.ts` | 14 | 15 | +1 |
| `app/api/stripe/webhook/route-event-type-drift.test.ts` | 15 | 20 | +5 |
| (Note) `lib/ingest/seed-on-demand.test.ts` | 5 (lint-failing) | 5 (lint-clean) | 0 (R48(d) fix) |

R48 measured baseline of 2108 included `lib/ingest/seed-on-demand.test.ts` (5 tests) and `tests/.debug/{debug,probe}.test.ts` (2 tests) that are not in the R47 close report. Subtracting those: the "real" R47 → R48 delta is **+74 tests in tracked work**, **+4 new test files**.

---

## Implementation notes for Round 49+

- **Sentry DSN capture-site count unchanged at ~43.** R48 shipped zero new capture sites.
- **`KNOWN_PREFIXES` is the canonical rate-limit prefix registry.** New rate-limited routes / actions MUST register here. The registry validates uniqueness and shape automatically. Walked production sources today: `app/api/**/route.ts` and `lib/actions/*.ts`. If a new namespace pattern emerges (e.g. cron-triggered actions), extend the walker in `tests/helpers/rate-limit-prefixes.test.ts` to include it.
- **`CACHE_CONTROL_ATTESTATION` is the per-route Cache-Control strategy registry.** Three strategies cover all current routes; if a route ever needs a fourth (e.g. `versioned-cacheable` for a future immutable-asset route), extend the type union AND add the matching positive-lock describe block in `app/route-cache-control-attestation.test.ts`. The "at least one route uses each strategy" tripwire prevents the audit from going stale on a deprecated strategy.
- **Stripe webhook is now locked at four granularities:** route-level (R38(b)), per-event-type-set (R41(b)), per-case-body (R47(c)), event-family forbidden-list (R48(c)). A new event added to `EXPECTED_HANDLED` must (a) be added to the audit, (b) use the canonical envelope, (c) NOT match any FORBIDDEN_EVENT_FAMILIES prefix, OR (d) update the audit explicitly to declare the new shape / family carve-out.
- **`api/dev/*` is now triple-layered:** NODE_ENV gate → DEV_TRIGGER_TOKEN match → rate limit. The ordering test in `dev-rate-limit-drift.test.ts` is the security-critical part of the audit; do not weaken it.
- **R47 close suggested item (g) "Sentry DSN wiring IF #1 arrives"** — still blocked on user input #1.
- **Prefix-shape rule** locked at `/^[a-z][a-z0-9-]*[a-z0-9]$/` — lower kebab-case, no leading/trailing dashes, no underscores. If a future `prefix:` literal lands that doesn't match, the registry's `assertKnownPrefixShape()` fires.

---

## Outstanding items requiring your input

**Count: 14** (unchanged from R47). Top 4 unchanged. R48 changed nothing in this list.

| # | Item | Value | Blocker |
|---|------|-------|---------|
| 1 | **Sentry DSN** | ~43 capture sites are wired but inert without a real DSN. Add `SENTRY_DSN` (and optionally `NEXT_PUBLIC_SENTRY_DSN`) to Vercel env. Free tier covers our pre-launch volume. | None — drop the value in. |
| 2 | **Next.js 14.3.x bump** (closes 6 CVEs) | `npm audit fix --force` would install Next 16.2.4 — cross-major bump. Need pre-approval to run + test. | Your call on cross-major bump risk. |
| 3 | **Resend bump** (closes 1 high CVE in svix dep tree) | Same shape as #2 — `npm audit fix --force` would push to 6.1.3 cross-major. | Your call. |
| 4 | **Daily-report archival policy** | `docs/` now shows R31–R48 (18 reports). Suggested: keep last ~10 at top level, archive the rest. | Want a strict date cutoff (e.g., > 7 days)? Or count-based rolling policy? |
| 5–12 | Pre-launch checklist confirmations | Various — see prior reports. | You. |
| 13 | R42 `tests/.debug/` scratch files | `tests/.debug/probe.test.ts` and `tests/.debug/debug.test.ts` are harmless no-ops left over from R42(b) build-out. Sandbox can't delete them. | Run `rm -rf tests/.debug/ scripts/debug-walker.mts` locally when convenient. |
| 14 | `scripts/archive-daily-reports.ts` | Can land once #4 is decided. | Depends on #4. |

**Highest leverage:** still #1 (Sentry DSN). 43 capture sites would activate immediately.

---

## Suggested next autonomous run (Round 49)

(a) **Cron route rate-limit / origin-pinning audit.** Three cron routes (`cron/check-status`, `cron/retry-failed-calls`, `cron/send-reports`) currently use `assertCronAuth` (R43(b) locks the parity / ordering). Vercel cron requests carry a known IP range; we could lock that as a defense-in-depth layer mirroring R48(h)'s pattern. ~45 min. Feasibility-check first — Vercel rotates the cron IP range, so this might be overhead for low value.

(b) **`lib/actions/*.ts` rate-limit registry coverage extension.** R48(a)'s walker looks at `lib/actions/*.ts`. Currently only `waitlist.ts` calls `assertRateLimitFromHeaders`. If checkout / auth server actions land before R49, they automatically get audit coverage; if they DON'T land, this is a no-op. Lower priority. ~15 min.

(c) **Vapi webhook event-type drift audit (R41 analog for Vapi).** Stripe webhook has a tight allow-list audit at four granularities (R38(b), R41(b), R47(c), R48(c)). The Vapi webhook handles `end-of-call-report` and a few transient events; the same pattern would lock the surface. ~45 min.

(d) **Per-route methods catalog consolidation.** `route-handler-exports-drift.test.ts` `EXPECTED_ROUTES` declares method sets per route inline. If a new pattern emerges (e.g. POST + DELETE on the same route), the catalog could cleanly express it via a shared `Methods` type. ~30 min. Low priority unless a multi-method route lands.

(e) **Test debug scratch removal** — IF item #13 (`tests/.debug/`) gets resolved manually, drop the two no-op tests. ~5 min cleanup.

(f) **Next.js + Resend CVE bump** IF pre-approved (#2/#3). ~45 min.

(g) **Preview-deploy smoke run** IF scheduled. Human-gated.

(h) **Sentry DSN wiring** IF #1 arrives. ~15 min — flips ~43 capture sites from inert to active in one commit.

(i) **`tests/helpers/route-catalog.ts` extension to lock `dynamic` export shape.** R42(c) per-route config catalog locks methods; extending it to lock the `dynamic = 'force-dynamic'` literal across ALL `dynamic-only` routes (currently scattered across 13 sources) would centralize one more drift class. ~30 min.

---

*Report generated by R48 autonomous scheduled run. All claims verified by `vitest run` (2172/130), `tsc --noEmit`, `next lint`, and a 5/5 determinism check on R48-touched files (119/119 every run).*
