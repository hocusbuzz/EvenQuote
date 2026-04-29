# Daily Report — 2026-04-23 (Round 27, autonomous)

**Status:** 920 passing across 80 files. `tsc --noEmit` clean.
`next lint` clean. Baseline was Round 26 at 901/80 — delta **+19
tests, 0 new files** (all adds into existing files).

Two lib-level capture sites added (`lib/cron/send-reports.ts`,
`lib/cron/retry-failed-calls.ts`). One drift-detection suite added
on the last unprotected external-webhook surface
(`app/api/stripe/webhook/route.ts`). One auth test expansion on the
Stripe signature boundary. Safe to merge.

---

## Shipped this round

### 1. `app/api/stripe/webhook/route.ts` — drift-detection suite (+5 tests)

Audit target from R26 punchlist (b). Stripe webhook was the last
external-webhook surface without a drift-lock block (Twilio SMS got
one in R25, Vapi inbound-callback in R25, Vapi webhook in R26).
Behavioral tests above the drift block already covered the handler's
semantics (idempotency, side effects, replay dedupe, retry storms).
What was missing: the DB-shape lock that catches silent migration
drift.

Five discrete drift locks now in place:

| Drift vector                                      | What breaks silently without the lock |
|---------------------------------------------------|---------------------------------------|
| `payments` insert column-set rename or addition   | 23505 dedupe branch silently stops firing; double-writes possible |
| `payments.status` enum literal drift (→ `'paid'`) | Postgres 22P02 rejects every row; exact prior-incident replay |
| `quote_requests` filter drops `pending_payment`   | Webhook clobbers `'calling'` → `'paid'`, stalling the batch |
| `quote_requests` select drops `intake_data`       | Magic-link falls back to Stripe email only, loses intake override |
| 23505 on payments → side effects fire             | Duplicate magic links, duplicate call enqueues |

Set-equality on `Object.keys` for the payments insert — not superset.
Any migration that adds OR renames a column must also update this
test. That's the drift catch.

The drift block opens with `vi.doUnmock(...)` + `vi.resetModules()`
for `@/lib/supabase/admin`, `@/lib/stripe/server`,
`@/lib/actions/post-payment`, `@/lib/queue/enqueue-calls` — the
preceding `captureException tag shape` block persists its mocks
across `vi.resetModules()`, same mock-hygiene pattern documented in
R26's vapi/webhook drift suite. Reuse in any future drift block.

**Test count in file:** 12 → 17.

### 2. `lib/cron/*` — lib-level capture-site audit

Audit target from R26 punchlist (c). The R26 route-level audit
locked `{route:'cron/<name>', reason}` on the three cron routes,
but every route's try/catch only catches THROWN errors. The lib
functions return `{ok:false, ...}` or resolve with per-request
`{status:'failed', reason:...}` without throwing, so Sentry was
silent on every per-request failure. Seven such surfaces across
the two lib files, now all capturing.

**`lib/cron/send-reports.ts`** — 5 new capture sites:

```
{ lib: 'cron-send-reports', reason: 'sendFailed',              requestId }
{ lib: 'cron-send-reports', reason: 'finalStampFailed',        requestId, emailId }
{ lib: 'cron-send-reports', reason: 'refundLookupFailed',      requestId }
{ lib: 'cron-send-reports', reason: 'refundCreateFailed',      requestId, paymentId }
{ lib: 'cron-send-reports', reason: 'refundStatusUpdateFailed', requestId, paymentId }
```

What these protect:
- `sendFailed` — Resend rejected the email. Customer paid, report
  generated, email never left. The exact failure that kills trust
  if it goes silent.
- `finalStampFailed` — Email DID send, but the post-send
  `report_sent_at` stamp failed. Next cron tick's `is('report_sent_at',
  null)` catches the row and re-sends. Customer gets duplicate
  emails. Page before that tick.
- `refundLookupFailed` — Payments row query errored on the
  zero-quotes refund path. Template falls back to "reply to this
  email" instead of the promised refund.
- `refundCreateFailed` — Stripe's `refunds.create` threw. Customer
  was told "zero quotes, refund on the way" but the refund did NOT
  happen. Highest-customer-impact failure in this module.
- `refundStatusUpdateFailed` — Refund went through on Stripe's
  side, but our `payments.status='refunded'` update failed.
  Book-keeping drift; next run's idempotency key no-ops on Stripe
  (safe). Medium signal.

Two log-warn surfaces deliberately **NOT** captured:
- `refund: no payments row for request` — this is an invariant
  violation (a 'processing' request without a matching payment).
  Worth a loud log for the one-time manual reconcile, not a Sentry
  page every time it fires.
- `refund: payments row has no payment_intent_id` — same reasoning.
  A webhook path that forgot to populate the column is a code
  bug, tracked in git.

**`lib/cron/retry-failed-calls.ts`** — 2 new capture sites:

```
{ lib: 'cron-retry-failed-calls', reason: 'candidateQueryFailed' }
{ lib: 'cron-retry-failed-calls', reason: 'applyCallEndFailed',
  callId, quoteRequestId }
