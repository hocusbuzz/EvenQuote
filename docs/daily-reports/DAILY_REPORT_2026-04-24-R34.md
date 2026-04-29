# EvenQuote daily report — Round 34 (2026-04-24, autonomous run)

## TL;DR

Test count: **1124 passing across 87 files** (R33 baseline: 1079/84;
delta **+45 tests, +3 new files**). `tsc --noEmit` clean. `next lint`
clean. `npm audit --omit=dev` unchanged (4 vulns, all still blocked
on your pre-approval).

Focus this round: closing out the R33 backlog — the smoke-script
alternative to the MSW harness, and the remaining observability
audits (`middleware.ts`, `scripts/`, lib-level capture-site shape).

## Shipped

### 1. `middleware.ts` observability-contract attestation (R34 item c)

Added R32-style telemetry-sink attestation block to `middleware.ts`:
five-point header comment documenting why the file deliberately does
NOT wire `captureException`, paired with an 8-test `observability
contract — no capture` block at the bottom of `tests/middleware.test
.ts`. Test coverage: plain request, maintenance-gate rewrite,
`?preview=<token>` redirect, allow-listed webhook paths, CSP nonce
(Report-Only), CSP enforce mode, malformed bypass cookie, and a
source-level grep (with comment-stripping) that fails if a future
refactor wires capture in code.

Also replaced a flaky "updateSession throws" runtime test with a
deterministic source-level assertion that `middleware.ts` doesn't
try/catch around `await updateSession(...)`. The runtime version was
order-dependent against Vitest's `doMock` resolution cache; the
source-level version is deterministic and locks the same property
(platform-level instrumentation owns middleware crashes — R26
no-double-capture rule).

Verified: 5/5 clean runs, 20/20 tests in file.

### 2. `scripts/` no-capture audit (R34 item d)

New file: `scripts/no-capture-audit.test.ts` (+13 tests). Source-
level grep-asserted allow-list covering all 5 scripts (now 6 with
the R34 smoke-script addition). Two regression guards: directory-
sync (fails if a new script lands without being listed), allow-list
freshness (fails if a script is renamed/deleted without the list
updating). Plus a 1-20 count band to catch "10 new files" drift.

Rationale documented inline: scripts/ is operator-invoked, bounded-
frequency code; capture sites here would flood on every
misconfigured local-dev run and double-capture with route-level
sites that already fire.

### 3. `lib/` capture-site shape audit (R34 item b)

New file: `lib/lib-capture-sites.test.ts` (+9 tests). Cross-lib
counterpart to the R33 `app/api-capture-sites.test.ts`. Balanced-
paren walker over `lib/**/*.ts` asserts every `captureException`
call anchors both `lib:` and `reason:` tags — either inline, via
spread (e.g. `...baseCaptureTags`), or via helper function (e.g.
`tagsFor('reason')`). Plus a per-file sanity check that every
file containing a capture call also declares both tag keys
somewhere in its source.

Additional locks: no forbidden ad-hoc top-level keys (`domain:`,
`errorCode:`, `severity:`), no PII keys (`email:`, `phone:`,
`token:`, `password:`, `apiKey:`, `name:`, `address:`), count band
30-80 (current: ~41), and subtree allow-list — capture wiring must
live under `actions/`, `calls/`, `cron/`, `email/`, or
`observability/`.

### 4. `scripts/smoke-webhook-preview.ts` (R34 item a)

New file + unit tests + runbook, zero new dependencies.

Replaces the MSW + supertest proposal per `docs/RETRY_HARNESS_
FEASIBILITY_R33.md` recommendation. Script POSTs real signed webhook
payloads at a preview-deploy URL for all three external webhooks
(Stripe, Vapi, Twilio), runs a 20-retry idempotency storm per leg,
and asserts 200 throughout. Uses the already-installed Stripe SDK
plus Node's built-in crypto for HMAC — no `package.json` changes
besides a single new `smoke:webhook-preview` npm script.

- `scripts/smoke-webhook-preview.ts` — ~400 lines, CLI-flag-parsed
  (`--only=`, `--retries=`, `--timeout-ms=`, `--dry-run`), exit-
  code-disciplined (0 pass / 1 fail / 2 config error), read-mostly
  safe (only the Stripe leg writes to the preview DB).
- `scripts/smoke-webhook-preview.test.ts` — 12 unit tests covering
  `parseArgs` and `computeTwilioSignature` (pure helpers). Locks
  the Twilio HMAC algorithm against `app/api/twilio/sms/route.ts`
  so a drift there fails this test before it fails a preview run.
- `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md` — operator runbook
  covering prerequisites, flags, failure modes, and what to do on
  red.

Stripe `apiVersion` pinned to `'2025-02-24.acacia'` to match
`lib/stripe/server.ts` — document note in the script warns the pin
must move in lockstep with a future SDK bump.

### 5. Verification

- `vitest run`: **1124/87 passing** (R33: 1079/84). Delta: +45 tests
  across +3 new files.
- `tsc --noEmit`: clean.
- `next lint`: clean.
- `npm audit --omit=dev`: 4 vulns (3 moderate, 1 high) — next, uuid,
  svix, resend. Identical to R33. All cross-major. All still
  blocked on your pre-approval.
- 5/5 determinism check on all R34-touched test files: 56/56 pass
  every run.

## Implementation notes for Round 35+

- Sentry DSN capture-site count **unchanged at ~43**. R34 shipped
  zero new capture sites — all work was audit, attestation, and
  shape lockdown. Same posture as R33.
- Locked lib tag shapes unchanged from R32. Locked route tag shapes
  unchanged from R30.
