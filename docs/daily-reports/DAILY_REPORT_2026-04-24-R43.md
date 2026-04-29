# Daily Report — 2026-04-24 Round 43

**Autonomous scheduled run.** Task file: `refine-code---evenquote` — make EvenQuote production-ready.

---

## TL;DR

- **Tests:** 1880 passing across 116 files. Baseline (R42 close): 1798/114. **Delta: +82 tests, +2 files.**
- **`tsc --noEmit`:** clean.
- **`next lint`:** clean.
- **`npm audit --omit=dev`:** unchanged from R42 — 5 vulns (4 moderate, 1 high: next, postcss, uuid, svix, resend). All still blocked on cross-major bump pre-approval.
- **Determinism:** 5/5 runs on all R43-touched files — 101/101 pass every run.
- **Sentry DSN capture-site count:** unchanged at ~43. R43 shipped zero new capture sites.

No human-input decision was surfaced mid-run. Three planned items shipped; one deferred (see §4).

---

## 1. Shipped

### R43(a) — Regex-literal-aware position-preserving stripper

**File changed:** `tests/helpers/source-walker.ts` (+ helper `canStartRegex`, `skipRegexLiteral`, regex-awareness hook in the two preserving-position walkers).
**Tests added:** `tests/helpers/source-walker.test.ts` +6 tests → 25 total (was 19).

Addresses the R42(b) blind spot documented in memory: `stripCommentsAndStringsPreservingPositions` previously saw the apostrophe inside `.replace(/'/g, ...)` as a string opener, which caused a fake single-quoted string to extend through the rest of the file and erase real tokens. Two walkers are fixed — `stripCommentsPreservingPositions` (the primary used by `extractExportedAsyncFunctionBody`) and `stripCommentsAndStringsPreservingPositions` (the second-pass variant).

Detection is a precision-over-recall heuristic: `canStartRegex(chars, i)` scans backward past whitespace to the last non-whitespace character, then checks against (i) an allow-list of punctuation tokens that cannot be followed by division (`(`, `[`, `{`, `,`, `;`, `:`, `!`, `&`, `|`, `?`, `+`, `-`, `*`, `%`, `<`, `>`, `=`, `~`, `^`) or (ii) an allow-list of keywords (`return`, `typeof`, `instanceof`, `new`, `void`, `delete`, `throw`, `in`, `of`, `await`, `yield`, `do`, `else`, `case`). Anything else is treated as division. If the heuristic misfires on a real regex, the walker degrades to pre-R43 behavior (the blind spot returns for that one regex); it cannot introduce new failures.