```

What these protect:
- `candidateQueryFailed` — The initial `.select().eq().is()...`
  query failed (RLS drift, role rotation, table rename). The
  function returns `{ok:false, notes:[...]}` without throwing, so
  the route handler's try/catch doesn't fire. Pre-R27 this state
  would silently no-op the retry worker forever. This audit found
  a genuinely silent failure, not hygiene.
- `applyCallEndFailed` — The exact "stuck-batch bug" the code's
  own comments name. An exhausted retry must bump the counter via
  `apply_call_end`, else the quote_request sits in `status='calling'`
  forever and `send-reports` never picks it up. Customer paid,
  never got a report.

### 3. Test coverage additions

Three test files expanded (0 new files):

| File                                       | Before | After | Δ   |
|--------------------------------------------|--------|-------|-----|
| `app/api/stripe/webhook/route.test.ts`     | 12     | 17    | +5  |
| `lib/security/stripe-auth.test.ts`         | 8      | 13    | +5  |
| `lib/cron/send-reports.test.ts`            | 21     | 27    | +6  |
| `lib/cron/retry-failed-calls.test.ts`      | 12     | 15    | +3  |

Each capture-site test includes:
- Canonical tag-shape lock (strict `toEqual` on the tags object).
- PII negative-assertion where applicable: no `@` / no `\d{10,}`
  in any tag value.
- Regression-guard at the end of each lib file's capture block
  that forbids catch-all reason values (`runFailed`, `unknown`,
  `error`, and module-specific catch-alls).

### 4. `lib/security/stripe-auth.ts` — test expansion (+5 tests)

Audit target from R26 punchlist (e). Pre-R27 three verify-path tests
existed plus the 500-on-missing-secret and missing-header branches.
Gaps that the SDK rejects but we had not locked:

| New test                                            | Guards |
|-----------------------------------------------------|--------|
| Malformed timestamp (`t=not-a-number,v1=...`)       | SDK-error mapping to 400, not 500 |
| Replayed signature with timestamp 1h in past        | Default 300s tolerance — the replay window |
| Header structurally malformed (no `v1=` pair)       | Proxy stripping half the pairs |
| Truncated hex (8 chars instead of 64)               | Partial-leak forgery attempts |
| Non-Stripe header shape (Bearer token-style)        | Defensive — must 400, never 500 |

The replay-guard test in particular is load-bearing: a future
migration to `constructEventAsync` that passes a long `tolerance`
would silently widen the replay window. This test fails if the
tolerance becomes too permissive.

All five surface 400 (not 500) — matching the "stop Stripe's retry
loop on tampered input" contract.

### 5. Verification

```
vitest run        920 passing / 80 files
tsc --noEmit      clean
next lint         clean
npm audit --omit=dev   4 vulns (3 moderate, 1 high) — unchanged from R26
```

`npm audit` breakdown identical to R24/R25/R26: next, uuid, svix,
resend; all cross-major; all still blocked on user pre-approval
(user-input #5).

---

## Items still needing your input (12 items — unchanged in count)

Priority descending by value-per-minute. Capture-site count for
Sentry DSN bumped from **~21 → ~28** with R27's seven new
lib-level reasons.

1. **Sentry DSN (user-input #6) — still the highest-value unlock.**
   Waiting-on-DSN capture sites now total **~28** (was ~21 at R26
   close). New additions from this round:
   - `cron-send-reports`: sendFailed, finalStampFailed,
     refundLookupFailed, refundCreateFailed,
     refundStatusUpdateFailed (5)
   - `cron-retry-failed-calls`: candidateQueryFailed,
     applyCallEndFailed (2)

   ~10 min to land. This round closes the last known *silent*
   failure surfaces in the cron path — once the DSN lands, the
   entire cron + webhook + engine error surface is observable.
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

## Suggested next autonomous run (Round 28)

Pick 1–2:

1. **Real-network retry harness (MSW / supertest).** Still on the
   R22/R23/R24/R25/R26/R27 punchlist. Proves Stripe + Vapi webhook
   dedupe across sequential POST bursts with shifted + replayed
   signatures. Unit-level dedupe coverage exists for twilio/sms,
   vapi/inbound-callback, vapi/webhook, and now stripe/webhook;
   MSW would prove the behavior under a real fetch stack. ~45 min.
2. **Cron route lib-level capture audit, part 2 — `check-status`.**
   `lib/cron/send-reports.ts` and `lib/cron/retry-failed-calls.ts`
   got their audits this round. `app/api/cron/check-status/route.ts`
   uses its own `{route,reason:'integrationProbeFailed'}` locked
   tag but there may be lib-level silent paths (Stripe ping,
   Vapi ping) worth capturing independently. ~30 min.
3. **Next.js 14.3.x CVE bump IF pre-approved.** Intermediate hop.
   Resolves 3 of the 5 advisories. Requires preview-deploy. ~45 min.
4. **`lib/actions/post-payment.ts` capture-site audit.** Magic-
   link send surface referenced in R26 memory but not audited
   end-to-end. ~30 min.
5. **`lib/queue/enqueue-calls.ts` / `lib/calls/engine.ts` catch-
   path cross-check.** R25 locked `enqueue` tag shapes; confirm
   `engine.ts` has no new silent paths after R25's work. ~20 min.

---

## Summary

Round 27 closed **three** of the five items from Round 26's
suggested punchlist: (b) stripe webhook drift-detection tests —
5 drift locks across payments+quote_requests DB shapes; (c)
lib/cron capture-site audit — 7 new lib-level Sentry surfaces
across send-reports and retry-failed-calls; (e) stripe-auth.ts
test expansion — 5 new auth failure modes including the
replay-guard that locks the tolerance window.

Capture-site count grew from **~21 → ~28**. Every genuinely
silent cron failure surface now routes to Sentry (pending DSN).
Drift-detection coverage now sits on ALL four external webhooks
(stripe, twilio/sms, vapi/webhook, vapi/inbound-callback) — any
silent DB-shape drift from a future migration fails a test before
it fails production.

All green. 920 passing, typecheck clean, lint clean. Four npm
audit vulns unchanged; all cross-major; all still blocked on
user pre-approval.

— Claude, 2026-04-23 (twenty-seventh run, autonomous)
