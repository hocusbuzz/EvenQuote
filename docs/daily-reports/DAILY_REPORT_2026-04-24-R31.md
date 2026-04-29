# Daily Report — 2026-04-24 — Round 31 (autonomous)

## TL;DR

983 tests passing across 80 files (R30 close: 974/80; **+9 tests, 0 new files**). `tsc --noEmit` clean. `next lint` clean. `npm audit --omit=dev` identical to R30.

Shipped two of the five R30-punchlist items and marked two as already-done after inspection:

1. **Vapi webhook R31 idempotency-column drift suite (+4 tests).** Sibling to R30's Stripe drift work. Locks the THREE columns that form the webhook's at-most-once defense (`vapi_call_id` lookup, `counters_applied_at` sentinel, `quotes.call_id` UNIQUE backstop) against rename drift, plus a previously unlocked `calls`-row update 8-column shape.
2. **`lib/calls/select-vapi-number.ts` capture-site audit (+5 tests, +2 capture sites).** Previously unaudited lib — pool RPC error/throw silently degrades to env fallback, losing area-code matching across every outbound call. New canonical tags `{lib:'vapi-pool', reason:'pickRpcErrored'|'pickRpcThrew'}`.

Attestations filed (no shipped code) on:

3. **`lib/calls/engine.ts` post-R28 silent-path re-audit.** Five locked reasons + regression-guard intact; no new silent paths since R28.
4. **`lib/queue/enqueue-calls.ts` post-R28 capture re-audit.** Thin facade over the engine; deliberate no-capture contract (R22 locked). No new silent paths.

The R30-punchlist item for the success-page metadata drift check is already locked by `app/get-quotes/metadata.test.ts`; confirmed during discovery, no action needed.

**~41 Sentry capture sites now waiting on DSN unlock** (was ~39 at R30 close; +2 from the vapi-pool audit).

Zero changes touch the customer-facing surface. Purely defensive wiring + drift detection.

---

## Shipped

### 1. `app/api/vapi/webhook/route.test.ts` — idempotency-column drift suite (+4 tests)

R30 introduced the idempotency-key drift pattern on the Stripe webhook: lock the column NAME that carries the at-most-once semantic against silent rename drift. This is the Vapi-webhook sibling.

Vapi's at-most-once guarantee is a three-layer defense and each layer has a column-name contract:

- **LOOKUP:** the route finds its `calls` row via `.eq('vapi_call_id', …)`. Rename to `provider_call_id`/`external_id`/`vapi_id` and EVERY webhook lookup returns null → every delivery becomes a silent 200 no-op ("no calls row for …"). Customer paid, nothing ever lands.
- **SENTINEL:** the short-circuit reads `counters_applied_at`. Rename to `applied_at`/`completed_at`/`finalized_at` and the guard always sees falsy → every retry re-processes the call → double counter bumps, duplicate summary writes, duplicate success-rate recomputes.
- **UNIQUE BACKSTOP:** `quotes.call_id` is UNIQUE. The R26 "23505-swallow" test locked BEHAVIOR; the R31 test locks the ANCHOR column name — a refactor that moves quote-uniqueness onto a different column reintroduces duplicate-quote risk on parallel retries.

Four new tests in a new `describe('idempotency-column drift (R31) — locks at-most-once column names')` block:

- **`LOOKUP layer`** — asserts the first `.eq(…)` on `calls` is keyed on `vapi_call_id` with negative assertions against `external_id` / `provider_call_id` / `call_event_id` / `vapi_id` / `voicemail_id` drifts. (The SECOND eq on calls is `.update(…).eq('id', …)` and is legitimate — both column names locked separately in the UPDATE-shape test.)
- **`SENTINEL layer`** — double test: (a) with `counters_applied_at` stamped, ZERO downstream writes fire (calls-update length=0, quote-inserts length=0, apply_call_end RPC count=0); (b) with `counters_applied_at` NULL, ALL downstream writes DO fire. The contract is: `counters_applied_at` is the ONLY column that controls this short-circuit.
- **`UPDATE shape`** — exact 8-column key-set lock on the `calls.update(…)` row: `status`, `ended_at`, `duration_seconds`, `transcript`, `recording_url`, `summary`, `extracted_data`, `cost`. Negative assertions against drift candidates (`completed_at`, `finished_at`, `duration`, `transcript_text`, `recording`, `call_summary`, `structured_data`, `total_cost`). Also locks the `eq` sequence on calls as `['vapi_call_id', 'id']` so a flip requires updating the test.
- **`UNIQUE backstop`** — locks the quotes insert payload carries `call_id` as the UNIQUE anchor pointing at our internal calls row id (not `vapi_call_id`). Negative assertions against `calls_id` / `vapi_call_id` / `provider_call_id` / `call_ref` / `id`. The vapi_call_id drift is called out specifically — a "simplify the join" refactor might target it and would silently break the R26 23505-swallow guarantee.

