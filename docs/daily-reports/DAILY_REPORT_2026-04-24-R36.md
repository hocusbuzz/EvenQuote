# EvenQuote — Daily Report R36 (2026-04-24)

**Run type:** autonomous scheduled run (user away)
**Baseline (R35 close):** 1170 tests across 90 files, `tsc --noEmit` clean, `next lint` clean, `npm audit --omit=dev` 4 vulns (3 moderate, 1 high).
**Close (R36):** 1222 tests across 93 files, `tsc --noEmit` clean, `next lint` clean, `npm audit --omit=dev` unchanged at 4 vulns.
**Delta:** +52 tests, +3 new files, +1 extended file, zero production-code changes.

---

## TL;DR for the founder

Four audits shipped, all source-level, zero runtime risk:

1. **Route-level Reason allow-list audit** (+11 tests, new file). Catches the same Sentry-alert fragmentation risk R35 caught for `lib/` — but at the `app/**/route.ts` layer, where Reason types aren't exported as TS unions.
2. **Migrations TYPE drift extension** (+5 tests, extended file). The R35 migrations audit locked column NAMES; R36 adds column TYPES. Catches drift like "contact_email widened from text to jsonb" that would silently bypass the PII redactor.
3. **Rate-limit boundary audit extension** (+26 tests, new file). Mirrors R35's intake audit at source level for the 3 other unaudited rate-limited server actions: `waitlist`, `auth:magic`, `auth:google`, `checkout`.
4. **RPC argument round-trip audit** (+10 tests, new file). Parses `create or replace function public.<name>(...)` bodies in migrations AND `.rpc('<name>', {...})` calls in app code, asserts set-equality minus defaults. Catches "p_request_id renamed to p_quote_request_id" drift.

