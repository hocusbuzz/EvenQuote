# Daily Report — 2026-04-24 Round 45

**Autonomous scheduled run.** Task file: `refine-code---evenquote`. Ran R45(a)–(d) plus one drift-fix surfaced mid-round, plus catalog updates for two new route files.

---

## TL;DR

- **Tests:** 2024 passing across 123 files. R44 close baseline: 1946/120. **Delta: +78 tests, +3 new files.**
- **`tsc --noEmit`:** clean.
- **`next lint`:** clean.
- **`npm audit --omit=dev`:** unchanged (5 vulns: 4 moderate, 1 high — still blocked on pre-approval).
- **Determinism:** 5/5 runs on all R45-touched files — 196/196 pass every run.
- **Drift caught + fixed mid-round:** `0007_phase8_contact_release.sql` had two naked `create policy` statements. R45(c)'s idempotency audit caught it; fixed with `drop policy if exists` guards.
- **R44(e) blind spot resolved:** the column-0 `}` workaround in `lib/email/templates-render-shape-drift.test.ts` is now lifted — the shared walker handles nested template literals.

---

## 1. Shipped

### R45(a) — `${...}`-aware state-stack walker

**Files changed:** `tests/helpers/source-walker.ts`, `tests/helpers/source-walker.test.ts` (+6 tests, 28 → 34), `lib/email/templates-render-shape-drift.test.ts` (column-0 workaround removed).

Prior-round blind spot: the walker's string-state tracker was a single scalar (`false | "'" | '"' | "\`"`), so a nested template literal

```js
`outer ${cond ? `inner` : ''} outer`
```

…saw the first inner backtick as CLOSING the outer template. From there, the brace-balance walk inside `extractExportedFunctionBody` bled into other scopes and returned `null`. R42(b) worked around this with a column-0 `}` convention in `templates-render-shape-drift`.

R45(a) replaces the scalar with a STATE STACK. Each frame is one of:

- `{ kind: 'file' }` — top-level code (parses comments / regex / strings)
- `{ kind: 'string'; quote: "'" | '"' }` — inside a `'…'` / `"…"` string
- `{ kind: 'template' }` — inside a `` `…` `` template
- `{ kind: 'sub'; braceDepth: number }` — inside a `${…}` substitution (code context, pops when `}` hits depth 0)

Transitions: `file/sub + '` or `"` → push `string`; `file/sub + \`` → push `template`; `template + \`` → pop; `template + ${` → push `sub`; `sub + {` → `braceDepth++`; `sub + }` → pop if depth 0 else `braceDepth--`. Comments and regex literals fire only in code frames.

Applied to three helpers: `stripCommentsPreservingPositions`, `stripCommentsAndStringsPreservingPositions`, and the brace walker inside `extractExportedFunctionBodyImpl`. The second helper blanks template-literal BODY text to spaces but leaves `${…}` substitutions visible — so downstream regex audits (e.g. `intake-read-path-drift`) still see `${intake.foo}` reads.

**Lift of R42(b) workaround:** `lib/email/templates-render-shape-drift.test.ts`'s local `extractFunctionBodyByName` now delegates to `extractExportedFunctionBody`. All 16 tests still pass. The column-0 `}` convention test at the end of the file is kept as belt-and-suspenders.

### R45(b) — RLS policy lifecycle drift audit

**File added:** `supabase/rls-policy-lifecycle-drift.test.ts` (+22 tests).

Sibling to R39(a) (`rls-policy-drift.test.ts`, locks names + commands) and R41(a) (`rls-policy-predicate-drift.test.ts`, locks predicate bodies). R45(b) covers the LIFECYCLE ceiling that neither earlier audit touches:

- Every RLS-enabled table is classified in exactly one of `WITH_POLICIES` (8 tables: profiles, service_categories, businesses, quote_requests, calls, quotes, payments, quote_contact_releases) or `NO_POLICIES_SERVICE_ROLE_ONLY` (3 tables: waitlist_signups, vapi_phone_numbers, csp_violations — deny-all to client roles; writes/reads via service role).
- `WITH_POLICIES` tables must have ≥ 1 `create policy`; `NO_POLICIES` tables must have 0.
- No `alter policy` in any migration (silent predicate mutation).
- No NAKED `drop policy` in any migration (`drop policy if exists` IS allowed — canonical idempotency guard; R41 predicate audit backstops any drop-then-recreate).
- No `disable row level security` anywhere (catastrophic regression).
- `force row level security` only on tables in `FORCE_RLS_ALLOWED` (currently empty).
- `create policy` total count equals 11 (matches R41 `EXPECTED_PREDICATES` count — cross-file cross-check).
- Classification sets are disjoint.
- Every `NO_POLICIES` table is documented with a service-role justification comment in the migration where RLS is enabled.

All 22 invariants pass. Coverage is complete: every `create policy` across all migrations is locked by either R39 (names) or R41 (predicates); every `enable row level security` is classified.

Also updated `supabase/rls-policy-drift.test.ts` to treat `drop policy if exists` followed by matching `create policy` in the same file as the idempotent drop-then-recreate pattern (safe; R41 still locks the recreated predicate). Naked `drop policy` and all `alter policy` still fail.