New drift-capturing stub `buildDriftCapturingAdminStub` records the column name passed to every `.eq(…)` and `.update(…)` so these assertions can be made (prior stubs only captured values, not column names).

**Tests:** `app/api/vapi/webhook/route.test.ts` 24 → 28.

### 2. `lib/calls/select-vapi-number.ts` — capture-site audit (+5 tests, +2 new capture sites)

**Real fix, not hygiene.** The pool-RPC `pick_vapi_number` selects the outbound caller-ID with area-code matching — the single biggest lever on pickup rate for cold outbound. Pre-R31 both failure paths (RPC returned `{error}`, RPC threw) were `log.warn` only. A silent degradation to env fallback means EVERY outbound call loses area-code matching and ops finds out from pickup-rate dashboards days later.

Two new canonical capture sites at the lib boundary:

- `{lib:'vapi-pool', reason:'pickRpcErrored'}` — wraps the RPC-returned-`{error}` path with a controlled-prefix message (`'pickVapiNumber rpc errored: '`) so Sentry fingerprints stably across upstream RPC-error-text drift.
- `{lib:'vapi-pool', reason:'pickRpcThrew'}` — wraps the RPC-transport-threw path (ECONNRESET, fetch reject, etc.) with a distinct controlled-prefix message. Separate reason so ops can tell "Supabase transport down" apart from "RPC returned error" on the Sentry dashboard — different root causes, different runbooks.

New exported type `PickVapiNumberReason` with a code-level comment listing the three paths deliberately NOT captured (empty pool, missing Supabase env, missing env fallback) — each documented as "config state, not incident" per R29's pattern.

**Deliberately NOT captured** (negative-tested):

- Empty pool (`data.length === 0`): config state — this IS the intended single-number deploy. Capturing would flood on every dev-local run.
- Missing Supabase env entirely: deploy-time misconfig, Sentry may not be initialized, and the route has other places that would surface the error.
- Happy path (tier=area_code / tier=any): sanity lock so a regression that captures on every call can't sneak past.

**Tests:** `lib/calls/select-vapi-number.test.ts` 14 → 19.

- Two existing "falls back to env" tests updated to assert the capture fires with canonical tag shape.
- New happy-path no-capture test.
- New empty-pool no-capture test (locks R29 config-state-no-capture pattern).
- New missing-env no-capture test (locks deploy-time-config no-capture).
- New PII guard: captured `err.message` + tag bag MUST NOT contain the destination phone, the 10-digit subscriber number, or the area code. The tag bag MUST NOT carry `phone`/`toPhone`/`areaCode` keys.
- New regression guard: locks the `PickVapiNumberReason` allow-list, forbids drift candidates (`unknown`, `error`, `rpcFailed`, `poolError`, `fallback`).

### 3. Attestation: `lib/calls/engine.ts` re-audit (no shipped code)

R30 suggested cross-checking engine.ts for any new silent paths since R28's `noBusinessesFallbackFailed`. Full read confirms the file is at steady state relative to R28:

- All 5 locked reasons present with the wrapped-error pattern (`claimFailed`, `insertFailed`, `plannedCountUpdateFailed`, `callIdPersistFailed`, `noBusinessesFallbackFailed`).
- Regression guard in `engine.test.ts` at L638-714 with `LOCKED_REASONS = {5 values}` and forbidden catch-alls (`updateFailed`, `dispatchFailed`, `runBatch`) intact.
- Three error paths deliberately NOT captured, each justified and documented (R28 memo):
  - `businesses.last_called_at` update — cool-off drift only; low blast radius.
  - `calls.status='failed'` post-dispatch-fail — already captured at `lib/calls/vapi.ts` HTTP boundary; R26 no-double-capture rule.
  - Final counters update (L305-311) — overridden by apply-end-of-call's per-call RPC increments.

No new silent paths introduced since R28. No shipped code.

### 4. Attestation: `lib/queue/enqueue-calls.ts` re-audit (no shipped code)

R30 also suggested cross-checking the enqueue facade. The file is 62 lines and contains exactly ONE external call (`runCallBatch` from `lib/calls/engine`). The R22 lib-boundary audit established the contract that this facade deliberately does NOT capture — the engine captures at the lib boundary with `{lib:'enqueue', reason}` tags, and duplicating at the facade would create a second Sentry event for the same root cause (different stack trace = no dedupe).

The `enqueue-calls.test.ts` R22 block at L179-235 asserts this contract three ways: happy path no-capture, engine-returns-ok:false no-capture, engine-throws no-capture. No new silent paths. No shipped code.

### 5. Attestation: `app/get-quotes/success/page.tsx` metadata drift check

R30's last suggested item. The success page exports `metadata: { title: 'Quote request received', robots: { index: false, follow: false } }`. Already locked by `app/get-quotes/metadata.test.ts` at L89-99 — imports `successMetadata` from `./success/page` and asserts `robots: { index: false, follow: false }` + title-truthy. Covered, no action needed.

### 6. Verification

