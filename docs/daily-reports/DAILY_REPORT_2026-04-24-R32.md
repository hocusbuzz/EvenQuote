# Daily Report — 2026-04-24 — Round 32 (autonomous)

## TL;DR

1038 tests passing across 82 files (R31 close: 983/80; **+55 tests, +2 new files**). `tsc --noEmit` clean. `next lint` clean. `npm audit --omit=dev` identical to R31.

Shipped four of the six R31-punchlist items — the remaining two (Next.js CVE bump, MSW real-network harness) are still blocked: the CVE bump requires your pre-approval; the MSW harness is now the single largest unfinished piece on the observability track and deserves its own dedicated round.

**Four shipped:**

1. **`lib/actions/admin.ts` capture audit (+15 tests, +1 capture site, new test file).** `setRequestArchived` had log-only DB error handling. An admin-only surface, but a silent RLS regression would leave operators staring at a failed toast with no Sentry trail. New `{lib:'admin', reason:'archiveUpdateFailed', requestId}` canonical tag + wrapped-error pattern. Zero tests pre-R32 → 15 tests post-R32.
2. **`app/api/csp-report/route.ts` capture audit (+10 regression-guard tests, 0 new capture sites).** Attestation outcome: the route deliberately does NOT wire captureException. Four reasons, documented in the route header comment block: (i) it's a telemetry sink, capturing it creates observability loops; (ii) persist failures only fire during CSP_VIOLATIONS_PERSIST rollout windows where ops is already watching the log drain; (iii) `createAdminClient()` throws are deploy-time config state per R29 pattern; (iv) browser garbage (empty bodies, non-CSP report-to entries, malformed JSON) would flood. Regression-guard suite locks the no-capture contract across 10 input shapes.
3. **Twilio SMS route idempotency-column drift suite (+9 tests).** Sibling to R31's vapi-webhook drift work. Locks four layers of the SMS at-most-once defense: (a) LOOKUP on `vapi_call_id` (not `external_id`/`twilio_sid`/`message_sid`/`sid`); (b) SYNTHETIC-ID `sms_` prefix on BOTH generation AND lookup (same value, deterministic hash); (c) INSERT shape — exact 10-column set on `calls`, status literal `'completed'`, negative-tested against drift candidates; (d) UNIQUE backstop — `quotes.call_id` as the UNIQUE anchor (NOT the tempting-to-use `vapi_call_id`), with 23505-swallow behavior re-locked. Also locks the `increment_quotes_collected(p_request_id)` RPC contract (R25 had this but drift suite audits all load-bearing names in one place).
4. **`lib/observability/sentry.ts` wiring verification tests (+21 tests, new test file).** With ~43 capture sites now locked across test suites but no runtime DSN, a drift between the stub's call signature and `@sentry/nextjs` v8's public API would go undetected until deploy. New `sentry-wiring.test.ts` locks: (a) stub-mode no-op safety across every documented shape; (b) Sentry SDK v8+ signature compatibility (captureException/captureMessage/setUser/init); (c) PII boundary — tags are `Record<string, string>` and the stub doesn't mutate passed ctx objects; (d) CaptureContext surface — exactly `{tags, user, extra}` keys accepted; (e) enabled-path parity — when DSN flips on, every real-world call shape keeps working.

Zero changes touch the customer-facing surface. Purely defensive wiring + drift detection + attestation.

**~43 Sentry capture sites now waiting on DSN unlock** (was ~41 at R31 close; +1 from admin.ts audit, +1 from re-counting during verification).

---

## Shipped

### 1. `lib/actions/admin.ts` — capture-site audit (+15 tests, +1 site)

**Real fix, not hygiene.** `setRequestArchived` is the single admin-surface write action — it toggles `archived_at` on a `quote_request`. Pre-R32, the error path was `log.error(…)` and return `{ok: false, error}`. Admin-only so the blast radius is bounded, but a silent RLS regression (or a permission-denied after a Supabase role migration) would leave operators staring at a "save failed" toast with zero ops signal.

New canonical capture at the lib boundary:

- `{lib:'admin', reason:'archiveUpdateFailed', requestId}` — wrapped-error pattern with controlled-prefix message `'quote_requests.update(archived_at) failed'` to stabilize Sentry fingerprints. Supabase error strings include column/relation names and occasionally row data (constraint violations dump the offending row) — the wrapped message + tag boundary is our PII boundary here, not just observational.

New exported type `AdminReason = 'archiveUpdateFailed'` — single-value union today, conscious to keep the allow-list explicit when future admin actions get added.