### R45(c) — Supabase migration idempotency drift audit

**File added:** `supabase/migrations-idempotency-drift.test.ts` (+17 tests).
**Migration fixed mid-round:** `supabase/migrations/0007_phase8_contact_release.sql`.

Classification:

- **Foundational** (`0001_initial_schema.sql`): naked `create table` / `create index` / `create trigger` / `create policy` tolerated. Re-running this migration is not a supported workflow.
- **Incremental** (0002+): every DDL statement must be idempotent. Enforced per category:
  - `create table` → must use `if not exists`
  - `create index` / `create unique index` → must use `if not exists`
  - `alter table add column` → must use `if not exists`
  - `create extension` → must use `if not exists`
  - `create schema` → must use `if not exists`
  - `create function` → must use `create or replace`
  - `create trigger` → must be preceded (same file) by `drop trigger if exists` OR use `create or replace trigger`
  - `create policy` → must be preceded (same file) by `drop policy if exists`
- **Destructive DDL** (all migrations): `drop table`/`column`/`function`/`trigger`/`index`/`policy` must use `if exists`.

**Drift caught and fixed mid-round (R45(c)₁):** `0007_phase8_contact_release.sql` had two naked `create policy` statements (`quote_contact_releases: owner read` and `admin read all`). Under a disaster-recovery re-apply, both would crash with "policy already exists". Fixed by inserting `drop policy if exists <name> on <table>;` before each `create policy`. The file runs inside `begin;…commit;` so there's no live no-enforcement window.

Also fixed a self-inflicted conflict: R45(b)'s initial "no `drop policy` in any migration" rule would have tripped on the R45(c) fix. R45(b) narrowed to NAKED `drop policy` only; R39's `alterOrDropCount` updated to recognize the idempotent drop-then-recreate pattern.

### R45(d) — Zod shared-primitive drift audit

**File added:** `lib/forms/zod-shared-primitive-drift.test.ts` (+15 tests).
**Library changed:** `lib/forms/moving-intake.ts` (added `EmailSchema` primitive), `lib/forms/cleaning-intake.ts` (re-export added), `lib/actions/waitlist.ts` (inline regex + email chain replaced with shared primitives).
**Test parser extended:** `lib/actions/actions-zod-schema-drift.test.ts` now resolves `EmailSchema`/`ZipSchema`/`PhoneSchema`/`UsStateSchema` identifiers to their underlying inferred type.

Four shared primitives live in `lib/forms/moving-intake.ts`:

| Primitive        | Canonical shape                                                                  |
|------------------|----------------------------------------------------------------------------------|
| `EmailSchema`    | `z.string().trim().toLowerCase().email('Valid email, please')` — chain order matters (normalize BEFORE format check) |
| `ZipSchema`      | `z.string().trim().regex(/^\d{5}(-\d{4})?$/, …)`                                 |
| `UsStateSchema`  | `z.enum(US_STATES)` — 50 states + DC, 2-letter codes                             |
| `PhoneSchema`    | `z.string().trim().min(10).max(20).regex(/^[+\d][\d\s\-().]*$/, …)`              |

