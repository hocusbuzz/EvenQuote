# Daily Report — 2026-04-23 (Round 28, autonomous)

**Status:** 932 passing across 80 files. `tsc --noEmit` clean.
`next lint` clean. Baseline was Round 27 at 920/80 — delta **+12
tests, 0 new files** (all adds into existing files).

Three lib-boundary capture sites added (`lib/actions/checkout.ts`
at two sites, `lib/calls/engine.ts` at one site). One secret-leak
regression-guard block added on `app/api/status/route.ts` probe
functions. Safe to merge.

---

## Shipped this round

### 1. `lib/actions/checkout.ts` — capture-site audit (+8 tests, 2 new sites)

Audit target from R27 punchlist (c). `post-payment.ts` was already
fully audited in R19, but the scope extended to the rest of
`lib/actions/` surfaces revealed a genuinely silent path on the
top-of-funnel payment action. `createCheckoutSession` had TWO
silent `{ok:false}` returns that never reached Sentry:

| Site | Pre-R28 behavior | Post-R28 behavior |
|------|------------------|-------------------|
| `catch` around `stripe.checkout.sessions.create` | `log.error` only, `{ok:false, error:'Could not start checkout...'}` | `log.error` + `captureException({lib:'checkout', reason:'stripeSessionCreateFailed', requestId})` |
| `if (!session.url)` branch | Plain `{ok:false, error:'Stripe did not return a checkout URL'}` | `captureException({lib:'checkout', reason:'stripeReturnedEmptyUrl', requestId})` first |

Why this matters: `createCheckoutSession` is the FIRST call in the
payment funnel. A Stripe outage, a rotated/restricted key, or an
SDK contract break all presented as "Could not start checkout" to
the user with **zero** ops visibility. The top-of-funnel conversion
signal was disappearing into logs the webhook never checked.

New canonical type `CheckoutReason` exported from the module:
`'stripeSessionCreateFailed' | 'stripeReturnedEmptyUrl'`. Any new
reason must be added to the union AND to the regression-guard at
the bottom of `checkout.test.ts`.

Wrapped error message hides Stripe internal text — Sentry fingerprints
on the controlled message (`'stripe.checkout.sessions.create failed'`)
rather than the raw SDK error, which prevents PII-adjacent leaks
(Stripe errors can include customer ids, charge objects, card-
decline reasons) from becoming Sentry search keys.

Tests added (8 to checkout.test.ts, 8 → 16):
- Canonical tag-shape lock for both new reasons (strict `toMatchObject`).
- Happy-path no-capture guard (false-positive alarm).
- Input-validation no-capture guard (invalid-UUID, wrong-status — infra noise prevention).
- PII guard — raw Stripe message, customer id, customer email all excluded from serialized ctx.
- Regression-guard forbidding catch-all reasons (`unknown`, `error`, `stripeError`, `sessionFailed`, `runFailed`).
- Strict `{lib, reason, requestId}` key-set lock on tags.

### 2. `lib/calls/engine.ts` — new silent-path audit (+2 tests, 1 new site)

Audit target from R27 punchlist (e). R25 locked four discrete
reasons (`claimFailed`, `insertFailed`, `plannedCountUpdateFailed`,
`callIdPersistFailed`) in `engine.ts`. R28 cross-check found ONE
genuinely silent path still open:

**`noBusinessesFallbackFailed`** — When `selectBusinessesForRequest`
returns an empty list, the engine flips `status: 'failed'` as
rollback. Pre-R28 that update had NO error check. If this update
silently failed (RLS drift, permission rotation, DB partition
between claim+fallback), the quote_request was STRANDED in
`status: 'calling'` with zero calls:

- `retry-failed-calls` cron looks for rows with `calls.status='failed'` — zero rows exist.
- `send-reports` only triggers on `status='processing'` — never fires.
- Customer paid $9.99 and nothing ever happens.

Low-probability (requires double DB failure: claim OK, fallback fail)
but maximum blast radius. Capture now fires at lib boundary with
canonical `{lib:'enqueue', reason:'noBusinessesFallbackFailed', quoteRequestId}`.

Tests added (2 to engine.test.ts, 12 → 14):
- Canonical tag-shape lock including PII guard.
- False-positive guard — zero-coverage with successful fallback update must NOT capture (business-level outcome, not system failure).
- Regression-guard `LOCKED_REASONS` set expanded from 4 → 5.

