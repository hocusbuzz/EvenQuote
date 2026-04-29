# Daily Report — 2026-04-26 (Round 47)

**Run type:** autonomous scheduled run
**Baseline (R46 close):** 2067 tests / 125 files; tsc clean; lint clean; 5 vulns (4 moderate, 1 high)
**Final (R47 close):** 2091 tests / 126 files; tsc clean; lint clean; 5 vulns (unchanged)
**Delta:** +24 tests, +1 file. Three suggested R47 items shipped (a, b, c). Item d (test debug scratch removal) and items e/f/g (dependency bumps, smoke run, Sentry DSN) remain blocked on user input.

---

## What shipped

### R47(a) — Rate-limit backfill on `/api/csp-report`

R46 close suggested backfilling rate limiting to remaining unrate-limited routes. After audit, the dev-token-gated routes (`api/dev/trigger-call`, `api/dev/backfill-call`, `api/dev/skip-payment`) ALREADY have a strong defense layer — `assertDevToken` returns 404 in production with no probe signal AND 401 on token mismatch — so adding a third layer there returned diminishing security value relative to the intervention's cost. **The CSP-report endpoint, by contrast, is a fully public POST sink** that browsers hit on every CSP violation. A misconfigured page (or hostile actor pointing reports at us) could flood the structured log drain at browser-violation frequency and, when `CSP_VIOLATIONS_PERSIST=true`, hammer the `csp_violations` insert path with browser-frequency writes.

Shipped:

1. **Rate limiting added** to `app/api/csp-report/route.ts` POST handler via `assertRateLimit(req, ...)`. Prefix `csp-report`. Limits: **200 calls / 60s / IP**. Generous because a heavy page can legitimately fire 50+ reports on one load and a real user reloading rapidly might cross 100; 200 keeps headroom for genuine browser bursts while cutting log-flood attacks at the route boundary. Check goes BEFORE the existing `MAX_BODY_BYTES = 64 * 1024` size cap — both are early rejects, but rate-limit is the cheaper of the two AND covers requests with bogus / missing content-length headers (which the size cap silently lets through).

2. **NEW** `app/api/csp-report/csp-report-rate-limit-drift.test.ts` (+8 tests). Posterity lock: route MUST import `assertRateLimit` from `@/lib/security/rate-limit-auth`, invoke it as the FIRST call in the POST body, use prefix `'csp-report'`, use the documented `if (deny) return deny;` short-circuit, pass numeric `limit` and `windowMs` within documented bands (limit ∈ [100, 500], windowMs ∈ [30s, 120s]), AND keep the rate-limit check above the body-size early-reject. Includes a prefix-collision sanity check against a hardcoded list of known prefixes (`places-autocomplete`, `places-details`, `waitlist`, `checkout`, `auth`, `auth-magic-link`).

**Decision noted:** `api/dev/*` routes were left at single-layer auth (`assertDevToken`). A future round can add rate limiting AFTER the dev-token check (preserving the no-probe-in-prod property) if defense-in-depth against authed dev-token leakage becomes a concern. This is documented in the daily report rather than the code so the design choice is recoverable.

Files: `app/api/csp-report/route.ts`, `app/api/csp-report/csp-report-rate-limit-drift.test.ts` (NEW).

### R47(b) — Per-route catalog migration to `route-catalog.ts`

R46(d) consolidated `NON_CACHEABLE` / `CACHEABLE_VERSION` / canonical Cache-Control strings into `tests/helpers/route-catalog.ts`. The per-route SPEC catalogs (`route-handler-exports-drift.test.ts` `EXPECTED_ROUTES`, `route-response-shape-drift.test.ts` `EXPECTED_SHAPES`, `route-reason-audit.test.ts` `EXPECTED_REASONLESS_ROUTES`) still maintained their own duplicate membership lists. Each used a slightly different path format:

