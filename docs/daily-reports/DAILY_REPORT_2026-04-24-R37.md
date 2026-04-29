# Daily report — 2026-04-24 (Round 37)

**Autonomous scheduled run.** No production code changed; all five shipped files are `.test.ts` or `.env.example` docs. The only mutating change outside tests is adding missing entries to `.env.example` so `tests/env-var-audit.test.ts` passes on first run.

## Headline numbers

- `npx vitest run`: **1283 passed / 98 files** (R36: 1222/93). Delta **+61 tests, +5 new files**.
- `npx tsc --noEmit`: clean.
- `npx next lint`: clean.
- `npm audit --omit=dev`: unchanged at 4 vulns (3 moderate, 1 high — next, uuid, svix, resend). All cross-major; all still blocked on your pre-approval.
- Determinism spot-check: 5× runs of the 5 R37-touched test files → **61/61 pass every run**.

---

## What shipped this round

### 1. `supabase/rpc-return-shape-drift.test.ts` — NEW, 11 tests

R37(a). Counterpart to R36(d)'s RPC argument round-trip audit (`supabase/rpc-args-drift.test.ts`). R36(d) locks INPUTS; this file locks OUTPUTS.

Parses every `create or replace function public.<name>(...) returns ...` body in `supabase/migrations/` in lexical order. For each function, classifies the return as either:

- **Table** (`returns table (col1 type1, col2 type2, ...)`) — returns a record set. App consumes via `data[0]` or `.map((r: {...}) => ...)`. R37(a) locks the column name set.
- **Scalar** (`returns integer`, `returns numeric`, etc.) — returns a single value. App ignores the return (error-only check). R37(a) locks the scalar type token.

Per-RPC invariants locked:

- `apply_call_end` returns exactly 5 columns in canonical order (`request_id`, `status`, `total_calls_completed`, `total_quotes_collected`, `total_businesses_to_call`), sourced from `0008_end_of_call_idempotency.sql`.
- `pick_vapi_number` returns `{ id, twilio_e164, area_code, tier }` — exact match against the `data[0] as { ... }` cast in `lib/calls/select-vapi-number.ts`. Forward + reverse round-trip: every app field is declared in migration AND every migration column is named in app cast.
- `businesses_within_radius` returns a superset of the 5 columns `lib/calls/select-businesses.ts` maps over; the .map() body cannot reference columns the migration doesn't return.
- `recompute_business_success_rate` stays `scalar numeric`.
- `increment_quotes_collected` stays `scalar integer`.
- **Forbidden-destructure** lock: every scalar-return RPC the app calls scanned for `data[` / `data?.[` in a 400-char window after the `.rpc('...')` call. Fails if anyone ever tries to destructure a scalar.

### 2. `supabase/rpc-args-type-drift.test.ts` — NEW, 13 tests

R37(b). R36(d) locks arg NAMES. R37(b) extends the parser to capture TYPES too and locks the expected type for every arg the app relies on.

Reuses the `canonicalizeType()` vocabulary from R36(b)'s `supabase/migrations-drift.test.ts` — same vocabulary across column audits and RPC audits keeps the drift language consistent.

`EXPECTED_ARG_TYPES` map holds the drift-locked shape per RPC:

- `apply_call_end`: `p_request_id=uuid`, `p_call_id=uuid`, `p_quote_inserted=boolean` — all required.
- `recompute_business_success_rate`: `p_business_id=uuid` required, `p_window=int default 20`.
- `businesses_within_radius`: `p_category_id=uuid`, `p_lat/p_lng/p_radius_miles=numeric`, `p_limit=int` — all required.
- `pick_vapi_number`: `p_area_code=text` required, `p_daily_cap=int default 75`.
- `increment_quotes_collected`: single required `p_request_id=uuid`.

Plus two defense-in-depth lock tests:

- Every parsed type canonicalizes to a known vocabulary entry (extend `canonicalizeType()` if a new Postgres type lands — `inet`, `tsvector`, etc.).
- No arg named `p_*_id` or `p_*_uuid` has a non-uuid type (catches the "copy-pasted text column as-is" drift).

