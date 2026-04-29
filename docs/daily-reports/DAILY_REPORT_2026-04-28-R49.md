# Daily Report — 2026-04-28 (Round 49)

**Run type:** autonomous scheduled run
**Baseline (R48 close):** 2172 tests / 130 files; tsc clean; lint clean; 5 vulns (4 moderate, 1 high)
**Pre-R49 measured:** 2203 tests / 130 files; tsc clean; lint clean; 5 vulns (unchanged). +31 tests vs R48 close came from untracked R48-era files (`lib/ingest/seed-on-demand.test.ts`, `tests/.debug/*`, route-handler test backfills) that landed without report-level mention; subtracting those, the R48-close-to-pre-R49 delta is effectively zero.
**Final (R49 close):** 2273 tests / 132 files; tsc clean; lint clean; 5 vulns (unchanged)
**Delta vs. R48 close:** +101 tests, +2 files. Three items shipped (R49(b), R49(c), R49(i)). One item shipped as research-only (R49(a)). One item flagged for next round (R49(b) sandbox cleanup).

---

## What shipped

### R49(c) — Vapi webhook event-type drift audit

R47(c) and R48(c) tightened the Stripe webhook to four granularities (route-level, per-event-type-set, per-case-body, family-level forbidden). The Vapi webhook had nothing equivalent. R49(c) brings it to parity, with the parser shape adapted for Vapi's structure.

Vapi's webhook is structurally simpler than Stripe's: instead of `switch (event.type)`, it does a single `if (msg.type !== 'end-of-call-report')` early-reject. So the audit doesn't walk `case` literals — it walks `msg.type [!=]== '<literal>'` comparisons.

**Shipped:**

1. **NEW** `app/api/vapi/webhook/route-event-type-drift.test.ts` (+17 tests). Locks:
   - **`EXPECTED_HANDLED = {end-of-call-report}`** — the only Vapi message type the route may act on.
   - **`FORBIDDEN_MESSAGE_TYPES`** (12 entries) — Vapi-documented event families we must not start handling without an explicit registry edit (`function-call`, `tool-calls`, `assistant-request`, `transcript`, `speech-update`, `status-update`, `conversation-update`, `user-interrupted`, `voice-input`, `model-output`, `phone-call-control`, `hang`). Most of these stream multiple times per call; handling any of them on a webhook would either bury the database in writes or interpret a transient signal as terminal.
   - **`VAPI_TYPE_SHAPE_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/`** — same canonical lower-kebab-case shape used by `tests/helpers/rate-limit-prefixes.ts` (PREFIX_SHAPE_RE). A typo'd entry in either map fails the audit at the registry boundary.
   - **Auth-before-parse ordering**: `verifyVapiWebhook(req)` must appear in source BEFORE `req.json(...)`. A flooder must not be able to make us parse 1MB request bodies against an unauthed request.
   - **JSON parse wrapped in try/catch returning 400** — malformed JSON should never throw to the framework default 500 (Vapi would retry forever).
   - **Non-handled branch returns 200** (locked via regex on the early-reject statement) — Vapi must not retry on a known-ignored type.
   - **Missing `call.id` returns 400** — malformed payload, not a retry trigger.
   - **Handler-error branch returns 500 AND invokes `captureException`** with `route: 'vapi/webhook'` tag — the silent-failure path Antonio explicitly flagged in route.ts ("a paid user gets an empty report").
   - **`dynamic = 'force-dynamic'` and `runtime = 'nodejs'`** locks (defense-in-depth alongside R49(i) below).
   - **Cross-source consistency lock**: the `VapiEndOfCallReport.type` discriminant in `lib/calls/apply-end-of-call.ts` MUST match `EXPECTED_HANDLED`. A future refactor to a different literal would silently exclude every valid payload at the route gate.

Files: `app/api/vapi/webhook/route-event-type-drift.test.ts` (NEW).

### R49(i) — Per-route `dynamic` and `runtime` export VALUE drift audit

