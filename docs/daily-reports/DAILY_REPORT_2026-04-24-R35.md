# EvenQuote daily report — Round 35 (2026-04-24, autonomous run)

## TL;DR

Test count: **1170 passing across 90 files** (R34 baseline: 1124/87;
delta **+46 tests, +3 new files**). `tsc --noEmit` clean. `next lint`
clean. `npm audit --omit=dev` unchanged (4 vulns: 3 moderate, 1 high
— next, uuid, svix, resend; all cross-major; all still blocked on
your pre-approval).

Focus this round: closing out R34's "suggested R35" backlog —
the four items that didn't require your input. The two that did
(Next.js 14.3.x bump, preview-deploy smoke run) stay open in the
human-input list at the bottom.

## Shipped

### 1. `/robots.txt` + `/sitemap.xml` observability attestation (R35 item a)

Added R32-style telemetry-sink + R33 probe-endpoint attestation to
both generators:

- `app/robots.ts` — three-point header comment documenting why
  `captureException` is deliberately not wired (pure function, no
  I/O, public bot-crawl frequency, platform owns the route
  boundary). Pure code change is zero-byte aside from the comment.
- `app/sitemap.ts` — three-point header documenting why the
  existing `try { … } catch { categories = []; }` graceful-
  degradation block stays uncaptured (public-bot-crawl frequency,
  graceful degradation IS the feature, downstream surfaces would
  surface the underlying Supabase outage with their own canonical
  capture tags before sitemap noise is the first signal).

Test-side: new `observability contract — no capture` blocks in
`app/robots.test.ts` (4 → 8 tests) and `app/sitemap.test.ts`
(6 → 13 tests). Each block iterates the documented input shapes
(default invocation, env override, pathological env values for
robots; happy DB / empty data / null data / createAdminClient
throw / select throws mid-call / env override for sitemap),
asserts no captureException/captureMessage call across each, and
closes with a source-level grep (with comment-stripping) that
fails if any future maintainer wires capture in code.

The `sitemap.ts` source-level grep is load-bearing: sitemap is
the only file in this audit class that does real I/O, and a
future maintainer might be tempted to "just add Sentry to the
catch block" without realizing the public-bot-crawl frequency
makes that a Sentry-flood foot-gun.

Net: +11 tests, 0 new capture sites, 2 attestation files.

### 2. `lib/` Reason-type ↔ capture-site allow-list audit (R35 item b)

New file: `lib/lib-reason-types.test.ts` (+10 tests). Cross-module
audit that closes the gap between "every captureException tags a
reason" (R33 / R34 audits) and "every declared XxxReason union
member is wired AND every captured reason value is in the union."

Discovers all `export type XxxReason = '…' | '…' | …;`
declarations across `lib/**/*.ts` (R34 close: 9 distinct
declarations across 9 files), parses union members via regex,
and per-file:

- Asserts every declared union member is emitted at a capture
  site somewhere in the same source file (no "ghost reason
  values" — declared but never fired). A ghost member is
  misinformation that fools future Sentry alert-rule writers
  into expecting an event class that never lands.
- Asserts every emitted reason literal is declared in the
  file's Reason union (no "ad-hoc reason values" — captured
  but not in the type).
- Locks union member casing as camelCase (drift guard against
  silent snake_case / kebab-case Sentry alert fragmentation).
- Forbids duplicate union members.
- Forbids empty unions.
- Tripwire allow-lists (`ALLOWED_GHOST_MEMBERS`,
  `ALLOWED_AD_HOC_MEMBERS`) — both empty in steady state, both
  size-asserted to catch silent allow-list bloat.
- Count band 7-30 to catch drift in either direction.

