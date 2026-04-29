# Daily Report — 2026-04-24 Round 44

**Autonomous scheduled run, continued.** Task file: `refine-code---evenquote`. Ran R44(a)-(e) after closing R43 earlier today.

---

## TL;DR

- **Tests:** 1946 passing across 120 files. R43 close baseline: 1880/116. **Delta: +66 tests, +4 files.**
- **`tsc --noEmit`:** clean.
- **`next lint`:** clean.
- **`npm audit --omit=dev`:** unchanged (5 vulns: 4 moderate, 1 high).
- **Determinism:** 5/5 runs on all R44-touched files — 148/148 pass every run.
- **R43(a) drift re-run caught TWO previously-masked drifts** — both fixed in the same round.

---

## 1. Shipped

### R44(a) — RPC return-type + TS cast round-trip extension

**File added:** `supabase/rpc-return-shape-roundtrip-extension.test.ts` (+10 tests).

Companion to R37(a) (`rpc-return-shape-drift.test.ts`). Catalogs every public RPC into three sets:

- `EXPECTED_TABLE_RPCS` = {apply_call_end, pick_vapi_number, businesses_within_radius}
- `EXPECTED_SCALAR_RPCS` = {recompute_business_success_rate, increment_quotes_collected, set_updated_at, handle_new_user, is_admin}
- `CONSUMED_TABLE_RPCS` (app destructures) = {pick_vapi_number, businesses_within_radius}
- `NON_CONSUMED_TABLE_RPCS` (app must not destructure) = {apply_call_end}

Per-RPC invariants:
- Migration-catalog = EXPECTED_TABLE ∪ EXPECTED_SCALAR (exact match)
- CONSUMED ∪ NON_CONSUMED = EXPECTED_TABLE (exhaustive classification)
- NON_CONSUMED table RPCs must have no `data[...]` or `data?.[...]` destructure at any call site — guards against a future refactor that adds destructuring without also adding a shape round-trip
- pick_vapi_number cast EXACTLY equals migration columns (parallel lock to R37(a))
- businesses_within_radius app-consumed fields are a SUBSET of migration columns
- Cross-call-site shape consistency: same RPC destructured at multiple call sites must name the same field set

Parser is independent of R37(a)'s — so a parser change in one file doesn't silently propagate.

### R44(b) — Supabase seed data integrity audit

**File added:** `supabase/seed-businesses-integrity.test.ts` (+15 tests).

PII/safety lock on `supabase/seed/0002_sample_businesses.sql`. Parses the `from (values (row1), (row2), …)` block and asserts per-row:

- Phone matches `+1-555-01XX` (reserved fictional NANP range — never routes to a real line)
- Email uses `.test` TLD (RFC 6761 — never resolves)
- Website is under `https://example.test/` (RFC 2606 + 6761)
- `google_place_id` begins with `seed_place_` (no real Google IDs)
- ZIP is 5 digits, state is 2 uppercase letters
- `google_rating` ∈ [0, 5], `google_review_count` ≥ 0
- `latitude` ∈ [-90, 90], `longitude` ∈ [-180, 180]
- Phones, emails, and place_ids are globally unique
- Row count bounded 15–40 (tripwire for accidental paste of large real datasets)
- File uses the `with moving_cat as (…)` CTE convention with EXACTLY ONE `insert into public.businesses`

All 20 rows today pass.

### R44(c) — Cache-Control exact-shape lock

**File added:** `app/route-response-headers-exact-shape.test.ts` (+34 tests).

Extends R43(c) (prefix-only check) to require the EXACT canonical string for non-cacheable routes that set Cache-Control:

```
no-store, no-cache, must-revalidate, max-age=0
```

Both `must-revalidate` (belt for shared-cache edge cases) and `max-age=0` (belt for client-side caches) are locked. A FORBIDDEN_VARIANTS check pins down known near-misses (`no-store`, `no-store, private`, mixed-case, etc.) so a future refactor that degrades the header variant trips the audit.

At least one NON_CACHEABLE route must set the canonical value — prevents a scenario where every route silently drops the header and the exact-shape lock vacuously passes.

### R44(d) — Source-walker re-run drift check

**Two previously-masked drifts surfaced and fixed:**

**Drift 1:** `lib/actions/admin.ts:retryUnreachedBusinesses` — a real exported ok-union action missing from the FIXTURES catalog in `actions-return-convention-audit.test.ts`. Added fixture entry + bumped `FIXTURES.length === 10` to `=== 11` + bumped majority-guard threshold 6 → 7.