### 3. `app/api/csp-report/route-body-shape-drift.test.ts` — NEW, 11 tests

R37(c). The R32 attestation locks the no-capture contract + response envelope. R37(c) locks the orthogonal concern: the JSON body-shape contract the route depends on to normalize a browser-posted CSP violation.

Three concerns covered:

1. **Field-name vocabulary lock** — `summarize()` reads exactly these 6 kebab-case keys (`violated-directive`, `effective-directive`, `blocked-uri`, `document-uri`, `source-file`, `line-number`). Source-level grep fails on any camelCase / snake_case drift. Negative lock: the forbidden-drifts list (`violatedDirective`, `blocked_uri`, etc.) is asserted absent.
2. **Envelope disambiguator lock** — the `report-uri` envelope key is exactly `csp-report` (drifted keys like `csp_report` / `cspReport` must drop silently); the `report-to` envelope requires `type === 'csp-violation'` AND a `body` object (drifted types and malformed bodies must drop).
3. **Persist-column contract lock** — when `CSP_VIOLATIONS_PERSIST=true`, `persistViolation()` inserts exactly these 6 columns (`violated_directive`, `effective_directive`, `blocked_uri`, `document_uri`, `referrer`, `original_policy`). Query strings stripped from URLs (guest-token leak guard). Bare CSP keywords (`inline`, `eval`) preserved verbatim. `original_policy` bounded to 4096 chars. Env-gate lock on `CSP_VIOLATIONS_PERSIST` with strict case + whitespace handling.

### 4. `tests/env-var-audit.test.ts` — NEW, 8 tests

R37(d). Every `process.env.X` across `app/`, `lib/`, `scripts/`, `components/`, `middleware.ts`, `next.config.mjs` must be accounted for in one of:

- `.env.example` (active `KEY=…` or commented-reference `# KEY=`), OR
- `PLATFORM_ALLOWLIST` — Vercel / Node / Next built-ins (`NODE_ENV`, `VERCEL_*`, `CRON_SECRET`, `NEXT_PUBLIC_BUILD_SHA`, `BUILD_TIME`).

Anything else fails the audit. Remediation is always either "document it" or "add to the platform allow-list if runtime-injected".

Supporting tests:

- No `.env.example` entry that's never read (catches stale docs). Three tolerated exceptions: `GOOGLE_OAUTH_CLIENT_ID/_SECRET` (Supabase handles OAuth server-side), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (reserved), `STRIPE_PRICE_ID_QUOTE_REQUEST` (reserved for catalog pricing), `SENTRY_TRACES_SAMPLE_RATE` (consumed inside `@sentry/nextjs` SDK init).
- `PLATFORM_ALLOWLIST` is tight — no var appears both there AND in `.env.example`.
- High-value secrets (STRIPE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY, VAPI_API_KEY, VAPI_WEBHOOK_SECRET, TWILIO_AUTH_TOKEN, public Supabase URL/anon key, NEXT_PUBLIC_APP_URL, MAINTENANCE_MODE) MUST be documented (belt-and-braces against hiding a secret via platform allow-list).
- Recent R37-added vars present in `.env.example` (CSP_VIOLATIONS_PERSIST, SENTRY_DSN, SENTRY_TRACES_SAMPLE_RATE, DEV_TRIGGER_TOKEN, TEST_OVERRIDE_PHONE, ALLOW_PROD_SEED, VAPI_CALLBACK_NUMBER).
- Every `NEXT_PUBLIC_` var in source is documented — client bundle cannot fallback; build-time missing var silently breaks.