Inside a regex, `skipRegexLiteral` tracks `\` escapes and `[...]` character classes correctly. A newline inside a suspected regex triggers a safe bail-out.

**Unblocks:** the R42(b) column-0 `}` workaround in `lib/email/templates-render-shape-drift.test.ts`. Not removed in this round (the convention still works; changing it is a separate refactor).

### R43(b) — Cron route handler POST/GET parity audit

**File added:** `app/api/cron/cron-route-parity-drift.test.ts` (+23 tests).

Source-level audit that locks the POST/GET parity invariant across all cron routes in `app/api/cron/**`. Catalog-driven (`EXPECTED` set of 3 routes) — adding a new cron route fails the discovery test until the catalog is updated. Per-route invariants:

1. Exports BOTH `GET` and `POST`.
2. Both method bodies are exactly `{ return handle(req); }` — no inline duplication.
3. A local `async function handle(req: Request)` delegate exists.
4. `handle` calls `assertCronAuth(req)` BEFORE any other function call — auth always first.
5. `assertCronAuth` imported from `@/lib/security/cron-auth`.
6. `export const dynamic = 'force-dynamic'` present.
7. `export const runtime = 'nodejs'` present.

All three existing routes (`check-status`, `retry-failed-calls`, `send-reports`) are already compliant. Posterity lock.

**Parser note:** the string-literal assertions use `stripCommentsOnlyRegex` (preserves bodies) rather than `stripCommentsAndStringsPreservingPositions` (blanks bodies). Added alongside the structural walk that does use the blanking variant.

### R43(c) — Route response-header drift audit

**File added:** `app/route-response-headers-drift.test.ts` (+53 tests).

Cache-Control hygiene audit across all 17 `route.ts` files in `app/**`. Classification-driven:

- **NON_CACHEABLE** (16 routes): cron/*, csp-report, dev/*, health, status, stripe/webhook, vapi/*, twilio/sms, auth/callback, auth/signout, get-quotes/claim. If `dynamic` is exported, its value must be `'force-dynamic'`. If a `Cache-Control` header is set, it must start with `no-store` and must not contain `public`.
- **CACHEABLE_VERSION** (1 route): `api/version/route.ts`. Cache-Control is locked to the exact string `public, s-maxage=60, stale-while-revalidate=120` (both GET and HEAD). `dynamic = 'force-dynamic'` still required — server-side dynamic rendering and downstream CDN caching are independent concerns.

The catalog-match test fails if a new route is added to `app/**` without being classified into one of the two sets — forcing a conscious decision.

**Auth routes note:** `auth/callback/route.ts` and `auth/signout/route.ts` don't export `dynamic`. They issue `NextResponse.redirect`, which is inherently non-static, so Next.js already treats them as dynamic. The audit permits `dynamic`-absence on these (R42(c)'s per-route `config` catalog is where that absence is locked; R43(c) only checks the VALUE when present).

---

## 2. Verification

| Gate | Result |
|---|---|
| `vitest run` | 1880/116 passing |
| `tsc --noEmit` | clean |
| `next lint` | clean |
| `npm audit --omit=dev` | identical to R42 (5 vulns: 4 moderate, 1 high) |
| Determinism (5x) | 101/101 pass every run on R43 files |

Baseline at start of run: 1798/114. Net delta: **+82 tests, +2 new files.**

---

## 3. Outstanding human-input items

Unchanged from R42 (still 14 items). Ranked by impact:

1. **Sentry DSN** — still the highest-value decision. ~43 capture sites are already wired; they emit to no-op stub in prod today. Set `SENTRY_DSN` in Vercel env to activate.
2. **Next.js 14.3.x cross-major bump** — closes 6 CVEs (next 5 + postcss 1). Blocked on pre-approval because it's a breaking change. `npm audit fix --force` would run `npm install next@16.2.4` (which is also a major bump beyond 14.3.x — consider the 14.3.x LTS path instead).
3. **Resend cross-major bump** — `resend@6.1.3` is breaking. Inherits the svix/uuid chain. Blocked on pre-approval.
4. **Archival policy for daily reports** — R40(e) moved 10 older reports into `docs/DAILY_REPORT_ARCHIVE/` under a pragmatic "keep last ~10 rounds" heuristic. A strict date cutoff wasn't used because all reports were within a 3-day window. Decide: strict N-day cutoff, or keep-last-N heuristic?
5–12. Pre-launch checklist confirmations (unchanged from R42 list — see `docs/DAILY_REPORT_2026-04-24-R42.md` §4).
13. R42 archival-script tradeoff (whether to automate the archive step).
14. **`tests/.debug/` + `scripts/debug-walker.mts`** — leftover debug scratch from R42(b) build-out. Both are rewritten to harmless no-ops; safe to `rm -rf` manually. Still present as of R43 close.

---

## 4. Deferred from R42's suggested R43 set

Three items from R42's suggestion list were NOT shipped this round:

- **(a) RPC return-type + TS cast round-trip extension** — carried forward. ~30 min. No progress.
- **(c) `scripts/archive-daily-reports.ts`** — still blocked on human-input item #4 (policy decision).
- **(e) Supabase seed data integrity audit extension (R40(d) extension)** — carried forward. ~30 min.
- **(f) Next.js CVE bump** — blocked on pre-approval.
- **(g) Preview-deploy smoke run** — human-gated, not scheduled this round.

Shipped three (a, b, d from R42's list → R43's three items).

---

## 5. Suggested next autonomous run (Round 44)

**(a)** RPC return-type + TS cast round-trip extension — carried from R41(b)→R42 suggestion→R43 deferred. Extend R37(a) beyond the two RPCs it covers to all 7 table-returning RPCs. ~30 min.

**(b)** Supabase seed data integrity audit — extend R40(d) to validate the relationship between `businesses`, `service_categories`, and `business_service_categories` join-table seed files. ~30 min.

**(c)** Route response-header audit extension — lock the EXACT Cache-Control shape for NON_CACHEABLE routes that DO set the header (currently R43(c) only checks the prefix). Tighten to `no-store, no-cache, must-revalidate, max-age=0` per the pattern shipped in check-status/health/status. ~20 min.

**(d)** Regex-literal-aware stripper — verify the R43(a) walker against the rest of the codebase by re-running ALL source-walker-dependent audits and checking there are no newly-detected drifts (now that apostrophe-in-regex no longer masks downstream reads). If a new drift IS detected, ship the fix in the same round. ~30 min.

**(e)** Lift the R42(b) column-0-`}` workaround in `lib/email/templates-render-shape-drift.test.ts` now that R43(a) unblocked it. Convert to a regex-aware `extractFunctionBodyByName` call. ~20 min.

**(f)** `scripts/archive-daily-reports.ts` IF human input #4 arrives. ~20 min.

**(g)** Next.js 14.3.x CVE bump IF pre-approved. ~45 min.

**(h)** Preview-deploy smoke run IF scheduled. Human-gated.

---

## 6. Notes for the operator

- **R43 is a quiet, test-only round.** No app/lib/script source behavior changed except for the source-walker helper (test-only file). Posterity locks + one blind-spot fix.
- **R43(a)'s heuristic is precision-over-recall.** If a future audit reports unexpected drift that traces back to regex misidentification, the first check is whether the regex is preceded by a token not on the allow-list in `source-walker.ts`. Extend the allow-list if so.
- **`npm audit` has not changed since R40(d) surfaced the postcss CVE.** The cross-major bump window is widening — scheduling a pre-approval conversation is worth more than any additional drift-catch we can ship this week.