Paths examined and deliberately NOT captured:
- `last_called_at` business update (line 267-270) — cool-off drift only.
- Final counters update (line 282-288) — overridden per-call by `apply-end-of-call` via `total_calls_made` RPC bump.
- Dispatch-failed call status update (line 274-277) — `vapi.ts` already captures at HTTP boundary with `{lib:'vapi', reason:'startCall*'}`; a second DB-failure capture here would create a duplicate Sentry event for the same root cause. (Same precedent as R25's decision not to capture `dispatch.ok===false` at engine level.)

### 3. `app/api/status/route.ts` — secret-leak regression guards (+3 tests, 0 new sites)

Audit target from R27 punchlist (b). Cron route `cron/check-status`
already captures the aggregate probe failure with
`{route:'cron/check-status', reason:'integrationProbeFailed', stripe, vapi}`
(R26 work). Adding lib-level capture at `checkStripe`/`checkVapi`
was deliberately **NOT** done — it would create a duplicate Sentry
event for the same root cause (R26 "no double capture" rule,
documented for `vapi.ts` vs `engine.ts`).

What WAS added: a new `describe` block locking the secret-leak
boundary on the probe functions. `checkStripe`/`checkVapi` forward
`err.message.slice(0, 200)` to the response body on failure. That
200-char slice is the primary defense against Stripe/Vapi dumping
the full request payload (historically: secret fragments,
idempotency keys, customer identifiers) into the error. R28 adds
tests that fail if:

| Regression | Test |
|------------|------|
| Literal env var value (Stripe/Vapi key) appears in response | `never echoes a Stripe-secret-looking substring in errors.stripe` |
| `CRON_SECRET` appears in any ok:false payload | `never echoes the CRON_SECRET in any ok:false response` |
| 200-char truncation is loosened (e.g. bumped to 500 "for debugging") | `truncation is load-bearing — message length cap stays at 200` |

Tests added (3 to status/route.test.ts, 18 → 21).

### 4. Test coverage additions

Three test files expanded (0 new files):

| File                                  | Before | After | Δ   |
|---------------------------------------|--------|-------|-----|
| `lib/actions/checkout.test.ts`        | 8      | 16    | +8  |
| `lib/calls/engine.test.ts`            | 12     | 14    | +2  |
| `app/api/status/route.test.ts`        | 18     | 21    | +3  |

### 5. Verification

```
vitest run        932 passing / 80 files
tsc --noEmit      clean
next lint         clean
npm audit --omit=dev   4 vulns (3 moderate, 1 high) — unchanged from R27
```

`npm audit` breakdown identical to R24/R25/R26/R27: next, uuid,
svix, resend; all cross-major; all still blocked on user pre-approval
(user-input #5).

---

## Items still needing your input (12 items — unchanged in count)

Priority descending by value-per-minute. Capture-site count for
Sentry DSN bumped from **~28 → ~31** with R28's three new lib-level
reasons (2 in checkout, 1 in engine).

1. **Sentry DSN (user-input #6) — still the highest-value unlock.**
   Waiting-on-DSN capture sites now total **~31** (was ~28 at R27
   close). New additions from this round:
   - `lib:'checkout'`: stripeSessionCreateFailed, stripeReturnedEmptyUrl (2)
   - `lib:'enqueue'`: noBusinessesFallbackFailed (1)

   ~10 min to land. Checkout capture is especially valuable — this
   is the first call in the payment funnel and any silent failure
   here is invisible to ops today.
2. **Upstash Redis creds (user-input #2).** In-memory token
   buckets die with cold starts + can't cross-instance. ~5 min.
3. **Legal counsel review of privacy + terms drafts** (NOT LEGAL
   ADVICE — drafts still noindexed + unlinked from footer). Blocks
   public launch. ~15 min to hand off.
4. **Swap placeholder OG + favicon + apple-touch-icon art.**
   Metadata SHAPE locked by four test files.
5. **Next.js CVE bump.** `^14.3.x` minimum, `^16.2.x` for full fix
   (`16.2.4` is the advisory-clean target). Requires preview-
   deploy testing. ~60 min.
6–12. Unchanged: Stripe account verification, production DNS,
   Resend domain DNS, Vapi number pool sizing, TWILIO_AUTH_TOKEN
   env in prod, BYOT Twilio number purchase, security monitoring
   vendor selection.

---

## Suggested next autonomous run (Round 29)

Pick 1–2:

1. **Real-network retry harness (MSW / supertest).** Still on the
   R22-R28 punchlist. Proves Stripe + Vapi webhook dedupe across
   sequential POST bursts with shifted + replayed signatures. Unit-
   level dedupe coverage now exists for all four webhooks +
   checkout + engine. MSW would prove the behavior under a real
   fetch stack. ~45 min.
2. **`lib/email/resend.ts` capture-site audit.** The only external
   integration lib that hasn't been audited for canonical Sentry
   tags. `sendReportEmail` returns `{ok:false, reason}` without
   capturing at the lib boundary — callers (send-reports cron)
   capture at their own boundary but a support/manual-resend path
   would have no coverage. ~30 min.
3. **`lib/actions/intake.ts` / `lib/actions/cleaning-intake.ts`
   capture audit.** These are the zod-validate-and-insert server
   actions — catch paths handle RLS denials and constraint
   violations silently today. ~30 min.
4. **Next.js 14.3.x CVE bump IF pre-approved.** Intermediate hop.
   Resolves 3 of 5 advisories. Requires preview-deploy. ~45 min.
5. **`app/get-quotes/claim/route.ts` capture audit.** Magic-link
   landing — claims `user_id` on the quote_request and payment
   rows. Silent failure here leaves the user unable to see their
   own quote. ~20 min.

---

## Summary

Round 28 closed three of the five items from Round 27's suggested
punchlist: (c) `lib/actions/*` audit via `checkout.ts` — 2 new
silent-path captures + PII guards on the top-of-funnel payment
action; (e) `engine.ts` cross-check — 1 new silent-path capture
for the coverage-gap fallback; (b) `check-status` lib audit —
deliberately no new capture (R26 "no double capture" rule),
but 3 secret-leak regression guards lock the probe boundary.

Capture-site count grew from **~28 → ~31**. Checkout became the
first `lib/actions/*` surface beyond post-payment with end-to-end
Sentry coverage. Engine locked tag shape expanded from 4 → 5
discrete reasons. Probe-boundary secret-leak tests lock the 200-
char truncation + literal-env-var-absence contract on the
operator probe surface.

All green. 932 passing, typecheck clean, lint clean. Four npm
audit vulns unchanged; all cross-major; all still blocked on
user pre-approval.

— Claude, 2026-04-23 (twenty-eighth run, autonomous)
