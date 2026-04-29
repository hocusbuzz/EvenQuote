# Daily Report — 2026-04-25 (Round 46)

**Run type:** autonomous scheduled run
**Baseline (R45 close):** 2024 tests / 123 files; tsc clean; lint clean; 5 vulns (4 moderate, 1 high)
**Final (R46 close):** 2067 tests / 125 files; tsc clean; lint clean; 5 vulns (unchanged)
**Delta:** +43 tests, +2 files; one walker blind-spot fix; one masked drift caught + fixed.

---

## What shipped

### R46(a) — Google Places proxy hardening + EXPECTED_SHAPES lock

R45 close flagged that `app/api/places/autocomplete/route.ts` and `app/api/places/details/route.ts` had **no rate limiting** today. Both fronts a paid Google Places API; a single bot can burn our daily quota. Both routes also previously sat on the `route-response-shape-drift` allowlist with a "TODO: lock once stable" comment.

Shipped:

1. **Rate limiting added** to both GET handlers via `assertRateLimit(req, ...)` (the existing `lib/security/rate-limit-auth.ts` helper). Per-route prefixes:
   - `places-autocomplete`: 60 req / 60s / IP — generous because real users fire ~12 keystrokes across three address fields.
   - `places-details`: 30 req / 60s / IP — tighter, called once per address pick.