**Mutating changes this landed on `.env.example`**: added `TWILIO_AUTH_TOKEN` (previously undocumented — route HARD-REFUSES in prod if unset, so this was a real doc gap), added `VAPI_CALLBACK_NUMBER` as commented-reference, added `CSP_VIOLATIONS_PERSIST`, added R37 **Observability**, **Dev-only auth**, and **Scripts** sections documenting `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `DEV_TRIGGER_TOKEN`, `TEST_OVERRIDE_PHONE`, `ALLOW_PROD_SEED`. Every addition is a commented-reference (not an active line) so no default value changes.

### 5. `lib/actions/actions-return-convention-audit.test.ts` — NEW, 18 tests

R37(g). Server actions across `lib/actions/` use three distinct return conventions today. Rather than force a cross-cutting refactor, the audit freezes the current shape-per-action so drift is caught:

- **ok-union** (`{ ok: true; ... } | { ok: false; error; ... }`) — admin, checkout, intake, cleaning-intake, waitlist, release-contact (6 actions).
- **error-union** (`{ error: string } | { ok: true }`) — legacy Next useFormState-compatible shape, capped at auth.ts's `signInWithMagicLink` + `signInWithGoogle` (2 actions).
- **void-or-redirect** (`Promise<void>`) — auth.ts:`signOut` (redirects) + post-payment.ts:`sendPaymentMagicLink` (pure void, internal utility) (2 actions).

Per-fixture source-level invariants per convention:

- **ok-union** must have both `return { ok: true …}` and `return { ok: false … error:…}` branches; declared Result type name ends in `Result`; forbidden bare `{ error: '…' }` returns (catches drift back to legacy shape).
- **error-union** must have `{ error: '…' }` return and either `{ ok: true }` return or a `redirect()` exit; forbidden ANY `{ ok: false …}` return (catches half-migrated actions).
- **void-or-redirect** must have no value-returning `return` statements; `redirect(...)` is expected except for post-payment which is deliberate pure-void.

Cross-action invariants:

- FIXTURES count is exactly 10 — adding a new exported `async function` forces an explicit convention choice.
- Every `export async function` in `lib/actions/` (minus test/audit files) appears in FIXTURES.
- ok-union majority (>=6) holds.
- error-union is capped at `auth.ts` (no spread to new files).
- void-or-redirect is capped at `{ auth:signOut, post-payment:sendPaymentMagicLink }`.
- Every action file has at least one FIXTURES entry.

Parser note: implemented a position-preserving comment stripper with even-backslash-count escape detection. First version tripped on `'\\'` literals (string containing one backslash) because `chars[i-1] !== '\\'` reads `\` before `'` as an escape even when that `\` is part of `\\`. Fixed by walking backward from the quote and counting consecutive backslashes; only odd counts skip. Canonical pattern for any future source audit.

---

## What you need from me (daily action items)

The outstanding backlog is unchanged from R36. All 12 items carry over; nothing new opened.

### P0 — highest-value, ready whenever you are