**Deliberately NOT captured** (negative-tested):

- Missing `requestId` input-validation: user/invariant error, not an incident. A form-state bug would flood Sentry on every empty submit.
- `requireAdmin()` redirect (non-admin attempting to reach the surface): auth-denial, not a system failure. Captured upstream by the auth layer if needed.
- Happy path: false-positive guard sanity-tested.

**New test file `lib/actions/admin.test.ts` (15 tests):**

- Happy path — archive writes ISO-timestamp, returns ok, revalidates all 3 paths (/admin, /admin/requests, /admin/requests/:id).
- Happy path — unarchive writes null.
- DB update payload is a single-key object `{archived_at}` (no stray columns).
- `requireAdmin()` await-BEFORE-DB-work invariant.
- Missing requestId short-circuits WITHOUT DB call, WITHOUT capture, WITHOUT revalidate.
- DB error returns `{ok:false, error}`, does NOT revalidate.
- DB error captures with canonical `{lib:'admin', reason:'archiveUpdateFailed', requestId}` tags.
- DB error wrapped message locked at `'quote_requests.update(archived_at) failed'`.
- No-PII guard — raw Supabase text + admin user id + row-id absent from captured ctx.
- No-PII guard — `archived` boolean is NOT in tags.
- Happy path no-capture false-positive guard.
- Regression: forbids reason catch-alls (`unknown`, `error`, `failed`, `updateFailed`, `archiveFailed`, `dbFailed`, `runFailed`).
- Regression: reason is in single-value `AdminReason` allow-list.
- Regression: tag object is strictly `{lib, reason, requestId}` — no extra facets.
- Regression: wrapped-message prefix locked.

Test pattern mirrors R28 checkout.test.ts and R30 post-payment.test.ts.

### 2. `app/api/csp-report/route.ts` — capture audit (+10 regression-guard tests, 0 sites)

**Attestation outcome, not a new capture site.** The route is a security-telemetry SINK: browser-reported CSP violations flow IN, go to the log stream, and (during rollout windows only) to a `csp_violations` table. It's part of the observability pipeline, not a participant in it.

Documented four reasons in the route header for deliberate no-capture:

1. **Observability loop risk** — wrapping a telemetry sink in telemetry creates cycles where a Sentry hiccup silently doubles as a CSP-report failure and vice versa. The structured log drain is the single primary signal.
2. **Rollout-window frequency** — `persistViolation()` failures fire only when `CSP_VIOLATIONS_PERSIST=true`, which is during an intentional collection window. Ops is already watching the log drain during those windows; per-violation captureException would flood at browser-violation frequency (ad-heavy pages can emit hundreds of reports per load).
3. **Deploy-time config state** — `createAdminClient()` throws only on missing env, which per R29's config-state-no-capture pattern is deploy-time not runtime. Every other route would have broken first.
4. **Browser garbage** — malformed JSON, empty bodies, network-error report-to entries, unrecognized shapes all silently swallow to 204. Capturing any of these would flood on legitimate browser noise.

New `describe('observability contract — no capture')` block (+10 tests) locks the decision across:

- 7 `noCaptureInputs` shapes: well-formed report-uri, report-to array, empty csp-report body, unrecognised body, array of non-CSP entries only, empty array, malformed JSON.
- `persistViolation` DB insert error during a rollout window → no capture.
- `createAdminClient` throws → no capture.
- Payload exceeding 64 KB ceiling → no capture (size-attack guard doesn't fire Sentry).

If a future maintainer adds captureException to this route, the tests fail — forcing both the test file AND the route comment block to be updated together. That's the whole point.

**No shipped code in the route itself** beyond the explanatory header comment.

### 3. Twilio SMS route idempotency-column drift suite (+9 tests)

Sibling to R31's vapi-webhook drift work. The Twilio SMS route rides on the SAME `calls.vapi_call_id` UNIQUE constraint as voice calls, using a synthetic `sms_<hash>` prefix so voice and SMS IDs can't collide. Four layers of name-based load-bearing behavior, all previously unlocked:

- **LOOKUP:** dedupe select keys on `vapi_call_id` — negative-tested against `external_id`, `provider_msg_id`, `twilio_sid`, `message_sid`, `sms_id`, `sid` drift candidates.
- **SYNTHETIC-ID PREFIX:** `sms_` prefix on BOTH generation AND lookup — negative-tested against `twilio_`, `msg_`, `sms:`, `tw_`, `SMS_`. Plus: the hash generation is deterministic (same `(requestId, from, body)` triple → same id) AND partitioning (different body → different id).
- **INSERT SHAPE:** exact 10-column set on `calls` (`quote_request_id`, `business_id`, `vapi_call_id`, `status`, `started_at`, `ended_at`, `duration_seconds`, `transcript`, `summary`, `cost`). Status literal `'completed'` locked. Negative-tested against `completed_at`/`finished_at`/`duration`/`transcript_text`/`sms_body`/`call_summary`/`total_cost`/`provider_call_id`/`external_id` drifts.
- **UNIQUE BACKSTOP:** `quotes.call_id` as the UNIQUE anchor — negative-tested against `calls_id`/`vapi_call_id` (the tempting simplification) / `provider_call_id`/`sms_id`/`message_sid`/`call_ref`/`id`. 23505 swallow behavior re-locked.
- **RPC CONTRACT:** `increment_quotes_collected(p_request_id)` — negative-tested against name drifts (`bump_quotes_collected`, `increment_quote_count`, `apply_sms_quote`, `increment_quotes`) and arg drifts (`request_id`, `p_quote_request_id`, `quote_request_id`, `p_id`).
- **DEDUPE SHORT-CIRCUIT:** existing row in dedupe lookup → zero inserts, zero RPC.

Methodology mirrors R31 drift-capturing stub: records column NAMES passed to `.eq(…)` / `.insert(…)` / `.rpc(…)` so the assertions can be made against observable behavior rather than code inspection.

**Tests:** `app/api/twilio/sms/route.test.ts` 14 → 23 (+9).

### 4. `lib/observability/sentry-wiring.test.ts` — new file (+21 tests)

R31's punchlist item (f). With ~43 capture sites locked across test suites but no runtime DSN, any drift between the stub's call signature and `@sentry/nextjs` v8 would be silent until the DSN unlock deploys.

New test file locks four categories of Sentry contract:

**(a) Stub-mode no-op contracts (6 tests):** `captureException(err)` / `captureException(err, undefined)` / `captureException(non-Error)` (Sentry accepts `any`, our stub must too) / `captureMessage('msg')` without level or ctx / `captureMessage` accepts every `CaptureLevel` / `setUser({})` + `setUser(null)` / init idempotency across many calls.

**(b) Sentry SDK v8+ signature compatibility (7 tests):** the three common capture patterns at our ~43 sites (`{tags: {lib, reason}}`, `{tags: {lib, reason, requestId}}`, `{tags: {route, vapiCallId}}`), full ctx round-trip with tags+user+extra, captureMessage three-arg form, SeverityLevel alignment, setUser shape, init return-void (sync — critical for module-load-time call sites).

**(c) PII boundary (3 tests):** tags are string-valued only, stub does not mutate passed ctx object (Sentry uses `withScope()` for mutation), stub does not mutate passed user on setUser.

**(d) CaptureContext key-set lock (1 test):** tags/user/extra subsets all round-trip through captureException + captureMessage. A future type refactor that adds/removes documented keys fails compile before runtime.

**(e) Enabled-path signature parity (2 tests):** flipping DSN on — every call shape the ~43 sites use still works. Non-Error captureException remains safe with flag flipped.

### 5. Verification

- `vitest run` → **1038 passed / 0 failed** across 82 files (R31: 983/80). +55 tests, +2 new files.
- `tsc --noEmit` → clean.
- `next lint` → clean.
- `npm audit --omit=dev` → identical to R31 (3 moderate + 1 high: next, uuid, svix, resend — all cross-major, still blocked on pre-approval).

---

## Implementation notes for Round 33+

- **Sentry DSN capture-site count now ~43** (was ~41 at R31 close). Added: 1 admin reason. The csp-report attestation counted as 0 (deliberate no-capture contract). The twilio drift suite added 0 (invariant locks on existing sites). The sentry-wiring tests are self-referential — they don't add sites; they lock the contract ALL sites funnel through.
- **Locked lib tag shapes** now: all R31 entries plus **NEW** `{lib:'admin', reason:'archiveUpdateFailed'}`. `AdminReason` type exported as single-value union.
- **Locked route tag shapes** unchanged from R31.
- **R32 attestation pattern** for telemetry sinks: document the no-capture contract in the route header with numbered reasons, then write regression-guard tests that iterate input shapes. Canonical example in `app/api/csp-report/route.ts` + `app/api/csp-report/route.test.ts`. Reuse pattern for any future route where capture would be net-negative (health checks, logging ingesters, etc.).
- **R32 drift-capturing stub pattern** continues from R31. The Twilio SMS suite extends it to insert-shape locks (not just eq/update-shape from vapi). Canonical stub: `buildDriftCapturingAdminStub` in `app/api/twilio/sms/route.test.ts`. For future route-level drift suites, the stub pattern is now well-documented in three places (stripe, vapi/webhook, twilio/sms) and can be lifted to a shared helper if a fourth lands.
- **Sentry SDK v8 signature parity** now machine-checked. If you bump `@sentry/nextjs`, run `lib/observability/sentry-wiring.test.ts` first; a fail there means either the stub needs to adopt the new signature (preferred) or we cap the dep at the last-compatible major.
- **PII contract held** across all new capture sites. Admin audit: no admin email, no raw Supabase message, no row id, no `archived` boolean in tags. Twilio drift suite: no phone number / SMS body / request-id bleed beyond the established `req-drift` synthetic values. Sentry wiring tests: verify the stub doesn't mutate ctx objects (prevents accidental state leak across capture sites that share a ctx by reference).

## Outstanding human-input items

Unchanged at 12. **Sentry DSN (user-input #6) remains the highest-value unlock — ~43 capture sites waiting now.** Without the DSN, every one of these captures is a no-op at runtime; the tests exercise the wrapper contract but the signal never leaves the process.

The following items require your action and cannot move autonomously:

1. **Legal pages draft + counsel review + noindex flip** — privacy/terms pages exist with defense-in-depth noindex locked by `app/legal/metadata.test.ts`. Content draft waiting on counsel per your "don't ship unreviewed legal" constraint.
2. **Sentry DSN unlock (HIGHEST VALUE)** — ~43 capture sites now wired. Without the DSN they're no-ops. Install: set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` in prod env, verify `captureException` wires to `@sentry/nextjs` or equivalent per the stub in `lib/observability/sentry.ts`. R32's sentry-wiring tests will validate the signature parity as soon as you flip it.
3. **Next.js 14.3.x CVE bump** — blocked on pre-approval. `npm audit --omit=dev` still shows 3 moderate + 1 high across next/uuid/svix/resend, all cross-major.
4. **Upstash Redis migration** — token-bucket rate limiter is in-memory today; scales per instance. Needed before going multi-region or even multi-instance.
5. **resend@>=6.2.0 bump** — transitively fixes the uuid high. Cross-major, needs review.
6. **uuid major bump** — direct cross-major.
7. **svix major bump** — blocked by the resend dependency chain.
8. **Production domain DNS + MX verify** — `evenquote.com` canonical; Resend sender verification step.
9. **Stripe prod keys / webhook endpoint rotation** — test keys only currently wired.
10. **Vapi prod account / phone-number pool population** — single-number deploy today via `VAPI_PHONE_NUMBER_ID`; pool table empty.
11. **Twilio prod account / SMS signature secret rotation** — test mode only.
12. **Analytics / PostHog project creation** — tracking stubbed but not ingesting.

## Suggested next autonomous run (Round 33)

(a) **Real-network retry harness (MSW/supertest) for stripe + vapi webhook retry storm.** On the punchlist since R22. Every incremental drift suite (R30 stripe, R31 vapi-webhook, R32 twilio-sms) has converged on the invariant shape the MSW version needs. This is now the single largest unfinished piece on the observability track. ~60–90 min with the shape pre-established.

(b) **`app/api/health/route.ts` + `app/api/version/route.ts` capture audit.** Both are operator-facing endpoints that report probe state. Neither has been end-to-end audited for capture coverage. Low-complexity, ~30 min. Likely outcome: attestation (these are probe endpoints, capturing the probes themselves creates the same observability-loop concern as csp-report) + regression-guard tests.

(c) **`lib/security/` catch-path audit.** `stripe-auth.ts`, `vapi-auth.ts`, `rate-limit-auth.ts` all have error paths that return 401/429 without capture. Correct by design (these are gates that fire at adversarial frequency). But the allow-list isn't locked anywhere. ~30 min for attestation + regression-guards across the three files.

(d) **Next.js 14.3.x CVE bump IF pre-approved.** ~45 min.

(e) **`lib/observability/version.ts` test expansion.** `version.test.ts` has 8 tests on the commit-sha helpers; the `consistency.test.ts` locks /api/health and /api/version use the same source. Not audited for edge cases: missing `VERCEL_GIT_COMMIT_SHA`, local `git rev-parse` fallback behavior, empty-string-sha handling. ~20 min.

(f) **Stripe webhook retry-storm MSW harness specifically** — if (a) gets scoped down. The R30 stateful-stub pattern already establishes the invariant; the MSW version just needs to route fetch intercepts to a real event-ledger. ~45 min standalone.