**Drift 2:** `app/admin/users/[id]/page.tsx` reads intake_data via PostgREST `.ilike('intake_data->>contact_email', …)` — a JSON-path read that the existing extractors (`intake.foo` and `intake['foo']`) didn't recognize. Fix:
- Added new extractor `extractPostgRESTKeys` (matches `intake_data->>key` and `intake_data->'key'`)
- Added READ_SITES entry for the page with `reads: {contact_email}`

Net delta on these two files: +2 tests (24 → 26 on intake-read-path-drift) + 1 test (18 → 19 on actions-return-convention-audit).

### R44(e) — Lift R42(b) column-0 workaround (investigated, not lifted)

Attempted to replace the column-0 `}` workaround in `lib/email/templates-render-shape-drift.test.ts` with the new regex-aware `extractExportedFunctionBody` helper (added to `tests/helpers/source-walker.ts` as a non-async variant). The lift **failed at runtime** because `templates.ts` uses **nested template literals** like:

```js
`<tr>${cond ? `<td>${x}</td>` : ''}</tr>`
```

R43(a) solved regex-literal boundaries but `${...}` substitution boundaries inside template literals remain a blind spot in the string-state tracker. The first inner `` ` `` is misread as closing the outer template, which bleeds the brace walk into other scopes and causes the extractor to return `null`.

**Net work:** kept the column-0 `}` workaround in place but added `extractExportedFunctionBody` to the shared helper (with 3 tests) — it works for sources without nested template literals, which is the common case. The in-file workaround now has a detailed header comment explaining the nested-template-literal blind spot so a future R4X round can choose to either (a) fix the walker with a `${...}`-aware state stack, or (b) keep the convention indefinitely.

---

## 2. Verification

| Gate | Result |
|---|---|
| `vitest run` | 1946/120 passing |
| `tsc --noEmit` | clean |
| `next lint` | clean |
| `npm audit --omit=dev` | unchanged (5 vulns: 4 moderate, 1 high) |
| Determinism (5x) | 148/148 pass every run on R44 files |

Baseline at start of run (R43 close): 1880/116. Net delta: **+66 tests, +4 new files.**

---

## 3. Outstanding human-input items

Still 14 — unchanged from R43. Ranked by impact:

1. **Sentry DSN** — ~43 capture sites still wired to the stub.
2. **Next.js cross-major bump** — 6 CVEs, needs pre-approval.
3. **Resend cross-major bump** — needs pre-approval.
4. **Daily-report archival policy** — strict cutoff vs. keep-last-N.
5–12. Pre-launch checklist confirmations.
13. R42 archival-script tradeoff.
14. Debug scratch cleanup (`tests/.debug/`, `scripts/debug-walker.mts` — both no-ops).

---

## 4. Notes the operator should see

- **R43(a) worked as intended.** The re-run drift check (R44(d)) surfaced two real, previously-masked drifts in working code. Both were fixed in the same round. This validates the R43(a) investment — the stripper had been hiding issues.
- **Nested template literals are the next blind spot.** R43(a) solved regex literals. Nested `` `${` `}` `` boundaries inside templates need a proper state-stack walker to fully solve. Optional R45 item; current column-0 `}` convention workaround is fine as long as people don't reformat templates.ts.
- **The catalog-driven extension pattern continues to land value.** Both R43 and R44 shipped companion audits (R37(a) → R44(a), R40(d) → R44(b), R43(c) → R44(c)) that extend existing locks rather than rewriting them. Small, independently-testable files per invariant.

---

## 5. Suggested next autonomous run (Round 45)

**(a)** `${...}`-aware state-stack walker in `tests/helpers/source-walker.ts`. Enables lifting the column-0 workaround in templates-render-shape-drift + any future template-heavy source. ~45 min.

**(b)** RLS policy predicate-body drift audit extension — verify R39's predicate-body audit covers every `create policy` statement across all migrations. ~30 min.

**(c)** Supabase migration idempotency re-run audit — confirm every migration uses `create or replace` / `if not exists` / `drop ... if exists` safely. ~30 min.

**(d)** Zod schema shared-primitive drift audit — `UsStateSchema`, `ZipSchema`, `EmailSchema` must be used consistently across moving/cleaning/intake actions. ~30 min.

**(e)** `scripts/archive-daily-reports.ts` — gated on human input #4.

**(f)** Next.js CVE bump — gated on pre-approval.

**(g)** Preview-deploy smoke run — human-gated.