The reason-literal extractor is scope-aware: it walks
`captureException(…)` argument lists with a balanced-paren
walker (reused from R34's `lib-capture-sites.test.ts`) so
`reason:` keys on result objects, Stripe API params, and
simulation-mode return values don't false-positive. Also
recognises `tagsFor('literal')` helper calls for files that
factor their tag construction (canonical: `lib/email/resend.ts`).

Net: +10 tests in 1 new file, 0 new capture sites.

### 3. Rate-limit boundary audit on intake server actions (R35 item c)

New file: `lib/actions/intake-rate-limit-audit.test.ts` (+14 tests).
The two intake actions are the only attacker-controlled entry
points in the entire app that don't authenticate via signed
payload first — every other unauthenticated POST surface
(Stripe / Vapi / Twilio webhooks) verifies a signature before
doing any work.

That makes `assertRateLimit()` the single barrier between an
attacker and (a) Supabase quota burn, (b) free
`service_categories` lookups, (c) free `quote_requests` rows in
`pending_payment` state. The per-action tests already cover the
basic 10/min/IP behaviour; this audit locks the SHAPE of the
boundary itself:

1. **Order: rate-limit fires before zod.** If zod ran first,
   an attacker could spam invalid payloads faster than the
   limiter blocks them. Test sends 10 valid + 1 garbage; the
   garbage attempt must surface the rate-limit error, not the
   zod fieldErrors response.
2. **Order: rate-limit fires before the DB lookup.** Spy on
   `service_categories` select count — must be exactly 10
   after 11 attempts, with no spike on the blocked attempt.
3. **Per-IP partitioning.** IP A maxing the bucket must not
   block IP B. Uses mutable header refs so the in-memory
   `buckets` Map persists across sub-requests in a single test
   (vi.resetModules() would reset the map and false-pass).
4. **Cross-vertical isolation (intentional).** A moving-blocked
   IP can still submit cleaning. Trade-off: 10 + 10 = 20/min
   per IP — known and accepted.
5. **x-forwarded-for first-IP semantics.** Multi-hop XFF parsed
   as the leftmost IP (Vercel-style). Same leftmost IP across
   different proxy chains stays in the same bucket; different
   leftmost IP gets a fresh bucket.
6. **Header-stripping defense.** No XFF and no x-real-ip falls
   into the global `unknown` bucket — header-strippers can't
   escape the limiter by hiding their IP.
7. **x-real-ip fallback** when XFF is absent.
8. **Source-level: rateLimit() is the FIRST statement** in
   both intake.ts and cleaning-intake.ts. Drift-guard: a
   future refactor that moves the limiter below zod or below
   the createAdminClient call silently widens the attack
   surface; this test fires before that lands.
9. **Source-level: key-prefix partitioning.** intake.ts uses
   `'intake:moving'` (and NOT `'intake:cleaning'`); cleaning-
   intake.ts uses `'intake:cleaning'` (and NOT
   `'intake:moving'`). Negative assertions catch a copy-paste
   typo that would silently merge the two buckets.
10. **Source-level: limit/windowMs values bounded.** Both
    actions use `limit:10 windowMs:60_000`. Drift-guard against
    silent loosening — if a deliberate change happens, this
    test forces a code-review touchpoint on the
    documented values.

Net: +14 tests in 1 new file, 0 new capture sites, 0 logic changes.

### 4. `supabase/migrations` ↔ app-dependency drift-check (R35 item e)

New file: `supabase/migrations-drift.test.ts` (+11 tests). Closes
a long-standing gap: the app/ and lib/ test suites lock the SHAPE
of every webhook insert against MOCKED Supabase clients. Those
mocks return whatever you ask for, so a future migration that
drops or renames a column slips through CI silently — and the
drift only surfaces at preview-deploy time when the real DB
rejects the insert.

The audit:

- Parses all 13 migrations under `supabase/migrations/` in
  lexical order (= numerical order for `00NN_*.sql`).
- Builds a cumulative `Schema = Map<table, Set<column>>` by
  walking `create table public.<name> (…)` and `alter table
  public.<name> add column [if not exists] <col>` statements.
- Includes a top-level statement splitter that respects `$$ … $$`
  dollar-quoting and `'…'` string literals — required so trigger-
  function bodies don't false-split mid-function.
- Compares against an explicit `APP_DEPENDENCIES` map naming
  every column the app code references at an app-level
  invariant lock, with the per-column reference annotated
  inline. R34-close coverage: payments (8 cols), calls (15
  cols), quotes (16 cols), quote_requests (17 cols),
  service_categories (4 cols), businesses (2 cols).
- Idempotency anchor lock — the four columns flagged by R27 /
  R31 / R32 retry-storm tests (`payments.stripe_event_id`,
  `calls.vapi_call_id`, `quotes.call_id`,
  `calls.counters_applied_at`) are asserted explicitly. If any
  goes missing, the prior round's drift suite would still pass
  (mocked client) but production retry storms would create
  duplicate rows.
- PII-column lock — `quotes.contact_*`, `profiles.email/phone/
  full_name`. If any of these vanishes, the per-route PII-
  redaction tests would silently keep passing because the
  column would never appear in any query result; surfaces the
  drift directly.
- Parser sanity gate — if the parser misses a critical table
  (typo in the create-table regex, unusual whitespace), the
  per-column failures cluster on the same root cause; this
  pre-check fires once with a clearer message.

Out of scope for R35 (deferred to R36+):

- Column TYPE drift (text vs uuid vs jsonb) — usually surfaced
  at zod parse or SDK runtime cast.
- RPC argument drift (`apply_call_end`, `increment_quotes_collected`).
  Per-route drift suites already lock RPC arg names at the app
  side. Migration-side equivalent would require parsing
  `CREATE FUNCTION` bodies — significantly bigger lift.
- Constraint drift (CHECK, FOREIGN KEY).

Net: +11 tests in 1 new file, 0 new capture sites, 0 schema
changes.

## Verification

- `vitest run` — **1170 passing across 90 files** (R34: 1124/87)
- `tsc --noEmit` — clean
- `next lint` — clean
- `npm audit --omit=dev` — identical to R34: 4 vulns (3 mod, 1
  high). next, uuid, svix, resend. All cross-major; all still
  blocked on your pre-approval.
- Determinism check: 5/5 clean runs across all R35-touched files
  (56/56 tests pass on every run).

## Implementation notes for Round 36+

- Sentry DSN capture-site count **unchanged at ~43**. R35
  shipped zero new capture sites — all work was attestation,
  cross-module audit, boundary lockdown, and DDL drift-check.
  Same posture as R33/R34.
- Locked lib tag shapes unchanged from R34. Locked route tag
  shapes unchanged from R34.
- New audit patterns introduced in R35:
  - **Per-file Reason-type round-trip audit** —
    `lib/lib-reason-types.test.ts` discovers every exported
    `XxxReason` literal-union and asserts set-equality between
    the declared members and the captured `reason:` values in
    the same file. Reuse for any future Reason-type-bearing
    module class. The reason-literal extractor is scope-aware
    (walks `captureException(…)` arg bodies, plus
    `tagsFor('…')`) so non-Sentry uses of `reason:` keys
    (Stripe params, result objects) don't false-positive.
  - **Rate-limit boundary order audit** — both runtime
    (limiter fires before zod / before DB) and source-level
    (`rateLimit(` index < `safeParse(` index < `createAdminClient(`
    index). Reuse for any future attacker-controlled server
    action that adds a rate-limit assertion.
  - **Mutable-header pattern** for tests that need rate-limit
    map state to persist across sub-requests in a single test:
    one `vi.doMock('next/headers', () => …)` that reads from a
    mutable scope-local ref. Avoids `vi.resetModules()` wiping
    the in-memory `buckets` Map between sub-requests. Canonical
    example: per-IP, cross-vertical, and XFF first-IP tests in
    `lib/actions/intake-rate-limit-audit.test.ts`.
  - **Migrations DDL drift-check** —
    `supabase/migrations-drift.test.ts` parses SQL into a
    cumulative `<table, Set<column>>` schema and asserts every
    app-referenced column has a migration source. Reuse for
    future schema-touching migrations: each new column the app
    starts referencing should land in `APP_DEPENDENCIES` at
    the same time, or the drift-check fires on the next run.

## Outstanding human-input items (still 12)

1. **Legal pages** (privacy, terms, refund policy) — draft +
   noindex required. Still open.
2. **Sentry DSN unlock** (~43 capture sites waiting). Still the
   highest-value unlock; every round since R22 has expanded the
   shape coverage behind it. R35 adds the Reason-type round-trip
   guarantee on top.
3. **Next.js 14.3.x CVE bump.** Still blocked on pre-approval
   (cross-minor bump). R35 attempted nothing here — pre-
   approval needed before any dep change.
4. **Upstash Redis migration** from in-memory rate limiter.
   Still open. R35's intake rate-limit audit sharpens the
   contract that the future Upstash implementation must
   preserve (per-IP partition, per-vertical key prefix,
   limit:10/60s, fires before any I/O).
5. **`svix` / `resend` / `uuid` cross-major bump** in
   `npm audit`. Still blocked on pre-approval.
6. **First preview-smoke run.**
   `scripts/smoke-webhook-preview.ts` shipped in R34. Before
   merging the next webhook-touching PR, run
   `npm run smoke:webhook-preview` against the preview deploy
   and confirm it passes. Once it works end-to-end in
   practice, we can consider adding it as a GitHub Action that
   gates the "Promote to Production" flow. Instructions in
   `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md`.

7-12. (Unchanged backlog items — see R34 report.)

## Suggested next autonomous run (Round 36)

Roughly ordered by ROI:

(a) **Cron route Reason-type round-trip audit at the route
level.** R35's audit covers `lib/` only. The cron routes use
`{ route, reason }` tag shapes (no `lib:`); if a future
maintainer adds a route-level Reason union without a matching
audit, ghost/ad-hoc drift could land unnoticed. ~30 min.

(b) **Migrations TYPE drift extension** — extend
`supabase/migrations-drift.test.ts` to extract column TYPES
(text, uuid, jsonb, timestamptz, etc.) and lock them against an
explicit type expectation per app-required column. Catches a
migration that changes `vapi_call_id` from text to uuid (or
similar) before the app's runtime cast fails. ~45 min.

(c) **RPC argument round-trip audit** — parse
`CREATE FUNCTION public.<name>(p_…)` bodies in migrations and
assert every RPC argument the app passes is declared in the
function signature. Closes the last big DB-side drift gap.
Significantly more parser work than column extraction; estimate
~60-90 min. Skippable until the first time RPC drift bites.

(d) **Rate-limit boundary audit on `app/api/waitlist`** (if
present) — the waitlist endpoint is mentioned in
`lib/rate-limit.ts` comments as another attacker-controlled
surface. Mirror R35's intake-rate-limit-audit for the route
handler. ~30 min.

(e) **Next.js 14.3.x CVE bump IF pre-approved.** ~45 min.

(f) **Preview-deploy smoke run (human).** First real exercise of
`scripts/smoke-webhook-preview.ts` against a live Vercel
preview. R34 shipped the script; nothing has run it yet.

## Files created / modified in R35

- `app/robots.ts` (header comment added — no logic change)
- `app/robots.test.ts` (4 → 8 tests; +1 import: `vi`)
- `app/sitemap.ts` (header comment added — no logic change)
- `app/sitemap.test.ts` (6 → 13 tests; new
  `observability contract — no capture` describe block)
- `lib/lib-reason-types.test.ts` (new, 10 tests)
- `lib/actions/intake-rate-limit-audit.test.ts` (new, 14 tests)
- `supabase/migrations-drift.test.ts` (new, 11 tests)
- `docs/DAILY_REPORT_2026-04-24-R35.md` (this file)

## Round-over-round scorecard

| Round | Tests | Files | Notes |
|------:|------:|------:|-------|
|   R28 |   932 |    80 | checkout capture, engine fallback, probe secret-leak |
|   R29 |   957 |    80 | resend split, intake dual, claim route |
|   R30 |   974 |    80 | post-payment parity, auth/callback, stripe stateful |
|   R31 |   983 |    80 | vapi-webhook drift, vapi-pool, drift-capture stub |
|   R32 |  1038 |    82 | admin capture, csp-report attestation, twilio drift, sentry-wiring |
|   R33 |  1079 |    84 | health/version attestation, security no-capture, app capture-sites, version edges |
|   R34 |  1124 |    87 | middleware attestation, scripts audit, lib capture-sites, smoke-webhook-preview |
|   R35 |  1170 |    90 | robots/sitemap attestation, lib reason-type round-trip, intake rate-limit boundary audit, migrations drift-check |

+46 tests, +3 files, zero new capture sites, zero regressions,
zero mutating changes to dependencies.