R42(c) (`route-handler-exports-drift.test.ts`) locks the SET of route-segment-config exports per route — every route must declare `'dynamic'` and `'runtime'` in the export list, but R42(c) does NOT lock the VALUES those exports carry. A maintainer hand-editing `dynamic = 'force-static'` on a webhook (a real, type-valid Next.js value) would silently make it page-cacheable; R42(c) sees the export and is satisfied. R48(b) catches strategy mismatch but locks Cache-Control and the absence/presence of `dynamic`, not its literal value. R44(c) locks the Cache-Control value but not `dynamic`. So pre-R49(i), there was no test that fails if `app/api/stripe/webhook/route.ts` ships with `dynamic = 'force-static'`.

**Shipped:**

1. **NEW exports** in `tests/helpers/route-catalog.ts`:
   - `CANONICAL_DYNAMIC = 'force-dynamic'` and `CANONICAL_RUNTIME = 'nodejs'` — named constants for the canonical values our codebase uses.
   - `DYNAMIC_EXPORT_VALUE: Record<string, 'force-dynamic' | null>` — per-route declared value of `dynamic`. `null` means the route deliberately does NOT export `dynamic` (auth callback / signout — redirect-only flows). 20 entries (every route in `ALL_ROUTES`).
   - `RUNTIME_EXPORT_VALUE: Record<string, 'nodejs' | null>` — same shape for `runtime`. 20 entries; 17 `'nodejs'`, 3 `null` (auth callback, signout, get-quotes/claim — Next.js default is correct for those).
   - `assertConfigAttestationCovers()` — throws if `ALL_ROUTES` has any route without an entry in BOTH maps, or either map has an orphan entry.

