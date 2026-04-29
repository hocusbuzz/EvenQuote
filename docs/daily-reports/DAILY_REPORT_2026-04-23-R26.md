# Daily Report — 2026-04-23 (Round 26, autonomous)

**Status:** 901 passing across 80 files. `tsc --noEmit` clean.
`next lint` clean. Baseline was Round 25 at 890/80 — delta **+11
tests, 0 new files** (all adds into existing files).

No production-code regressions. One new lib-level capture surface
(`lib/calls/extract-quote.ts`, four discrete failure modes) and
canonical `reason` tag now locked across all three `/api/cron/*`
routes. Safe to merge.

---

## Shipped this round

### 1. `lib/calls/extract-quote.ts` — capture-site audit (real fix)

Audit target from R25's suggested punchlist (b). Prior to R26 the
extractor returned `{ ok: false, reason: string }` on every failure
path, and the caller (`lib/calls/apply-end-of-call.ts`) quietly
`log.info`'d the reason. Four of six failure modes carried real
signal that was never reaching Sentry:

| Reason                                        | Captured before R26? | Signal |
|-----------------------------------------------|----------------------|--------|
| `ANTHROPIC_API_KEY not set`                   | no (benign)          | — config state, don't capture |
| `No transcript to extract from`               | no (benign)          | — empty voicemails, don't capture |
| Anthropic HTTP 4xx/5xx                        | **no**               | anthropic outage / key rot / rate limit |
| Anthropic response missing tool_use           | **no**               | prompt or model regression (silent quality drop) |
| Anthropic response failed schema coercion     | **no**               | tool-use schema drift (silent bad data) |
| Network error (ECONNRESET, TLS, DNS)          | **no**               | infra / provider-side blip |

Two reasons are genuinely benign and must NOT capture (they would
flood Sentry the first time a preview env is spun up without the
key, or the first time Vapi delivers an empty transcript from a
voicemail-not-left). The other four now capture at the lib
boundary with canonical tags:

```
{ lib: 'extract-quote', reason: 'extractHttpFailed',          httpStatus }
{ lib: 'extract-quote', reason: 'extractMissingToolUse' }
{ lib: 'extract-quote', reason: 'extractSchemaCoercionFailed' }
{ lib: 'extract-quote', reason: 'extractTransportFailed' }
```

Mirrors the `lib/calls/vapi.ts` HTTP-boundary pattern exactly
(startCall*Failed). Tag shapes locked by 4 new assertions in
`extract-quote.test.ts` + a PII negative-guard that iterates every
captured failure mode and asserts no tag value matches `@` /
`\d{10,}` / transcript content / contact words. A regression-guard
test forbids catch-all reasons (`extractFailed`, `runExtract`,
`unknown`, `error`).

**Why no engine-level double-capture:** `lib/calls/apply-end-of-call.ts`
still log-infos the `reason` on `ok:false` but does NOT route it to
Sentry a second time. Same rule as the R25 engine.ts
dispatch.ok===false decision: the HTTP/transport boundary already
emitted, duplicating at the caller creates different-stack Sentry
events that no longer dedupe.

**Capture-site count:** was ~17 at R25 close, now **~21** (four new
discrete reasons).

### 2. `/api/cron/*` — lock the canonical `{ route, reason }` tag shape

Audit target from R25's suggested punchlist (c). All three cron
handlers previously captured with `{ route: 'cron/<name>' }` only.
One had an additional `{ stripe, vapi }` facet (check-status). None
had a `reason` tag — meaning a future second capture site inside
any of these routes would fight for the same route facet with no
way to distinguish.

Locked now:

| Route                          | `reason` tag                  |
|--------------------------------|-------------------------------|
| `cron/send-reports`            | `runFailed`                   |
| `cron/retry-failed-calls`      | `runFailed`                   |
| `cron/check-status`            | `integrationProbeFailed`      |

Each route's test file gets a new regression-guard test that hits
the capture path and asserts `reason` ∈ allow-list. Dashboards
querying by `(route, reason)` pair stay stable; dashboards querying
only by `route` continue working (strictly additive change).

+3 tests total, one per file.

### 3. `app/api/vapi/webhook/route.test.ts` — drift-detection suite (+5 tests)

Sibling to R25's new `twilio/sms` + `vapi/inbound-callback` full-
path blocks. The route itself was already well-covered at the
*behavioral* level (auth gates, idempotency, retry storm, recompute
best-effort). What was missing was a *drift-detection* layer: if a
migration renames a column or an RPC param, the behavioral tests
still pass (they don't actually hit Postgres — they use
`buildAdminStub`) but production would break silently at the RLS /
function-resolution layer.

New `describe('drift detection (R26)')` block locks the exact
observable shapes the webhook emits to the DB:

1. `quotes` insert carries EXACTLY the 15-column canonical set
   (set-equality on `Object.keys`, not superset). Silent column
   rename / addition fails here.
2. `apply_call_end` RPC arg-key set is EXACTLY
   `{p_request_id, p_call_id, p_quote_inserted}`. Silent rename
   (e.g. `p_request_id` → `request_id` which Postgres's overload
   resolution would quietly fail) fails here.
3. `recompute_business_success_rate` RPC name + `p_business_id`
   arg name. Silent rename = stale success scores in the
   contractor picker UI.
4. Terminal status enum literal `'completed'` still written on
   the happy path. A rename `completed → done` is low-probability
   but would silently break cron/send-reports' filter and stall
   reports.