| Audit | Format | Example |
|---|---|---|
| `route-handler-exports-drift` | catalog format | `app/api/health/route.ts` |
| `route-response-shape-drift` | path-inside-app/ | `api/health/route.ts` |
| `route-reason-audit` | route segment | `stripe/webhook` |

Force-unifying all three would have churned dozens of per-route specs for a small consistency win. Instead, R47(b) adds a derived `ALL_ROUTES` export plus two path-format helpers, then has each audit assert MEMBERSHIP consistency against the catalog without changing its local format.

Shipped:

1. **NEW exports** in `tests/helpers/route-catalog.ts`:
   - `ALL_ROUTES: ReadonlySet<string>` — union of `NON_CACHEABLE` and `CACHEABLE_VERSION`. Adding a route to either subset auto-propagates to `ALL_ROUTES`.
   - `toAppRelative(catalogPath)` — strips leading `app/` (used by `route-response-shape-drift`).
   - `toRouteSegment(catalogPath)` — strips both `app/` and `/route.ts` (used by `route-reason-audit`).
   - Both helpers validate input shape and throw on malformed paths so a typo can't silently no-op.

2. **`route-catalog.test.ts` extended** (+7 tests, 11 → 18):
   - `ALL_ROUTES` is the union of `NON_CACHEABLE` + `CACHEABLE_VERSION`.
   - `ALL_ROUTES` covers every `route.ts` under `app/` (no missing, no ghosts).
   - `toAppRelative` and `toRouteSegment` round-trip correctly and throw on malformed input.
   - Every `ALL_ROUTES` entry is syntactically a valid catalog path (`app/.../route.ts`).

3. **`route-handler-exports-drift.test.ts` consistency lock** (+1 test). Asserts `Object.keys(EXPECTED_ROUTES) === [...ALL_ROUTES]` (set equality). Adding a new route to `route-catalog.ts` now fails this audit until `EXPECTED_ROUTES` is updated — the failure mode is loud and pinpoints which catalog needs the edit.

4. **`route-response-shape-drift.test.ts` membership tripwire** (+1 test). Verifies every `EXPECTED_SHAPES.file` (path-inside-app/) maps to a known `ALL_ROUTES` entry when prepended with `app/`. Catches a typo'd shape entry that would silently skip per-route assertions because `fs.readFileSync` would throw on a typo'd path BUT in this audit the per-route iteration is wrapped in a way that... actually no, it's a tighter check: a typo in the shape's `file:` field doesn't error, just skips coverage.

5. **`route-reason-audit.test.ts` consistency lock** (+2 tests). `EXPECTED_REASONLESS_ROUTES` uses route-segment format (`stripe/webhook`). Test maps each segment to `app/api/${seg}/route.ts` and verifies membership in `ALL_ROUTES` — a typo silently turns off the reasonless-route exemption. Plus a sanity test that `toRouteSegment` round-trips for every `app/api/*` catalog entry.

**Net effect:** adding a new route is now a one-edit operation in `route-catalog.ts`. Three audit failures point exactly where to add the per-route spec next. Drift across catalogs is impossible to land silently.

Files: `tests/helpers/route-catalog.ts`, `tests/helpers/route-catalog.test.ts`, `app/route-handler-exports-drift.test.ts`, `app/route-response-shape-drift.test.ts`, `app/route-reason-audit.test.ts`.

### R47(c) — Stripe webhook event-type return-shape extension

R41(b) (`route-event-type-drift.test.ts`) locked the SET of event types in the Stripe webhook switch (`EXPECTED_HANDLED`, `EXPECTED_ACK_ONLY`, `FORBIDDEN_EVENT_TYPES`). It did NOT lock the per-case return shape. A future PR adding a new event to `EXPECTED_HANDLED` with a different envelope shape (e.g., `{ ok: true }` instead of the canonical `{ received: true, eventId, note? }`) would silently break Stripe's retry idempotency — Stripe's dashboard reads `received` to confirm delivery. R38(b) (`route-response-shape-drift`) locked the route-level shape; R47(c) tightens it to per-case granularity.