2. **NEW** `app/route-config-export-shape.test.ts` (+50 tests). Per-route locks:
   - **Coverage check**: every `ALL_ROUTES` route is attested in both maps.
   - **Catalog-shape locks**: `CANONICAL_DYNAMIC` and `CANONICAL_RUNTIME` are in the Next.js-legal value sets (`{auto, force-dynamic, force-static, error}` and `{nodejs, edge}` respectively). Every non-null attestation value is a Next.js-legal value — catches a typo at the catalog layer that would otherwise silently match itself.
   - **Per-route DYNAMIC value lock** (20 tests, one per route): if attestation says `null`, source must NOT export `dynamic`; if attestation says a value, source must export EXACTLY that literal.
   - **Per-route RUNTIME value lock** (20 tests, one per route): same pattern.
   - **Anti-vacuous-pass tripwires** (4 tests): at least one route uses `CANONICAL_DYNAMIC`, at least one is `null` for DYNAMIC; same for RUNTIME. A future maintainer who mass-edits everything to `null` can't pass the audit.
   - **Cross-catalog consistency with R48(b)**: every route with `null` `DYNAMIC_EXPORT_VALUE` must be `redirect-only` strategy in `CACHE_CONTROL_ATTESTATION` (with the `version` route as the documented exception — it's `CACHEABLE_VERSION`, not `NON_CACHEABLE`).

3. **Drift-detection verification.** Mid-round I temporarily mutated `app/api/health/route.ts`'s `dynamic` from `'force-dynamic'` to `'force-static'` to confirm the audit fires. It does — with a precise message: *"app/api/health/route.ts: dynamic = 'force-static' but attestation expects 'force-dynamic'"*. Original restored; suite clean.

Files: `tests/helpers/route-catalog.ts` (extended), `app/route-config-export-shape.test.ts` (NEW).

### R49(b) — Rate-limit registry negative-coverage extension

R48(a)'s walker proves every `prefix:` literal in `app/api/**/route.ts` and `lib/actions/*.ts` is registered in `KNOWN_PREFIXES`. It does NOT prove that no `assertRateLimit*` call exists outside those paths. A future PR importing `assertRateLimit` into, say, `lib/calls/engine.ts` would land without registration pressure — neither walked-path audit would notice.

R49(b) closes that gap with a negative-coverage lock.

**Shipped:**

1. **`tests/helpers/rate-limit-prefixes.test.ts` extended** (+3 tests, 8 → 11):
   - **`R49(b) — no assertRateLimit* call appears outside walked paths or the allow-list`**. Walks 10 production directories under `lib/` (`lib/calls`, `lib/cron`, `lib/email`, `lib/forms`, `lib/ingest`, `lib/observability`, `lib/queue`, `lib/stripe`, `lib/supabase`, `lib/text`) plus their subdirs. Asserts NO `.ts`/`.tsx` file (excluding `.test.ts*`) contains `assertRateLimit(` or `assertRateLimitFromHeaders(`. Allow-list: `lib/security/rate-limit-auth.ts` (the primitive itself).
   - **Allow-list integrity**: every entry in `RATE_LIMIT_CALL_ALLOWLIST` must exist on disk. A typo silently exempts a non-existent file.
   - **Directory-list integrity**: every entry in `NEGATIVE_COVERAGE_DIRS` must exist on disk. A renamed/removed directory silently shrinks the negative-coverage surface.

2. **Drift-detection verification.** Mid-round I planted `lib/calls/_violation_test.ts` containing a stray `assertRateLimit(...)` call with a fresh prefix. The audit caught it with the precise file path + preview line. Sandbox permissions blocked outright deletion; the file is now rewritten as a no-op (`export const __r49_inert_marker = true`) and is flagged as a one-line cleanup item below (#15).

Files: `tests/helpers/rate-limit-prefixes.test.ts` (extended), `lib/calls/_violation_test.ts` (sandbox remnant; pending cleanup).

### R49(a) — Cron route origin-pinning feasibility (research-only, no code shipped)

R48 close suggested a Vercel cron origin-pinning audit "alongside `assertCronAuth`" with a feasibility-check first. I ran the feasibility check.

**Findings:**

- **No cryptographic signature mechanism for cron jobs.** Vercel webhooks and log drains use `x-vercel-signature` (HMAC-SHA1); cron jobs deliberately omit it. ([vercel.com/docs/cron-jobs](https://vercel.com/docs/cron-jobs))
- **No published stable IP range.** Cron requests originate from shared infra alongside regular user traffic.
- **The only non-bearer-token identifier is `User-Agent: vercel-cron/1.0`** — and it's spoofable (anyone can set headers). Locking on it would be security theater, not defense-in-depth.
- **Vercel's official guidance**: bearer-token check via `CRON_SECRET` env var, exactly what we already have via `assertCronAuth`. R43(b) locks the parity / ordering of that check across all three cron routes.

**Recommendation: do not ship.** No layer to add that's worth the test-surface cost. R49(a) closes as research-only; the negative finding lives in this report so a future round doesn't re-investigate.

---

## Verification

- **Full suite:** `vitest run` → **2273 / 132 passing** (R48 close baseline: 2172 / 130). Net delta: +101 tests, +2 files.
- **Type check:** `tsc --noEmit` clean.
- **Lint:** `next lint` clean.
- **npm audit:** identical to R48 (5 vulns: 4 moderate, 1 high — `next`, `postcss`, `uuid`, `svix`, `resend`; all cross-major; still blocked on user pre-approval).
- **Determinism:** 5/5 runs of R49-touched files: 78/78 pass every run.

Per-file delta (R48 close → R49 close):

| File | R48 close | R49 close | Δ |
|---|---|---|---|
| `app/api/vapi/webhook/route-event-type-drift.test.ts` | — | 17 | +17 (NEW) |
| `app/route-config-export-shape.test.ts` | — | 50 | +50 (NEW) |
| `tests/helpers/rate-limit-prefixes.test.ts` | 8 | 11 | +3 |
| `tests/helpers/route-catalog.ts` | (no test file delta — exports added) | — | — |

R48-to-R49 measured baseline drift of +31 tests came from previously-untracked test files (`lib/ingest/seed-on-demand.test.ts` and `tests/.debug/*`) plus light churn in route handler tests. None of that landed via report-level shipping; the R49 deltas above account for the *intentional* +70 tests across 3 files + 1 catalog edit. The remaining 31 are noise that will resolve when item #13 (`tests/.debug/` cleanup) lands.

---

## Implementation notes for Round 50+

- **Sentry DSN capture-site count unchanged at ~43.** R49 shipped zero new capture sites. R49(c) adds one cross-check (`route: 'vapi/webhook'` tag must appear at the captureException call site) but that wiring already existed.
- **`CANONICAL_DYNAMIC` and `CANONICAL_RUNTIME` are the canonical config-value primitives.** New routes that need different values must (a) extend the type union, (b) add per-route attestation, and (c) accept that the anti-vacuous-pass tripwires require at least one route per non-trivial value. This is the same evolution pattern R48(b) used for `CacheControlStrategy`.
- **Vapi webhook is now locked at three granularities**: route-level (R32 / route.test.ts), event-type set (R49(c) — both HANDLED and FORBIDDEN), and source-shape ordering (R49(c) — auth-before-parse, error-handling, captureException). A new event added to `EXPECTED_HANDLED` must (a) be added here, (b) move OUT of `FORBIDDEN_MESSAGE_TYPES` if listed, AND (c) match the existing single-handler shape (or the audit's source-shape locks must be extended to cover the new branching).
- **Negative-coverage pattern proven in R49(b).** Same shape (positive walker → negative-coverage backstop → integrity locks on both lists) is reusable for any future "registry must be the canonical source" lock — e.g., if we add a `KNOWN_LOG_NAMESPACES` registry, the same three-test scaffold applies.
- **Cron origin-pinning is closed.** Don't re-investigate without new info from Vercel (e.g., HMAC support landing post-2026). The current `CRON_SECRET` + R43(b) parity audit is the canonical defense.
- **R49 user-input items: 15** (was 14 — added #15: sandbox cleanup of `lib/calls/_violation_test.ts`). Sentry DSN still #1.

---

## Outstanding items requiring your input

**Count: 15** (was 14; +1 sandbox cleanup item from R49(b)). Top 4 unchanged.

| # | Item | Value | Blocker |
|---|------|-------|---------|
| 1 | **Sentry DSN** | ~43 capture sites are wired but inert without a real DSN. Add `SENTRY_DSN` (and optionally `NEXT_PUBLIC_SENTRY_DSN`) to Vercel env. Free tier covers our pre-launch volume. | None — drop the value in. |
| 2 | **Next.js 14.3.x bump** (closes 6 CVEs) | `npm audit fix --force` would install Next 16.2.4 — cross-major bump. Need pre-approval to run + test. | Your call on cross-major bump risk. |
| 3 | **Resend bump** (closes 1 high CVE in svix dep tree) | Same shape as #2 — `npm audit fix --force` would push to 6.1.3 cross-major. | Your call. |
| 4 | **Daily-report archival policy** | `docs/` now shows R31–R49 (19 reports). Suggested: keep last ~10 at top level, archive the rest. | Want a strict date cutoff (e.g., > 7 days)? Or count-based rolling policy? |
| 5–12 | Pre-launch checklist confirmations | Various — see prior reports. | You. |
| 13 | R42 `tests/.debug/` scratch files | `tests/.debug/probe.test.ts` and `tests/.debug/debug.test.ts` are harmless no-ops left over from R42(b) build-out. Sandbox can't delete them. | Run `rm -rf tests/.debug/ scripts/debug-walker.mts` locally when convenient. |
| 14 | `scripts/archive-daily-reports.ts` | Can land once #4 is decided. | Depends on #4. |
| 15 | **`lib/calls/_violation_test.ts` sandbox remnant** | R49(b) audit-verification artifact. File now contains only an inert marker export. | Run `rm lib/calls/_violation_test.ts` locally when convenient. ~5 seconds. |

**Highest leverage:** still #1 (Sentry DSN). 43 capture sites would activate immediately; R49(c) added one more pivot tag (`route: 'vapi/webhook'`) so the post-DSN value compounds.

---

## Suggested next autonomous run (Round 50)

(a) **Twilio SMS webhook event-type drift audit** — R49(c) analog for `app/api/twilio/sms/route.ts`. Twilio sends a small, well-documented set of message types (delivered, failed, undelivered, sent, queued, accepted) with signed `X-Twilio-Signature`. The signature is locked elsewhere; the type allow-list is not. ~45 min.

(b) **`lib/security/exports.ts` barrel file existence check.** R49(b)'s allow-list referenced `lib/security/exports.ts` initially — the file doesn't exist; the public-surface tests live in `lib/security/exports.test.ts` with no production barrel. If a future refactor wants a barrel, it would be the natural import surface; pre-creating an empty placeholder OR adding a "barrel exists if surface > N exports" audit could reduce future drift. Lower priority. ~20 min.

(c) **Stripe webhook `case` body return-shape extension** for the ack-only branch. R47(c) locked the explicit-handled cases; R48(c) locked the family-level forbidden surface. A natural complement: lock that the ack-only branch's return body is structurally identical to the default-case body (both are `{ received: true, eventId, note: 'Ignored event type' }` today). ~30 min.

(d) **Sandbox cleanup helper script.** Two items (#13, #15) are both "remove this scratch file." A `scripts/cleanup-sandbox-remnants.sh` checked into the repo would be a one-line `bash scripts/cleanup-sandbox-remnants.sh` for Antonio next time he's at a real shell. ~10 min, but writes a script Antonio still has to run manually — value debatable.

(e) **Next.js + Resend CVE bump** IF pre-approved (#2/#3). ~45 min.

(f) **Preview-deploy smoke run** IF scheduled. Human-gated.

(g) **Sentry DSN wiring** IF #1 arrives. ~15 min — flips ~43 capture sites from inert to active in one commit. Highest leverage.

(h) **Unify `dynamic` + `runtime` value extraction utilities.** R49(i)'s `extractDynamic` and `extractRuntime` are tiny one-line regex helpers; they'll naturally want to live in `tests/helpers/source-walker.ts` once a third caller emerges (e.g., a "lock `revalidate` on cacheable routes" audit). Premature today; flag for whenever the third caller lands.

---

*Report generated by R49 autonomous scheduled run. All claims verified by `vitest run` (2273/132), `tsc --noEmit`, `next lint`, and a 5/5 determinism check on R49-touched files (78/78 every run).*

---

## R49 post-close addendum (2026-04-28, post-handoff)

Antonio responded mid-session and pre-approved items #2 + #3 (Next.js + Resend CVE bumps) and chose item #4 directive (move daily reports into a subfolder). One of those landed cleanly; the other ran into sandbox limits and is left as a manual step.

### #4 — Daily-report archival (DONE)

- Created `docs/daily-reports/`. Moved all 19 top-level `DAILY_REPORT_*.md` files plus all 10 files from the old `docs/DAILY_REPORT_ARCHIVE/` into the new flat folder. Total: 29 reports.
- Updated the one cross-reference in `docs/PRE_MERGE_CHECKLIST.md` to point at the new path.
- Sandbox could not `rmdir` the now-empty `docs/DAILY_REPORT_ARCHIVE/` folder. **One-line cleanup for Antonio: `rmdir docs/DAILY_REPORT_ARCHIVE`.** (This is a new low-priority human-input item, but lumping it under #4.)

### #2 + #3 — Next.js + Resend CVE bumps (BLOCKED — sandbox limits)

**State of the package files:** safe — `package.json` + `package-lock.json` are unchanged from R49 close (`next: ^14.2.35`, `resend: ^6.12.2`). All 2273 tests pass against this baseline.

**State of `node_modules`:** **STRANDED at a partial Next 16.2.4 / Resend 6.1.3 install.** This needs a clean reinstall at Antonio's local terminal — see remediation steps below.

**What happened:**

1. Saved package.json + package-lock.json to `/tmp/`.
2. Ran `npm audit fix --force`. The 45-second sandbox bash timeout truncated the install partway through. By the time control returned, `node_modules/next/` was at 16.2.4 (cross-major) and `node_modules/resend/` was at 6.1.3 (a *downgrade* from 6.12.2 — npm's chosen fix path for the transitive uuid CVE), but neither package.json nor package-lock.json had been committed.
3. Restored package.json + package-lock.json from `/tmp/` (so the manifest layer says 14.2.35 / 6.12.2 again).
4. Tried to re-sync node_modules to the manifest with `npm install` and `npm ci` — both failed:
   - `npm ci`: `EACCES` on `node_modules/.package-lock.json` (sandbox file-permission gate).
   - `npm install next@14.2.35`: `ENOTEMPTY` trying to rename `node_modules/@rolldown/binding-wasm32-wasi` (sandbox can't perform npm's atomic-rename strategy).
   - `rm -rf node_modules/next`: per-file `Operation not permitted`.
5. Verification of the partial state:
   - **`vitest run` → 2273 / 132 passing** (tests run against the in-memory JS, which somehow works against Next 16's runtime).
   - **`tsc --noEmit` → BROKEN** with 5 errors: `Could not find a declaration file for module 'next/server'` / `'next/headers'`. Next 16's published package puts no top-level `.d.ts` files in the package root and uses no `exports` map; the type resolver can't find the declarations. May be specific to this incomplete install (only 6139 files in `node_modules/next/`, zero of which are `.d.ts`); the official tarball *should* ship .d.ts files.
   - **`next lint` → BROKEN**. Next 16 removed the `next lint` subcommand (the framework deprecated it in 15 and dropped it in 16 in favor of running `eslint` directly).
   - **`npm audit` → still reports 5 vulns** (audit reads the lockfile, which is at the rolled-back manifest values).

**Remediation steps for Antonio (run at your terminal, not in the autonomous session):**

Path A — **Roll back fully** (recommended for now; preserves R49's tsc-clean / lint-clean state):

```bash
cd /Users/Antonio/Documents/Claude/Projects/EvenQuote
rm -rf node_modules
npm install                  # reads package.json (14.2.35 / 6.12.2)
npx tsc --noEmit             # should be clean
npx next lint                # should be clean
npx vitest run               # should still be 2273 / 132
npm audit --omit=dev         # 5 vulns (back where R49 closed)
```

Path B — **Commit to the cross-major bump** (when you have an hour):

```bash
cd /Users/Antonio/Documents/Claude/Projects/EvenQuote
rm -rf node_modules package-lock.json
# Edit package.json: change "next": "^14.2.35" → "next": "^16.2.4"
# Resend is already at ^6.12.2 — leave it; the audit's "downgrade to 6.1.3"
# fix is dubious. uuid CVE flows through svix; check if a newer svix is
# available that pins uuid >= 14, in which case we can stay on resend 6.12.2.
npm install
# Then triage:
#   1. `next/server` + `next/headers` type imports — Next 16 may have moved
#      types under `next/dist/...`. Update lib/supabase/middleware.ts,
#      middleware.ts, lib/supabase/server.ts, tests/middleware.test.ts.
#   2. Replace `npm run lint` script: change "next lint" → "eslint ."
#      and ensure `.eslintrc.json` extends are still resolvable in the
#      eslint-config-next 16.x package.
#   3. Async request APIs: Next 15+ made cookies(), headers(), draftMode()
#      async. Sweep grep for these and add `await` where used.
#   4. Caching defaults flipped in Next 15 — server-side fetch is no longer
#      cached by default. Routes using `force-dynamic` already opt-in to
#      the Next 15+ behavior (R49(i) locks 17 of those), so this likely
#      affects only the version route's cacheable handler — verify.
#   5. Run full vitest + tsc + lint; expect 1–3 hours of triage.
```

**Why the manifest is the right state to leave in:** if the sandbox had landed the bump cleanly (package.json + package-lock.json updated AND node_modules consistent), I would have. It didn't, and I can't recover from in here. Leaving the manifest at 14.2.35 means a `rm -rf node_modules && npm install` at your terminal puts the world back to R49-close state — no commits to revert, no partial state to reason about.

**Lessons for future autonomous runs:** Cross-major bumps that involve `npm audit fix --force` should be treated as human-only operations. The combined "long install + sandbox file-permission constraints" is too unreliable for autonomous attempts. R49(R48-close suggestion (e)) should be amended: **"Next.js + Resend CVE bumps — human-only at terminal."**

### Outstanding items refresh (post-R49 addendum)

| # | Item | State after addendum |
|---|------|----------------------|
| 1 | Sentry DSN | Unchanged. |
| 2 | Next.js bump | **In-flight; manifest rolled back; node_modules stranded.** Run Path A or B above. |
| 3 | Resend bump | Same — bundled with #2. |
| 4 | Daily-report archival | **DONE** (this addendum). One-line cleanup: `rmdir docs/DAILY_REPORT_ARCHIVE`. |
| 5–14 | (unchanged) | — |
| 15 | `lib/calls/_violation_test.ts` cleanup | Unchanged. |
| 16 | (NEW) `rmdir docs/DAILY_REPORT_ARCHIVE` | Empty folder left by sandbox. |
| 17 | (NEW) `rm -rf node_modules && npm install` | Required to escape the stranded-install state from this addendum. |

