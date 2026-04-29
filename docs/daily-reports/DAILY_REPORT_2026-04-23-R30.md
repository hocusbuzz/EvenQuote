# Daily Report — 2026-04-23 — Round 30 (autonomous)

## TL;DR

974 tests passing across 80 files (R29 close: 957/80; **+17 tests, 0 new files**). `tsc --noEmit` clean. `next lint` clean. `npm audit --omit=dev` identical to R29.

Shipped the three remaining R29-punchlist items that could be completed without user pre-approval: a deep audit of `post-payment.ts`, a full observability-wiring pass on `app/auth/callback/route.ts`, and a new idempotency-key drift suite on the Stripe webhook. **~39 Sentry capture sites now waiting on DSN unlock** (was ~38 at R29 close).

The auth/callback audit closed a real silent failure mode: a Supabase outage on the magic-link exchange would strand paying customers at `/auth-code-error` with zero operator visibility — *upstream* of the R29 claim-route observability that was the last "critical path" locked.

Zero code changes touch the customer-facing surface. Purely defensive wiring + tests.

---

## Shipped

### 1. `lib/actions/post-payment.ts` — capture-site deep audit (+4 tests)

R29 flagged `post-payment.ts` as "only spot-checked at R27" and put it on the R30 punchlist to cross-check for silent paths the way R29 did `intake.ts`. Result of the audit: the file has **exactly one external call** (`supabase.auth.signInWithOtp`), and it was already correctly captured at the lib boundary with `{lib:'post-payment', reason:'signInWithOtp', requestId}` tags.

What was missing relative to other audited libs (intake, resend, checkout):

- No exported `Reason` type — the reason was an implicit string literal.
- No regression-guard test forbidding catch-all reasons (the R29 drift pattern).
- No allow-list lock tying the `PostPaymentReason` type to the emitted tag value.
- No controlled-prefix assertion on the wrapped error message (fingerprint-stability lock).

Shipped parity fixes:

- Exported `type PostPaymentReason = 'signInWithOtp'` with a code-level comment listing the three paths **deliberately not captured** (input validation, admin-client env-missing, headers() fallback).
- +4 regression guards: (a) forbids `unknown`/`error`/`failed`/`otpFailed`/`sendFailed`/`magicLinkFailed`/`authFailed` catch-alls, (b) reason is one of the single locked value, (c) wrapped message uses the controlled prefix `signInWithOtp failed: `.

**Tests:** `lib/actions/post-payment.test.ts` 12 → 16.

### 2. `app/auth/callback/route.ts` — capture audit (+9 tests)

**Real fix, not hygiene.** This route handles the Supabase magic-link exchange. It runs BEFORE `get-quotes/claim` (which R29 audited), so a silent failure here breaks the customer journey *upstream* of R29's observability — customer paid $9.99, clicked the link, landed on `/auth-code-error`, and nothing reached ops.

Pre-R30 the `exchangeCodeForSession` error path was `log.error` only with zero Sentry capture. A Supabase auth outage, a real provider misconfig, or a tampered code would all produce the same invisible failure mode.

New canonical tag: `{route:'auth/callback', reason:'exchangeCodeForSessionFailed'}` with a controlled-prefix wrapped error (`'exchangeCodeForSession failed: ...'`) for Sentry fingerprint stability.

Also hardened: the exchange call is now wrapped in a `try/catch` so both the error-object path AND a future SDK transport throw land on the same capture site. Without this, a future Supabase SDK change that starts throwing instead of returning `{error}` would fall through to Next.js's generic error boundary — 500 with no route tags, no structured signal.

**Deliberately NOT captured** (documented in code + negative-tested):

- Provider-side `?error=access_denied` — user denied OAuth; user-facing event, not an ops incident. Flooding risk.
- Missing `?code=` — bot crawlers, expired share links, manual URL manipulation. Flooding risk.

Exported `type AuthCallbackReason = 'exchangeCodeForSessionFailed'`.

**Tests:** `app/auth/callback/route.test.ts` 7 → 16.
- Capture-on-error-object, capture-on-transport-throw, no-capture for ?error=, no-capture for missing ?code=, no-capture on happy path, PII guard (tags never include code/email/IP/origin), tag schema EXACT-key lock `['reason','route']`, forbidden catch-all reason list, allow-list lock.

### 3. `app/api/stripe/webhook/route.test.ts` — idempotency-key drift suite (+5 tests)