**No new Sentry capture sites.** All four audits are attestation + drift-catch. Capture-site count stays at ~43. The DSN-unlock day (user-input #6) still matters; R36 continues the R33–R35 posture of *not shipping new stubs but locking every surface against shape drift* so day-one sees zero surprises.

**You need to do 0 things to merge this.** The diffs are tests only — no production code touched. Merge-safe as long as the 1222 tests keep passing in CI.

---

## What shipped

### 1. `app/route-reason-audit.test.ts` — NEW, 11 tests

Cross-route `{ route, reason }` allow-list audit. The R35 `lib/lib-reason-types.test.ts` audit works because every `lib/` module that emits a `reason:` tag also *exports* an `XxxReason` union — the audit can round-trip declared-vs-emitted. Routes don't export union types; the literals appear inline on the `captureException(...)` call.

R36 closes that gap with a per-route allow-list baked into the test file:

```ts
const EXPECTED_REASONS: Record<string, readonly string[]> = {
  'auth/callback': ['exchangeCodeForSessionFailed'],
  'cron/check-status': ['integrationProbeFailed'],
  'cron/retry-failed-calls': ['runFailed'],
  'cron/send-reports': ['runFailed'],
  'get-quotes/claim': ['requestLoadFailed', 'quoteBackfillFailed'],
};
```

Plus a reason-less-routes allow-list (webhooks use `{ route, vapiCallId }` / `{ route, eventType }` per R26 memo) and a Stripe-specific `site:` sub-allow-list (`'magic-link' | 'enqueue-calls'` for the inner capture blocks).

Guards include: ghost-reason (declared but not emitted), ad-hoc-reason (emitted but not in allow-list), camelCase (no snake/kebab drift), forbidden catch-alls (`unknown`/`error`/`failed`/`runBatch`/`handlerError`), count band (8–25 total capture sites), and ghost-site-check for the Stripe `site:` convention.

### 2. `supabase/migrations-drift.test.ts` — EXTENDED, +5 tests (11 → 16)

The R35 drift-check locked column NAMES. The "out of scope for now" comment listed TYPE drift as a candidate for Round 36+; R36 delivers it.

New pieces:
- `canonicalizeType(raw)` — maps `integer`/`int4` → `int`, `numeric(9,6)` → `numeric`, `text`/`varchar`/`character varying` → `text`, enum types → `enum:<name>`, unknown tokens → the raw lowercase (fail-loudly).
- `parseCreateTableTypes` + `parseAlterAddColumnTypes` — sibling parsers that build a `TYPE_SCHEMA: Map<table, Map<column, type>>` without disturbing the R35 name-only `SCHEMA`.
- `TYPE_DEPENDENCIES` — per-(table, column) expected types for every load-bearing column: payment IDs are `text`, FKs are `uuid`, `contact_email` is `citext` (intentional, case-insensitive dedupe), enums are `enum:<name>`, etc.

One real finding during development: the existing R35 column-name comma splitter didn't respect string-literal boundaries, producing a ghost column `service_categories.this = 'is'` from the multi-line `disclosure_text` default that contains commas inside its quoted value. R36's new parser tracks `inString` state and handles Postgres doubled-quote escapes. The R35 name-only parser wasn't affected because it walks the same name-start regex anyway; the extra ghost entries simply showed up as not-app-dependencies and got skipped.

### 3. `lib/actions/actions-rate-limit-audit.test.ts` — NEW, 26 tests

R35's `lib/actions/intake-rate-limit-audit.test.ts` locked the boundary shape for `submitMovingIntake` + `submitCleaningIntake`. R36 extends the same invariants to the other 3 attacker-controlled rate-limited server actions:

- `waitlist.ts:joinWaitlist` — prefix `'waitlist'`, 5/min via `assertRateLimitFromHeaders`
- `auth.ts:signInWithMagicLink` — prefix `'auth:magic'`, 5/min via raw `rateLimit(clientKeyFromHeaders(...))`
- `auth.ts:signInWithGoogle` — prefix `'auth:google'`, 10/min via raw `rateLimit(...)`
- `checkout.ts:createCheckoutSession` — prefix `'checkout'`, 20/min via raw `rateLimit(...)`

Per-fixture, the audit source-level asserts:
1. Rate-limit call is present at all.
2. Rate-limit call precedes every gated I/O token (`safeParse`, `createAdminClient`, `createClient`, `signInWithOtp`, `signInWithOAuth`, `getStripe`).
3. Deny-path return token (`if (deny)` / `if (!rl.ok)`) sits after the rate-limit call and before every gated I/O.
4. Expected prefix literal is present.
5. `limit:` + `windowMs:` literals match (tolerates `60_000` vs `60000` numeric separators).

Plus cross-action: unique prefixes (no accidental bucket-sharing), fixture-count band (hard 4), `'use server'` directive presence.

### 4. `supabase/rpc-args-drift.test.ts` — NEW, 10 tests

R36(d): the most complex audit this round. Parses `create or replace function public.<name>(<args>)` bodies in every migration file in lexical order (later migrations win — Postgres `create or replace` semantics), builds a signature index of `(fnName → { args: [{name, hasDefault}] })`, then walks every `<client>.rpc('<name>', { key1, key2, ... })` call in `app/` + `lib/` and cross-references.

Invariants locked:
- Every RPC name the app calls is defined in at least one migration.
- Every app-supplied arg is declared in the signature (no unknown args sent to Postgres).
- Every REQUIRED arg (no `DEFAULT`) in the signature is passed by every caller (no silent-null).
- `apply_call_end` uses the post-R31 3-arg signature from `0008_end_of_call_idempotency.sql` (the `create or replace` overrode the 0006 2-arg form).
- `pick_vapi_number.p_daily_cap` keeps its `DEFAULT 75` so the single-arg caller in `lib/calls/select-vapi-number.ts` keeps working.
- `increment_quotes_collected` has exactly one required arg (`p_request_id`) — locked for the two webhook call sites (`twilio/sms` + `vapi/inbound-callback`).

The parser handles:
- `create or replace function` with or without the `public.` qualifier.
- `IN`/`OUT`/`INOUT` modifiers on args.
- `DEFAULT <expr>` and `= <expr>` shorthand for optional args.
- String-literal + paren-depth aware comma splitting in both the signature body and the app-side object literal.
- Balanced-brace walk on the JS object literal, respecting nested strings/templates.

---

## Verification

- `npx vitest run`: **1222 passed / 93 files** (R35: 1170/90). Delta +52 tests.
- `npx tsc --noEmit`: clean.
- `npx next lint`: clean.
- `npm audit --omit=dev`: unchanged at 4 vulns (3 moderate, 1 high — next, uuid, svix, resend). All cross-major; all still blocked on user pre-approval.
- Determinism spot-check: 5 consecutive runs of the 4 R36-touched files (`app/route-reason-audit.test.ts`, `lib/actions/actions-rate-limit-audit.test.ts`, `supabase/migrations-drift.test.ts`, `supabase/rpc-args-drift.test.ts`) — **63/63 pass every run**.

---

## What you need from me (clear action items)

The backlog didn't grow this round. Items below are the same 12 outstanding from R35, reproduced for convenience, in priority order:

### P0 — highest-value, ready whenever you are

1. **Sentry DSN unlock (user-input #6).** ~43 capture sites are fully locked at the contract level but still no-op at runtime because the DSN env var is blank. Flipping it on is a one-line Vercel env change and a redeploy. R32's `lib/observability/sentry-wiring.test.ts` machine-checks stub↔SDK signature parity so day-one won't surprise us.

### P1 — dependency updates, need your approval

2. **Next.js 14.3.x CVE bump.** `npm audit` flags `next` as high-severity moderate. Cross-major; I held off per standing feedback that dep bumps go through you.
3. **`uuid` / `svix` / `resend` chain bump.** All three feed each other; `npm audit fix --force` would break-major on Resend (v6). Also pre-approval gated.
4. **MSW + supertest pre-approval** OR confirm the smoke-script alternative is the preferred long-term path. R33's feasibility report recommended the smoke-script (shipped in R34 as `scripts/smoke-webhook-preview.ts`). If that's your call, you can safely close this open thread.

### P2 — infrastructure, one-time

5. **Upstash Redis migration.** The in-memory token-bucket rate limiter (`lib/rate-limit.ts`) resets on every Vercel instance cold-start. Moving to Upstash is a single-file swap inside that module; the helpers and audits all keep working because they're bucket-store agnostic.

### P3 — product-readiness, needs content/review decisions

6. **Legal pages draft + noindex.** Terms, Privacy, Refund. I've been holding off per your "NOT LEGAL ADVICE" boundary — I'll draft placeholders marked accordingly and keep them noindex + unlinked if you want, otherwise this waits for your lawyer.
7. **First preview-deploy smoke run.** Added in R34, never actually exercised end-to-end against a live preview. Runbook: `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md`. Takes ~3 minutes; you'd run it locally with a preview URL + cron secret.

### P4 — nice-to-haves, shippable when convenient

8. **Google Places ingest cap** — one-per-region per day. Currently unbounded.
9. **/admin/audit-log** page — pure read of structured logger output. Low blast radius.
10. **Vapi assistant versioning** — pin to a specific version so a prompt rev doesn't silently reshape every outbound call.
11. **Stripe tax handling confirmation** — flat $9.99 is currently sold tax-inclusive; confirm that's the intent before launch.
12. **Email deliverability warm-up** — from-address reputation is cold; Resend's warm-up tooling exists but needs configuration.

---

## Patterns introduced in R36 (for future maintainers + next round)

1. **Per-route Reason allow-list pattern** — `app/route-reason-audit.test.ts`. Extends the R35 `lib/` per-file Reason-type audit to the `app/` layer. Reuse for any future app route that gains a `reason:` tag convention.
2. **Type-aware migrations DDL parser** — `supabase/migrations-drift.test.ts` now contains both the R35 name-only `SCHEMA` and the R36 `TYPE_SCHEMA`. The type canonicalizer lives in `canonicalizeType()` — extend it when a new Postgres type lands (`inet`, `tsvector`, etc. currently fall through as unknown).
3. **Source-level rate-limit boundary audit** (fixture-driven) — `lib/actions/actions-rate-limit-audit.test.ts`. Iterates a `FIXTURES` array; each entry is one server action. Reuse for any future rate-limited server action by adding a fixture row.
4. **RPC signature round-trip audit** — `supabase/rpc-args-drift.test.ts`. Parses `create or replace function public.<name>(...)` and `<client>.rpc('<name>', {...})`. `IN/OUT/INOUT` and `DEFAULT <expr>` / `= <expr>` shorthand all handled.

---

## Suggested next autonomous run (Round 37)

(a) **RPC RETURN-shape drift lock** — R36(d) covers args. Return tables / scalar return types are the next surface; parse `returns table (...)` bodies and assert the app-side call-site destructuring matches. ~45 min.

(b) **RPC argument TYPE drift** — R36(d) locks arg NAMES. Matching arg TYPES (uuid vs text vs int) is analogous to R36(b)'s column-type extension. Catches "p_request_id widened from uuid to text" drift that would break the app's UUID zod-parse round-trip. ~30 min.

(c) **CSP-report route body shape drift** — `app/api/csp-report/route.ts` is attested no-capture (R32), but the body-parse structure isn't locked. If a browser vendor changes their CSP report JSON shape, the persist-path might silently drop violations. ~30 min.

(d) **Environment-variable audit** — lock the set of env vars the codebase reads. A `process.env.X` appearing in a new file without a matching entry in `.env.example` would fire the audit, catching "forgotten env var" deploy misses. ~45 min.

(e) **Next.js 14.3.x CVE bump IF pre-approved.** ~45 min.

(f) **Preview-deploy smoke run (human).** First exercise of R34's `smoke-webhook-preview` script against a real preview URL.

(g) **Server action no-throw audit** — server actions returning `{ ok: false, error: ... }` objects vs throwing. Mixed conventions currently; lock the chosen convention and fail drift. ~30 min.

---

## Memory update

- R36 capture-site count unchanged at ~43.
- Locked lib tag shapes unchanged from R35.
- Locked route tag shapes unchanged from R35; now additionally locked via `app/route-reason-audit.test.ts`.
- R36 new patterns documented above.
- R36 user-input items unchanged at 12.

## No production code changed this round

Every file touched is a `.test.ts`. No runtime behavior changed; no risk to revenue flows. The audits fail on drift, not on today's code.