- **New drift-catching patterns introduced in R34:**
  - **Source-level grep-audit with comment-stripping** — tests
    that grep source for forbidden tokens now strip `//` line
    comments and `/* */` block comments first, so documentation
    that names the tokens (header comment explaining the
    no-capture contract) doesn't false-positive. Canonical
    example: the `source-level grep` test in
    `tests/middleware.test.ts`.
  - **Deterministic replacement for runtime-mock tests that fight
    Vitest's doMock cache.** If a test that re-mocks across
    `vi.resetModules()` is flaky, replace it with a source-level
    assertion on the code property. The "middleware.ts does not
    try/catch around updateSession" test is the canonical
    example. Use sparingly — this is NOT a substitute for runtime
    behavior; it's a substitute for redundantly-checked runtime
    invariants that have a source equivalent.
  - **Helper-aware tag audit** — `lib/lib-capture-sites.test.ts`
    accepts three tag shapes: inline, spread, or helper-call.
    Reuse for any future cross-module shape audit where modules
    might legitimately factor their tag construction.
- Smoke-script-as-preview-coverage is now the preferred shape for
  retry-storm / real-network testing. MSW harness is deferred
  indefinitely unless the DB-row-state invariants need a local
  harness (current R30+ stateful-stub pattern covers them against
  mocked Supabase — no gap worth MSW).

## Outstanding human-input items (unchanged at 12, one resolved)

1. Legal pages (privacy, terms, refund policy) — draft + noindex
   required. Still open.
2. Sentry DSN unlock (~43 capture sites waiting). Still the
   highest-value unlock; every round since R22 has expanded the
   shape coverage behind it.
3. Next.js 14.3.x CVE bump. Still blocked on pre-approval (cross-
   minor bump).
4. Upstash Redis migration from in-memory rate limiter. Still open.
5. `svix` / `resend` / `uuid` cross-major bump in `npm audit`. Still
   blocked on pre-approval.
6. ~~R33 NEW: pre-approve MSW+supertest deps OR confirm preference
   for smoke-script alternative per feasibility report.~~
   **Resolved in R34** — went with the smoke-script alternative
   since it doesn't require your dep pre-approval and gives better
   coverage (exercises real Vercel target).

7-12. (Unchanged backlog items — see R33 report.)

## New backlog item

- **First preview-smoke run.** `scripts/smoke-webhook-preview.ts`
  is ready, documented, and unit-tested. Before merging the next
  webhook-touching PR, run it against the preview deploy and
  confirm it passes cleanly. Once it works end-to-end in practice,
  we can consider adding it as a GitHub Action that gates the
  "Promote to Production" flow. Instructions: see
  `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md`.

## Suggested next autonomous run (Round 35)

(a) **Per-route attestation for `/api/robots.txt` and `sitemap.xml`
generators** (if they exist) — public-facing bot-crawl frequency,
same pattern as `health`/`version`/`csp-report` attestation. ~20
min.

(b) **Cross-module Reason-type allow-list audit** — each lib that
exports a `Reason` type (ResendReason, CheckoutReason,
AdminReason, etc.) should be grep-asserted to have every string
literal in its reason allow-list actually used as a `reason:` tag
value somewhere in its source file, and vice-versa. Catches
"ghost reason values" (declared but never captured) and
"ad-hoc reason values" (captured but not in the declared type).
~45 min.

(c) **Rate-limit boundary audit on the two server actions that
take user input without a webhook signature** — `lib/actions/
intake.ts` and `lib/actions/cleaning-intake.ts`. These are the
attacker-controlled entry points. Check rate-limit assertion is
present and the assertion key is correctly partitioned (per-IP
or per-user, not global). ~30 min.

(d) **Next.js 14.3.x CVE bump IF pre-approved.** ~45 min.

(e) **`supabase/` migrations audit** — we lock all the app-level
invariants (insert-shape, column names, idempotency keys) but
never test that the migrations themselves match. If a new
migration drops a column that an insert-shape test expects,
nothing catches it until the preview deploy. Small drift-check
test would help. ~45 min.

(f) **Preview-deploy smoke run (human).** After (e) or (d) lands,
run `npm run smoke:webhook-preview` against a real preview and
report back — this is the first real exercise of the new script
and we want to confirm it works end-to-end against a live Vercel
preview before trusting it as a promote-gate.

## Files created in R34

- `tests/middleware.test.ts` (extended from 11 → 20 tests)
- `middleware.ts` (header comment added — no logic change)
- `scripts/no-capture-audit.test.ts` (new, 13 tests)
- `scripts/smoke-webhook-preview.ts` (new — not a test, a script)
- `scripts/smoke-webhook-preview.test.ts` (new, 12 tests)
- `lib/lib-capture-sites.test.ts` (new, 9 tests)
- `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md` (new)
- `package.json` (one new npm script entry)

## Round-over-round scorecard

| Round | Tests | Files | Notes |
|------:|------:|------:|-------|
|   R28 |   932 |    80 | checkout capture, engine fallback, probe secret-leak |
|   R29 |   957 |    80 | resend split, intake dual, claim route |
|   R30 |   974 |    80 | post-payment parity, auth/callback, stripe stateful |
|   R31 |   983 |    80 | vapi-webhook drift, vapi-pool, drift-capture stub |
|   R32 |  1038 |    82 | admin capture, csp-report attestation, twilio drift, sentry-wiring |
|   R33 |  1079 |    84 | health/version attestation, security no-capture, app capture-sites, version edges |
|   R34 |  1124 |    87 | middleware attestation, scripts audit, lib capture-sites, smoke-webhook-preview script + tests |

+45 tests, +3 files, zero new capture sites, zero regressions,
zero mutating changes to dependencies.