2. **EXPECTED_SHAPES lock** added for both routes in `app/route-response-shape-drift.test.ts`. Removed them from the allowlist. The details route was refactored from `{ ...parsed, formatted }` spread to spelling out every key (`address_line`, `city`, `state`, `zip_code`, `country`, `formatted`) so the shape audit can verify the contract.
3. **NEW** `app/api/places/places-rate-limit-drift.test.ts` (+14 tests). Posterity lock: each route MUST import `assertRateLimit`, use the documented prefix, place the rate-limit check BEFORE any other call (so a spammer can't drain quota with malformed requests), and use limits within documented bands. Distinct-prefix check prevents bucket fusion. Coverage-tripwire fails if a new route is added under `app/api/places/` without being locked.

Files: `app/api/places/autocomplete/route.ts`, `app/api/places/details/route.ts`, `app/route-response-shape-drift.test.ts`, `app/api/places/places-rate-limit-drift.test.ts` (NEW).

### R46(b) — Env-var email primitive (`EnvEmailSchema`)

R45(d) `zod-shared-primitive-drift.test.ts` had `lib/env.ts` on its EMAIL_ALLOWLIST because env-var validation deliberately uses a LOOSE chain (`z.string().email()` without `.trim()`/`.toLowerCase()`) — env vars are operator-set, not user input, and silent normalization would mask a deploy-time typo.

Shipped:

1. **NEW** `EnvEmailSchema` in `lib/forms/moving-intake.ts` — `z.string().email()` with no normalization. Comment explains the operator-vs-user-input distinction.
2. `lib/env.ts` now imports + uses `EnvEmailSchema` for `EVENQUOTE_SUPPORT_EMAIL` (was inline `z.string().email()`).
3. R45(d) audit updated: removed `lib/env.ts` from EMAIL_ALLOWLIST. Replaced the "uses allow-listed loose chain" attestation test with a positive lock — `lib/env.ts` MUST `import { EnvEmailSchema }` AND use it AND not contain inline `z.string().email(`. Added a complementary test asserting `EnvEmailSchema` is exactly `z.string().email()` in `moving-intake.ts` (no drift toward the canonical chain).

Files: `lib/forms/moving-intake.ts`, `lib/env.ts`, `lib/forms/zod-shared-primitive-drift.test.ts`.

### R46(c) — Walker re-run + new blind spot found and fixed

R45(a) lifted the nested-template blind spot in `tests/helpers/source-walker.ts`. Per the established R44(d) pattern ("after lifting a walker blind spot, re-run ALL audits that depend on it"), I re-ran every walker-dependent audit (13 files, 327 tests). All passed.

Then I added a regression sentinel: a synthetic source combining BOTH the R43(a) regex-with-apostrophe blind spot AND the R45(a) nested-template blind spot in one exported function. **The walker returned `null`** — surfacing a third, previously-undetected blind spot.

**Root cause:** `extractExportedAsyncFunctionBody`'s brace-walker handles strings + templates + substitutions but never received R43(a)'s regex-literal awareness. The pre-stripped source still contained `/'/g` literally; the walker hit the apostrophe inside the regex and opened a fake single-quoted string that ran until the next real apostrophe (typically inside a nested template), throwing off the brace count.

Why this didn't surface before: the canonical example (`lib/email/templates.ts`) places `replace(/'/g, ...)` inside the (un-exported) `escapeHtml` helper, NOT inside the exported renderer bodies the walker visits. So no real subject ever tripped both blind spots simultaneously — until R46(c)'s synthetic test.

Shipped:

1. **Walker fix.** `extractExportedFunctionBodyImpl`'s brace-walker now invokes `canStartRegex` + `skipRegexLiteral` when in a code frame, mirroring the R43(a) implementation in `stripCommentsPreservingPositions`. Localized change; no behavior diff for any subject without regex-with-apostrophe + nested-template combo.
2. **Regression sentinel** in `tests/helpers/source-walker.test.ts`: combined-blind-spot synthetic fixture. +1 test (34 → 35).
3. Re-ran all walker-dependent audits; all 327 tests still pass.

Files: `tests/helpers/source-walker.ts`, `tests/helpers/source-walker.test.ts`.

### R46(d) — Route-catalog source-of-truth consolidation

R45's Places-proxy add-on touched FOUR catalog-driven audits:
- `route-handler-exports-drift.test.ts` EXPECTED_ROUTES
- `route-response-headers-drift.test.ts` NON_CACHEABLE
- `route-response-shape-drift.test.ts` allowlist
- `route-reason-audit.test.ts` EXPECTED_REASONLESS_ROUTES

But it MISSED a fifth catalog: `route-response-headers-exact-shape.test.ts` (R44(c)) had its own `NON_CACHEABLE` set duplicating R43(c)'s with a comment "Duplicating them here costs a few lines of maintenance but keeps this audit independently runnable." That comment aged poorly: the Places routes were silently exempted from the exact-shape lock for an entire round.

**This is exactly the drift class consolidation prevents.**

Shipped:

1. **NEW** `tests/helpers/route-catalog.ts` — single source of truth. Exports:
   - `NON_CACHEABLE` (Set), `CACHEABLE_VERSION` (Set)
   - `CANONICAL_NO_STORE` ('no-store, no-cache, must-revalidate, max-age=0')
   - `CANONICAL_VERSION_CACHE_CONTROL` ('public, s-maxage=60, stale-while-revalidate=120')
   - `walkRouteFiles(root)` (the route discovery walk, lifted from two duplicate impls)
   - `assertCatalogPathsExist()`, `assertCatalogsDisjoint()` (sanity helpers)
2. `route-response-headers-drift.test.ts` and `route-response-headers-exact-shape.test.ts` now import from the catalog. Local copies removed. Catalog-sanity tests added inline.
3. **NEW** `tests/helpers/route-catalog.test.ts` (+11 tests). Locks: every cataloged path exists; sets are disjoint; catalog covers every `route.ts` under `app/`; canonical strings haven't drifted; `walkRouteFiles` returns sorted absolute paths and handles non-existent roots cleanly. Includes a specific R45-regression test asserting every route under `app/api/places/` is in NON_CACHEABLE.
4. **Drift caught.** `route-response-headers-exact-shape.test.ts` grew 34 → 38 tests (+4 = 2 places routes × 2 per-route tests). The Places routes are now exact-shape locked.

Files: `tests/helpers/route-catalog.ts` (NEW), `tests/helpers/route-catalog.test.ts` (NEW), `app/route-response-headers-drift.test.ts`, `app/route-response-headers-exact-shape.test.ts`.

---

## Verification

- **Full suite:** `vitest run` → 2067 / 125 passing (R45 baseline: 2024 / 123).
- **Type check:** `tsc --noEmit` clean.
- **Lint:** `next lint` clean.
- **npm audit:** identical to R45 (5 vulns: 4 moderate, 1 high — `next`, `postcss`, `uuid`, `svix`, `resend`; all cross-major; still blocked on user pre-approval).
- **Determinism:** 5/5 runs of R46-touched files: 223/223 pass every run.

---

## Implementation notes for Round 47+

- **Sentry DSN capture-site count unchanged at ~43.** R46 shipped zero new capture sites.
- **Walker has a third fix on top of R43(a) + R45(a).** Brace-walker is now regex-literal-aware. Future audits using `extractExportedAsyncFunctionBody` / `extractExportedFunctionBody` get the fix for free.
- **Route catalog is now the single source of truth.** Adding a new route is now a one-edit operation in `tests/helpers/route-catalog.ts`. The other route audits (`EXPECTED_ROUTES`, EXPECTED_SHAPES, EXPECTED_REASONLESS_ROUTES) still maintain per-route specs but should consider migrating to import membership-only data from this catalog in a future round.
- **`EnvEmailSchema` is the canonical loose-chain primitive.** Future env-var emails should use it; the audit fails if a new inline `z.string().email(` appears in `lib/env.ts`.
- **R46 file-scoped impact:** every R46(a–d) item now has both a code change AND a posterity test that locks the change. None of the changes is reversible without a corresponding test edit.

---

## Outstanding items requiring your input

**Count: 14** (unchanged from R45). Top 4 unchanged.

| # | Item | Value | Blocker |
|---|------|-------|---------|
| 1 | **Sentry DSN** | ~43 capture sites are wired but inert without a real DSN. Add `SENTRY_DSN` (and optionally `NEXT_PUBLIC_SENTRY_DSN`) to Vercel env. Free tier covers our pre-launch volume. | None — drop the value in. |
| 2 | **Next.js 14.3.x bump** (closes 6 CVEs) | `npm audit fix --force` would install Next 16.2.4 — cross-major bump. Need pre-approval to run + test. | Your call on cross-major bump risk. |
| 3 | **Resend bump** (closes 1 high CVE in svix dep tree) | Same shape as #2 — `npm audit fix --force` would push to 6.1.3 cross-major. | Your call. |
| 4 | **Daily-report archival policy** | R40 created `docs/DAILY_REPORT_ARCHIVE/`. Today's `docs/` shows R31–R46 (16 reports). What's the cutoff for moving older reports? Suggested: keep last ~10 at top level, archive the rest. | Want a strict date cutoff (e.g., > 7 days)? Or a count-based rolling policy? |
| 5–12 | Pre-launch checklist confirmations | Various — see prior reports. | You. |
| 13 | R42 `tests/.debug/` scratch files | `tests/.debug/probe.test.ts` and `tests/.debug/debug.test.ts` are harmless no-ops left over from R42(b) build-out. Sandbox can't delete them. | Run `rm -rf tests/.debug/ scripts/debug-walker.mts` locally when convenient. |
| 14 | `scripts/archive-daily-reports.ts` | Can land once #4 is decided. | Depends on #4. |

**Highest leverage:** still #1 (Sentry DSN). 43 capture sites would activate immediately.

---

## Suggested next autonomous run (Round 47)

(a) **Backfill rate limiting** to other unrate-limited routes. R46(a) covered Places; the dev-token-gated routes (`api/dev/*`) and CSP-report (`api/csp-report`) might benefit. ~30 min.

(b) **EXPECTED_ROUTES catalog migration** to import membership from `route-catalog.ts`. R46(d) consolidated NON_CACHEABLE; the per-route spec catalogs (methods, config, response shapes) are still file-scoped. Merging to a master catalog is the natural next step. ~45 min.

(c) **Stripe webhook event-type drift extension** — R41(b) locked the allow-list shape. Could extend to lock the per-event handler return shape so a future event type added to EXPECTED_HANDLED also gets a return-shape lock. ~30 min.

(d) **Test debug scratch removal** — IF item #13 (`tests/.debug/`) gets resolved manually, the audits can drop their two no-op tests. ~5 min cleanup.

(e) **Next.js + Resend CVE bump** IF pre-approved (#2/#3). ~45 min.

(f) **Preview-deploy smoke run** IF scheduled — first real exercise of R34's `smoke-webhook-preview`. Human-gated.

(g) **Sentry DSN wiring** IF #1 arrives — flip ~43 capture sites from inert to active in one commit. ~15 min.

---

*Report generated by R46 autonomous scheduled run. All claims verified by `vitest run` (2067/125), `tsc --noEmit`, `next lint`, and a 5/5 determinism check on R46-touched files.*