R27 shipped a drift suite locking the 8-column set on the `payments` insert. R30 extends that: a new `describe('idempotency-key drift (R30) — retry-storm contract')` block locks the *retry-storm* behavior end-to-end.

Why this matters: Stripe retries delivery on any non-2xx response AND occasionally re-delivers after a 2xx during their own infra incidents. The handler's idempotency keys on a unique index over `payments.stripe_event_id`. A future refactor that renamed the column to `event_id`/`idempotency_key`, or keyed dedupe on `session_id` instead, would silently fire side effects multiple times per event — 20 magic-link emails to the customer, 20 call batches enqueued.

New stateful admin stub honors the unique-index semantic over `stripe_event_id` and lets us simulate real retry storms (vs. the prior drift suite which treated each call independently).

Five locks:

- **Column name lock:** the insert writes to `stripe_event_id` specifically — negative assertions against `event_id`, `idempotency_key`, `stripe_id` drifts.
- **20-retry storm:** 20 sequential deliveries of the same `event.id` → 20 insert attempts (real retry hits the DB), 1 successful insert, 1 status update, 1 magic link sent, 1 call batch enqueued. The stateful stub makes this a real invariant test, not just a mock assertion.
- **Stable return note:** retries return `"Duplicate event — already processed"` (exact literal) — operators may build dashboards/greplog on this string.
- **Event-scoped dedupe (not session-scoped):** two DIFFERENT event IDs with the SAME session ID both attempt insert — catches a refactor that flipped idempotency to session-level.
- **Update short-circuit:** retries that hit 23505 never re-run the `quote_requests` update block (two layers of defense — R27 locked the status filter, R30 locks the upstream short-circuit).

Mock-hygiene: new suite opens with explicit `vi.doUnmock` block mirroring the R27 / R26 pattern.

**Tests:** `app/api/stripe/webhook/route.test.ts` 17 → 22.

### 4. Verification

- `vitest run` → 974 passed / 0 failed across 80 files.
- `tsc --noEmit` → clean.
- `next lint` → clean.
- `npm audit --omit=dev` → identical to R29 (3 moderate + 1 high: next, uuid, svix, resend — all cross-major, still blocked on user pre-approval).

---

## Implementation notes for Round 31+

- **Sentry DSN capture-site count now ~39** (was ~38 at R29). Added: 1 route reason (`auth/callback/exchangeCodeForSessionFailed`). The post-payment audit added no new capture sites — finding was parity/hardening. The stripe-webhook drift suite added no new sites — finding was retry-storm invariant locks.
- **Locked tag shapes unchanged from R29** plus: **NEW** `{route:'auth/callback', reason:'exchangeCodeForSessionFailed'}`.
- **PII contract held** across new capture sites: only `route`/`reason` identifiers in tags. No email, no auth code, no origin, no IP.
- **R29 config-state-no-capture pattern** reinforced: auth/callback audit deliberately does NOT capture the provider-?error path or the missing-?code path — both user-facing events that would flood Sentry.
- **Stateful-stub pattern for idempotency tests** is now documented inline in the R30 drift block. Reuse for any future dedupe test that needs multi-request state (cron retry ledger, Vapi inbound dedupe, etc).

## Outstanding human-input items

Unchanged at 12. Sentry DSN (item #6) remains the highest-value unlock — **~39 capture sites waiting now**.

## Suggested next autonomous run (Round 31)

(a) Real-network retry harness (MSW/supertest) for stripe + vapi webhook retry storm. On punchlist since R22. The R30 stateful-stub work has now established the invariant shape, making the MSW version straightforward. ~45 min.
(b) `lib/queue/enqueue-calls.ts` capture audit — cross-check post-R28 engine.ts work for any new silent paths since `noBusinessesFallbackFailed` was added. ~30 min.
(c) `app/api/vapi/webhook/route.ts` full idempotency-key drift suite — mirror of R30's stripe-webhook work, keyed on `vapi_call_id` (the dedupe column). The column-shape drift suite exists from R26; add retry-storm invariant. ~30 min.
(d) Next.js 14.3.x CVE bump IF pre-approved. ~45 min.
(e) `app/get-quotes/success/page.tsx` + dashboard surface metadata audit — the noindex/canonical/title shape lock is locked at root + flow + legal + dashboard + admin (R25 metadata sweep); confirm the success page hasn't drifted. ~20 min.