1. **Sentry DSN unlock** (user-input #6). ~43 capture sites fully locked at contract level but still no-op at runtime because the DSN env is blank. One-line Vercel env change + redeploy. R32's `sentry-wiring.test.ts` machine-checks stub↔SDK signature parity; day-one won't surprise us. R37 additionally locks the R37(d) env-var audit contract on `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` so they're documented in `.env.example` now.

### P1 — dependency updates, need your approval

2. **Next.js 14.3.x CVE bump.** Same posture as R36 — high-severity moderate, held off per standing feedback.
3. **`uuid` / `svix` / `resend` chain bump.** `npm audit fix --force` would break-major on Resend (v6). Pre-approval gated.
4. **MSW + supertest pre-approval** OR confirm smoke-script alternative (shipped R34 as `scripts/smoke-webhook-preview.ts`) is the preferred long-term path.

### P2 — infrastructure, one-time

5. **Upstash Redis migration** for rate-limit persistence across Vercel cold starts.

### P3 — product-readiness, needs content/review decisions

6. **Legal pages draft + noindex.** Terms, Privacy, Refund. Holding per "NOT LEGAL ADVICE" boundary.
7. **First preview-deploy smoke run.** R34 script never exercised end-to-end. Runbook: `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md`.

### P4 — nice-to-haves, shippable when convenient

8. **Google Places ingest cap** — one-per-region per day.
9. **/admin/audit-log** page — structured-logger read view.
10. **Vapi assistant versioning** pin.
11. **Stripe tax handling confirmation** for the flat $9.99.
12. **Email deliverability warm-up** — from-address reputation.

---

## Patterns introduced in R37 (for future maintainers + next round)

1. **RPC return-shape parser** — `supabase/rpc-return-shape-drift.test.ts`. Extends the existing R36(d) arg parser infrastructure. Two classifications (table / scalar) + app-side TS-cast round-trip. Reuse for any new `returns table (...)` migration.
2. **RPC arg type parser** — `supabase/rpc-args-type-drift.test.ts`. The third reuse of the R36(b) `canonicalizeType()` vocabulary (columns → migration-types → RPC-arg-types). Keep the vocabulary consistent across all three.
3. **CSP body-shape drift** — `app/api/csp-report/route-body-shape-drift.test.ts`. Pattern for locking a route's parser vocabulary against field-name drift + persist-column drift + envelope-disambiguator drift. Reuse for any telemetry sink that normalizes an external body shape.
4. **Env-var audit** — `tests/env-var-audit.test.ts`. Reuse: any new env var requires either an `.env.example` entry or a `PLATFORM_ALLOWLIST` addition. The audit is static-grep — no runtime cost.
5. **Position-preserving comment stripper with even-backslash escape** — `lib/actions/actions-return-convention-audit.test.ts` `stripCommentsPreservingPositions()`. Corrects the `'\\'` string bug in the naive `chars[i-1] !== '\\'` check. Lift to a shared helper under `tests/helpers/` if a fourth use-site lands in R38+.
6. **Fixture-driven convention audit** — `lib/actions/actions-return-convention-audit.test.ts` `FIXTURES[]`. Freezes current mixed conventions without forcing a refactor. Reuse for any codebase-wide mixed-convention situation.

---

## Suggested next autonomous run (Round 38)

(a) **Lift the position-preserving comment stripper + balanced-brace walker to `tests/helpers/source-walker.ts`** — third use-site landed in R37; DRY the pattern before R38. ~20 min.

(b) **Per-route response-shape drift** — most webhook routes return `NextResponse.json(...)` with a stable shape (`{ok, error?, received?}` etc.) that external clients (Stripe retry logic, Vapi retry logic, Twilio) depend on. Lock the shape per-route source-level. ~45 min.

(c) **Zod-schema drift audit** — `lib/actions/intake.ts` + `cleaning-intake.ts` + `waitlist.ts` + `checkout.ts` all carry zod schemas. If a column type in a migration drifts, the zod shape doesn't auto-follow. Cross-check zod .string() / .number() / .uuid() against the column types the action inserts. ~45 min.

(d) **Supabase RLS-policy drift** — migrations declare `create policy ...` but nothing locks the allowed action sets (SELECT/INSERT/UPDATE/DELETE) per-role. A silent policy-weakening is the highest-blast-radius regression this codebase has. ~60 min.

(e) **Next.js 14.3.x CVE bump IF pre-approved.** ~45 min.

(f) **Preview-deploy smoke run (human).** First exercise of R34's `smoke-webhook-preview` script against a real preview URL.

(g) **Daily-report archival policy** — the `docs/` folder has 16 daily reports now and no retention rule. At ~2KB each the growth is fine, but at R50+ it'd clutter directory listings. Decide: keep all, or tar-archive to `docs/archive/` on R45. ~15 min one-time decision.

---

## Memory update

- R37 capture-site count unchanged at ~43 — no new production captureException sites.
- Locked lib tag shapes unchanged from R35.
- Locked route tag shapes unchanged from R35.
- R37 user-input items unchanged at 12.
- `.env.example` grew from 27 documented vars to 35 (added commented-references for R37's audit coverage).
- Test count: 1222 → 1283 (+61 across 5 new files).

## No production code changed this round

Every file touched is `.test.ts` or (`.env.example`) operator documentation. No runtime behavior changed; no risk to revenue flows. The new audits fail on drift, not on today's code.