- `vitest run` → **983 passed / 0 failed** across 80 files.
- `tsc --noEmit` → clean.
- `next lint` → clean.
- `npm audit --omit=dev` → identical to R30 (3 moderate + 1 high: next, uuid, svix, resend — all cross-major, still blocked on user pre-approval).

---

## Implementation notes for Round 32+

- **Sentry DSN capture-site count now ~41** (was ~39 at R30 close). Added: 2 vapi-pool reasons (`pickRpcErrored`, `pickRpcThrew`). The vapi-webhook idempotency-column drift suite added no new capture sites — it's invariant locks on existing observable shapes.
- **Locked lib tag shapes** now: all R30 entries plus **NEW** `{lib:'vapi-pool', reason:'pickRpcErrored'|'pickRpcThrew'}`.
- **Locked route tag shapes** unchanged from R30.
- **PII contract held** across the new vapi-pool capture sites: phone numbers, subscriber digits, and area codes explicitly negative-tested to never reach Sentry (the tag bag carries only `lib`/`reason`; the wrapped message prefix is controlled).
- **R31 drift-capturing stub pattern** documented inline in `app/api/vapi/webhook/route.test.ts` R31 block. The stub records the column name passed to `.eq(…)` and `.update(…)`. Reuse for any future test that needs to lock lookup/update column names (candidates: the twilio/sms route's calls lookup, stripe webhook's payments select).
- **Wrapper-via-closure pattern** for `vi.mock('@/lib/observability/sentry')` at the top of `lib/calls/select-vapi-number.test.ts` — matches `lib/calls/engine.test.ts`. Direct spy reference in the factory hits Vitest's hoisting + TDZ; wrapping in a function body defers the spy access to call time. Document if Round 32+ adds more capture-audit tests.

## Outstanding human-input items

Unchanged at 12. **Sentry DSN (user-input #6) remains the highest-value unlock — ~41 capture sites waiting now.** Without the DSN, every one of these captures is a no-op at runtime; the tests exercise the wrapper contract but the signal never leaves the process.

The following items require user action and cannot move autonomously:

1. **Legal pages draft + counsel review + noindex flip** — privacy/terms pages exist with defense-in-depth noindex locked by `app/legal/metadata.test.ts`. Content draft waiting on counsel per user's "don't ship unreviewed legal" constraint.
2. **Sentry DSN unlock (HIGHEST VALUE)** — ~41 capture sites now wired. Without the DSN they're no-ops. Install: set `SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN` in prod env, verify `captureException` wires to `@sentry/nextjs` or equivalent per the stub in `lib/observability/sentry.ts`.
3. **Next.js 14.3.x CVE bump** — blocked on user pre-approval. `npm audit --omit=dev` still shows 3 moderate + 1 high across next/uuid/svix/resend, all cross-major.
4. **Upstash Redis migration** — token-bucket rate limiter is in-memory today; scales per instance. Needed before going multi-region or even multi-instance.
5. **resend@>=6.2.0 bump** — transitively fixes the uuid high. Cross-major, needs review.
6. **uuid major bump** — direct cross-major.
7. **svix major bump** — blocked by the resend dependency chain.
8. **Production domain DNS + MX verify** — `evenquote.com` canonical; Resend sender verification step.
9. **Stripe prod keys / webhook endpoint rotation** — test keys only currently wired.
10. **Vapi prod account / phone-number pool population** — single-number deploy today via `VAPI_PHONE_NUMBER_ID`; pool table empty.
11. **Twilio prod account / SMS signature secret rotation** — test mode only.
12. **Analytics / PostHog project creation** — tracking stubbed but not ingesting.

## Suggested next autonomous run (Round 32)

(a) **Real-network retry harness (MSW/supertest) for stripe + vapi webhook retry storm.** On the punchlist since R22 and ~40 capture sites of prior work now establishes the invariant shape; R30's stateful-stub pattern + R31's drift-capturing stub pattern converge on what the MSW version needs. ~45 min.

(b) **`lib/actions/admin.ts` capture-site audit.** Single function (`setRequestArchived`) with log.error-only on DB failure. Admin-only path, low blast radius, but unaudited. ~15 min.

(c) **`app/api/csp-report/route.ts` capture audit.** `persistViolation()` has try/catch with `log.warn` and no captureException. Low urgency (the endpoint itself is a security telemetry sink, failures are recoverable) but would close out the remaining unaudited route handlers. ~20 min.

(d) **Next.js 14.3.x CVE bump IF pre-approved.** ~45 min.

(e) **Twilio SMS route idempotency-column drift suite.** Mirror of R31's vapi-webhook work — lock the `.eq(…)` lookup columns (currently `vapi_call_id` on the synthetic `sms_*` prefix) and the 23505 swallow anchor (same `quotes.call_id` UNIQUE). ~25 min.

(f) **`lib/observability/sentry.ts` wiring verification tests.** With ~41 capture sites locked across test suites but no runtime DSN, a regression where the stub's `captureException` signature diverges from the real `@sentry/nextjs` signature would go undetected until deploy. Add a type-shape sanity test now. ~15 min.