Shipped:

1. **+5 tests** in `app/api/stripe/webhook/route-event-type-drift.test.ts` (10 → 15). Helpers `extractCaseBody(literal)` and `extractDefaultBody()` parse case bodies from the stripped switch source.
   - **Per-handled-case envelope lock**: every `EXPECTED_HANDLED` case must `NextResponse.json` with `received: true`, `eventId:`, and no explicit `status:` (200 is implicit).
   - **Shared ack-only branch envelope**: the single ack-only return body must include the canonical envelope AND a note literal matching `/Ignored event type/i`.
   - **Default-case envelope**: same canonical envelope. R41(b) already locked no-4xx/no-5xx; R47(c) adds shape lock.
   - **Switch-wide non-2xx scan**: walks the entire switch body (matching brace tracking) and asserts NO branch returns `status:` outside the 200 family. Stripe retries on non-200; a creative refactor that adds `202`/`204`/`410` would trigger the retry storm we already lock against.
   - **`OkResponse` type alias lock**: regex-matches the type alias declaration `type OkResponse = { received: true; eventId: string; note?: string };` so a future loosening (e.g., `received: boolean`) can't slip past TypeScript's structural checking.

2. The `OkResponse` test is whitespace-tolerant and accepts both `;` and `,` field separators — the audit doesn't churn on cosmetic edits.

Files: `app/api/stripe/webhook/route-event-type-drift.test.ts`.

---

## Verification

- **Full suite:** `vitest run` → **2091 / 126 passing** (R46 baseline: 2067 / 125). Net delta: +24 tests, +1 file.
- **Type check:** `tsc --noEmit` clean.
- **Lint:** `next lint` clean.
- **npm audit:** identical to R46 (5 vulns: 4 moderate, 1 high — `next`, `postcss`, `uuid`, `svix`, `resend`; all cross-major; still blocked on user pre-approval).
- **Determinism:** 5/5 runs of R47-touched files: 224/224 pass every run.

Per-file delta:
| File | R46 close | R47 close | Δ |
|---|---|---|---|
| `app/api/csp-report/csp-report-rate-limit-drift.test.ts` | — | 8 | +8 (NEW) |
| `tests/helpers/route-catalog.test.ts` | 11 | 18 | +7 |
| `app/route-handler-exports-drift.test.ts` | 120 | 121 | +1 |
| `app/route-response-shape-drift.test.ts` | 48 | 49 | +1 |
| `app/route-reason-audit.test.ts` | 11 | 13 | +2 |
| `app/api/stripe/webhook/route-event-type-drift.test.ts` | 10 | 15 | +5 |

---

## Implementation notes for Round 48+

- **Sentry DSN capture-site count unchanged at ~43.** R47 shipped zero new capture sites.
- **Route catalog is now the single membership source-of-truth across four audits.** `ALL_ROUTES` is derived from `NON_CACHEABLE` + `CACHEABLE_VERSION`. Adding a route is a one-edit operation; each consuming audit fails loudly on drift. The path-format helpers (`toAppRelative`, `toRouteSegment`) absorb the format-difference between audits without forcing a churn-heavy unification.
- **Stripe webhook envelope is now locked at three granularities**: route-level (R38(b)), per-event-type-set (R41(b)), per-case-body (R47(c)). A future event added to `EXPECTED_HANDLED` must (a) be added to the audit, (b) use the canonical envelope, OR (c) update the audit to declare a new shape.
- **CSP-report rate limit prefix `csp-report` is in the known-prefixes registry inline in the audit.** When adding more rate-limited routes (e.g., dev routes if defense-in-depth ever lands), update the `KNOWN_PREFIXES` array in `csp-report-rate-limit-drift.test.ts` AND `places-rate-limit-drift.test.ts` so collision detection stays current. A future refactor could lift this list to a shared catalog (`tests/helpers/rate-limit-prefixes.ts`) — candidate for R49+ if the list grows past ~10 entries.
- **`api/dev/*` routes are still single-layer auth.** They have NODE_ENV gate (404 in prod) + DEV_TRIGGER_TOKEN (401 on mismatch). Adding rate limiting AFTER the dev-token check (preserving no-probe-in-prod) is a future option but not an immediate need. Documented here so the choice is recoverable.