5. `23505` on quotes insert (simulated unique_violation) is
   swallowed + `apply_call_end` still fires with
   `p_quote_inserted=false`. Mirror of the
   `vapi/inbound-callback` invariant: concurrent retries must
   NOT double-bump the counter.

**Mock-hygiene fix baked in:** the preceding
`captureException tag shape` block mocks `apply-end-of-call`
(either throwing or a no-op `{applied:true}`) to isolate the
route's try/catch. `vi.doMock` persists across `vi.resetModules()`,
so the drift suite opens with an explicit `vi.doUnmock('@/lib/calls/apply-end-of-call')` in its own `beforeEach` —
otherwise every drift test inherits a stub that returns without
touching the admin client. Pattern documented in-test; future drift
suites in sibling files should copy it.

### 4. Verification

```
vitest run        901 passing / 80 files
tsc --noEmit      clean
next lint         clean
npm audit --omit=dev   4 vulns (3 moderate, 1 high) — unchanged from R25
```

`npm audit` breakdown identical to R24/R25: next, uuid, svix,
resend; all cross-major; all still blocked on user pre-approval
(user-input #5).

---

## Items still needing your input (12 items — unchanged)

Priority descending by value-per-minute. Capture-site count for
Sentry DSN bumped from **~17 → ~21** with R26's four new
extract-quote reasons. The cron `reason` additions are within
existing routes so they don't move the site count — they sharpen
facet granularity on the ones already there.

1. **Sentry DSN (user-input #6) — still the highest-value unlock.**
   Every `captureException` call site across post-payment, resend,
   vapi, engine (4 reasons), stripe webhook, vapi webhook, all
   three cron routes (all now with locked `reason` facet),
   apply-end-of-call (2 reasons), match-inbound (2 reasons),
   vapi.ts (3 startCall* modes), twilio/sms route,
   vapi/inbound-callback route, and as of R26
   **extract-quote (4 reasons)** has canonical tag shapes locked
   by tests. Waiting-on-DSN sites now total **~21**. ~10 min.
2. **Upstash Redis creds (user-input #2).** In-memory token buckets
   die with cold starts + can't cross-instance. ~5 min.
3. **Legal counsel review of privacy + terms drafts** (NOT LEGAL
   ADVICE — drafts still noindexed + unlinked from footer). Blocks
   public launch. ~15 min to hand off.
4. **Swap placeholder OG + favicon + apple-touch-icon art.**
   Metadata SHAPE locked by four test files (root + `/get-quotes`
   flow + legal + dashboard + admin).
5. **Next.js CVE bump.** `^14.3.x` minimum, `^16.2.x` for full fix
   (`16.2.4` is the advisory-clean target). Requires preview-
   deploy testing. ~60 min.
6–12. Unchanged: Stripe account verification, production DNS,
   Resend domain DNS, Vapi number pool sizing, TWILIO_AUTH_TOKEN
   env in prod, BYOT Twilio number purchase, security monitoring
   vendor selection.

---

## Suggested next autonomous run (Round 27)

Pick 1–2:

1. **Real-network retry harness (MSW / supertest).** Still on the
   R22/R23/R24/R25 punchlist. Proves Stripe + Vapi webhook
   dedupe across sequential POST bursts with shifted + replayed
   signatures. Unit-level dedupe coverage exists for twilio/sms,
   vapi/inbound-callback, and (as of today) drift-locked vapi/
   webhook; MSW would prove the behavior under a real fetch
   stack. ~45 min.
2. **`app/api/stripe/webhook/route.ts` drift-detection tests.**
   Sibling to R25's twilio/sms + vapi/inbound-callback and R26's
   vapi/webhook. Stripe webhook is the last unprotected
   external-webhook surface. Lock: `quote_requests` column shape
   on insert/update, `payment_intent.succeeded` handler's row
   columns, idempotency key column name. ~30 min.
3. **`lib/cron/*` lib-level capture audit.** The cron *routes*
   now have locked tags (R26). The *lib* modules they call
   (`lib/cron/send-reports.ts`, `lib/cron/retry-failed-calls.ts`)
   have their own try/catch → log paths that may be silent. Mirror
   the extract-quote.ts audit pattern: identify genuinely silent
   failure paths and plumb them to Sentry with
   `{ lib: 'cron-<name>', reason }`. ~45 min.
4. **Next.js 14.3.x CVE bump IF pre-approved.** Intermediate hop.
   Resolves 3 of the 5 advisories. Requires preview-deploy. ~45 min.
5. **`lib/security/stripe-auth.ts` test expansion.** Only three
   stripe webhook auth tests exist today (signature verify path).
   Add: malformed timestamp, replayed signature with old
   timestamp, missing header. ~20 min.

---

## Summary

Round 26 closed **three** of the five items from Round 25's
suggested punchlist: (b) extract-quote capture-site audit —
shipped real fix not hygiene, four new discrete Sentry reasons;
(c) cron routes capture-site audit — lock `{route, reason}`; (e)
vapi/webhook full-path drift tests — five drift locks targeting
column-rename / RPC-rename / status-enum-rename risks.

Capture-site count grew from **~17 → ~21**. That's four additional
places per-failure-mode alerting is waiting on one env var. Cron
reason facet gives ops dashboards a finer filter even without
increasing the route count.

All green. 901 passing, typecheck clean, lint clean. Four npm
audit vulns unchanged; all cross-major; all still blocked on
user pre-approval.

— Claude, 2026-04-23 (twenty-sixth run, autonomous)