The audit locks:
1. Each primitive is exported from `moving-intake.ts` with the canonical shape.
2. `cleaning-intake.ts` imports AND re-exports every primitive (keeps the public surface symmetric).
3. No inline duplicates of the ZIP regex, phone regex, or US_STATES array outside `moving-intake.ts`.
4. No inline duplicates of the canonical email chain outside allow-listed files.
5. Attestation: `lib/env.ts` uses the allow-listed loose `.email()` chain (deliberately skips `.trim()`/`.toLowerCase()` — env vars aren't user-normalized). `lib/actions/auth.ts` uses the reordered `.email(msg).toLowerCase().trim()` chain (magic-link login UX context, consciously separate).
6. Allow-list entries map to real files and have non-empty reasons.

**Drift caught and fixed mid-round:**
- `lib/actions/waitlist.ts` was duplicating the ZIP regex literal AND the full email chain inline. Now imports `EmailSchema` and `ZipSchema` from `moving-intake.ts`.
- `lib/forms/moving-intake.ts` and `lib/forms/cleaning-intake.ts` had duplicated inline email chains. Both now reference `EmailSchema`.

Net effect: the canonical email chain appears in ONE place (`moving-intake.ts`). Downstream `actions-zod-schema-drift.test.ts` (R38(c)) was briefly broken by the refactor (its parser didn't recognize imported schema identifiers); extended `classifyZodValue` with a `SHARED_PRIMITIVE_INFERRED` map so it resolves `EmailSchema → 'string'` etc.

### R45(e) — Route catalog updates for new Places routes

**Files changed:** `app/route-handler-exports-drift.test.ts`, `app/route-response-headers-drift.test.ts`, `app/route-response-shape-drift.test.ts`, `app/route-reason-audit.test.ts`.

Two pre-existing route files (`app/api/places/autocomplete/route.ts` and `app/api/places/details/route.ts`) tripped four different catalog-driven audits on full-suite run. Added to:

- `route-handler-exports-drift.test.ts` EXPECTED_ROUTES (methods: `[GET]`, config: `[dynamic, runtime]`)
- `route-response-headers-drift.test.ts` `NON_CACHEABLE` (external proxy; no-store appropriate)
- `route-response-shape-drift.test.ts` allowlist (response shape mirrors Google's API surface — candidate for proper `EXPECTED_SHAPES` lock in a future round once the contract stabilizes)
- `route-reason-audit.test.ts` `EXPECTED_REASONLESS_ROUTES` (single catch boundary per handler; `route:` tag suffices, same convention as webhook sinks)

---

## 2. Verification

| Gate | Result |
|---|---|
| `vitest run` | 2024/123 passing |
| `tsc --noEmit` | clean |
| `next lint` | clean |
| `npm audit --omit=dev` | unchanged (5 vulns: 4 moderate, 1 high) |
| Determinism (5×) | 196/196 pass every run on R45-touched files |

Baseline at start of run (R44 close): 1946/120. Net delta: **+78 tests, +3 new audit files.**

Also modified (non-test): `lib/forms/moving-intake.ts`, `lib/forms/cleaning-intake.ts`, `lib/actions/waitlist.ts`, `supabase/migrations/0007_phase8_contact_release.sql`, `tests/helpers/source-walker.ts`, `lib/email/templates-render-shape-drift.test.ts` (workaround lift), `lib/actions/actions-zod-schema-drift.test.ts` (parser extension), `supabase/rls-policy-drift.test.ts` (idempotent drop-then-recreate allowance), `app/route-handler-exports-drift.test.ts`, `app/route-response-headers-drift.test.ts`, `app/route-response-shape-drift.test.ts`, `app/route-reason-audit.test.ts`.

---

## 3. Outstanding human-input items

Still 14 — unchanged from R44. Ranked by impact:

1. **Sentry DSN** — ~43 capture sites still wired to the stub.
2. **Next.js cross-major bump** — 6 CVEs, needs pre-approval (still `next@16.2.4` target).
3. **Resend cross-major bump** — needs pre-approval (`resend@6.1.3` target, closes 2 transitive CVEs via svix/uuid).
4. **Daily-report archival policy** — strict cutoff vs. keep-last-N. Top-level `docs/` now has 15 R-reports (R31–R45).
5–12. Pre-launch checklist confirmations.
13. R42 archival-script tradeoff.
14. Debug scratch cleanup (`tests/.debug/`, `scripts/debug-walker.mts` — both no-ops; safe to `rm -rf`).

---

## 4. Notes the operator should see

- **R45(a) lands the long-tail walker fix.** Nested template literals are no longer a blind spot. The shared `extractExportedFunctionBody` now handles every source in the repo. If a new source audit needs to walk a function body containing nested templates (HTML email renderers, JSX-in-a-string), it can use the shared helper directly — no workaround required.
- **R45(c) caught real production-relevant drift.** Two naked `create policy` statements in 0007 would have crashed a disaster-recovery re-apply. Now idempotent. Pattern confirmed: ship the audit, act on the findings the same round.
- **R45(d) reduces copy-paste surface.** One canonical email chain, one ZIP regex, one state enum, one phone regex. A future vertical (handyman, lawn-care) that collects contact info just imports the primitives — no chance to silently drift to `z.string().email().toLowerCase().trim()` (wrong order) or `z.string().min(5)` (loose ZIP).
- **Two pre-existing route files showed up unclassified.** `app/api/places/autocomplete/route.ts` and `app/api/places/details/route.ts` — these appear to be Google Places proxies for address autocomplete in the intake form. The audits caught them immediately on full-suite run; added to the catalogs in R45(e). Flag: no rate limiting or auth on these routes today. They're behind the `GOOGLE_PLACES_API_KEY` env var (server-only) but the endpoints are otherwise open — a scraper could burn through the API quota. Consider rate limiting via the shared `assertRateLimitFromHeaders` helper before launch.

---

## 5. Suggested next autonomous run (Round 46)

**(a)** Places proxy hardening — add rate limiting to `/api/places/autocomplete` and `/api/places/details`, then lock the response contracts in `EXPECTED_SHAPES`. ~45 min.

**(b)** Env-var validation tightening — `lib/env.ts` currently uses loose `.email()` on support email. If the allow-list entry is ever expanded, the audit needs to grow with it. Consider adding `EmailSchema.optional()` as the canonical env-email primitive. ~20 min.

**(c)** Intake READ-path audit extension — now that the walker handles nested templates, revisit `intake-read-path-drift` for any READ sites inside HTML email renderers that might have been missed under the R41 workaround. ~30 min.

**(d)** Automate the "new route catalog" gap. R45(e) patched 4 catalogs manually. A meta-audit could cross-reference them — one list of expected routes, every drift audit consumes it. ~45 min.

**(e)** `scripts/archive-daily-reports.ts` — gated on human input #4.

**(f)** Next.js CVE bump — gated on pre-approval.

**(g)** Resend CVE bump — gated on pre-approval (new in R45).

**(h)** Preview-deploy smoke run — human-gated, first real exercise of R34's `smoke-webhook-preview`.