---

## Outstanding items requiring your input

**Count: 14** (unchanged from R46). Top 4 unchanged.

| # | Item | Value | Blocker |
|---|------|-------|---------|
| 1 | **Sentry DSN** | ~43 capture sites are wired but inert without a real DSN. Add `SENTRY_DSN` (and optionally `NEXT_PUBLIC_SENTRY_DSN`) to Vercel env. Free tier covers our pre-launch volume. | None — drop the value in. |
| 2 | **Next.js 14.3.x bump** (closes 6 CVEs) | `npm audit fix --force` would install Next 16.2.4 — cross-major bump. Need pre-approval to run + test. | Your call on cross-major bump risk. |
| 3 | **Resend bump** (closes 1 high CVE in svix dep tree) | Same shape as #2 — `npm audit fix --force` would push to 6.1.3 cross-major. | Your call. |
| 4 | **Daily-report archival policy** | `docs/` now shows R31–R47 (17 reports). Suggested: keep last ~10 at top level, archive the rest. | Want a strict date cutoff (e.g., > 7 days)? Or count-based rolling policy? |
| 5–12 | Pre-launch checklist confirmations | Various — see prior reports. | You. |
| 13 | R42 `tests/.debug/` scratch files | `tests/.debug/probe.test.ts` and `tests/.debug/debug.test.ts` are harmless no-ops left over from R42(b) build-out. Sandbox can't delete them. | Run `rm -rf tests/.debug/ scripts/debug-walker.mts` locally when convenient. |
| 14 | `scripts/archive-daily-reports.ts` | Can land once #4 is decided. | Depends on #4. |

**Highest leverage:** still #1 (Sentry DSN). 43 capture sites would activate immediately.

---

## Suggested next autonomous run (Round 48)

(a) **Lift `KNOWN_PREFIXES` to a shared registry** — `tests/helpers/rate-limit-prefixes.ts`. Hardcoded list lives in two audits today; a third would justify the lift. ~30 min.

(b) **Per-route Cache-Control exact-shape extension to ALL_ROUTES.** R44(c) `route-response-headers-exact-shape.test.ts` already imports from the catalog; verify per-route attestation coverage is complete (i.e., every NON_CACHEABLE route either explicitly sets the canonical no-store OR is documented as not setting it). ~30 min.

(c) **Stripe webhook FORBIDDEN_EVENT_TYPES expansion.** Today: 10 forbidden event types covering subscription / refund space. Stripe's webhook event catalog has dozens more (e.g., `tax.*`, `treasury.*`, `terminal.*`, `issuing.*`). Audit current Stripe surface and add any obviously-out-of-scope event families to FORBIDDEN, with a comment per family. ~45 min.

(d) **Test debug scratch removal** — IF item #13 (`tests/.debug/`) gets resolved manually, the audits can drop their two no-op tests. ~5 min cleanup.

(e) **Next.js + Resend CVE bump** IF pre-approved (#2/#3). ~45 min.

(f) **Preview-deploy smoke run** IF scheduled — first real exercise of R34's `smoke-webhook-preview`. Human-gated.

(g) **Sentry DSN wiring** IF #1 arrives — flip ~43 capture sites from inert to active in one commit. ~15 min.

(h) **`api/dev/*` rate-limit defense-in-depth.** Lower priority; would add `assertRateLimit` AFTER `assertDevToken` in the three dev routes, preserving the no-probe-in-prod property. ~30 min.

---

*Report generated by R47 autonomous scheduled run. All claims verified by `vitest run` (2091/126), `tsc --noEmit`, `next lint`, and a 5/5 determinism check on R47-touched files (224/224 every run).*
