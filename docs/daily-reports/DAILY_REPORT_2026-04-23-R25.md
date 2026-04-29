# Daily Report — 2026-04-23 (Round 25, autonomous)

**Status:** 890 passing across 80 files. `tsc --noEmit` clean. `next
lint` clean. Baseline was Round 24 at 858/78 — delta **+32 tests, +2
files**.

No production-code regressions. Two new capture sites landed in
`lib/calls/engine.ts` (silent-strand fixes, not hygiene) and three
new test files lock the shapes. Safe to merge.

---

## Shipped this round

### 1. `lib/calls/engine.ts` — skip-business capture audit (real fix)

The batch dispatcher had a documented "skip business, continue batch"
pattern for per-call failures. Audit found two genuinely silent skip
paths that had **no capture anywhere** — vapi.ts captures at the
HTTP/transport boundary but these failures happen AFTER vapi returns
ok:true:

**New capture site #1 — `plannedCountUpdateFailed`.** After the bulk
`calls` insert, engine updates `quote_requests.total_businesses_to_call`
to set the denominator apply-end-of-call uses for status-flip logic.
If that update silently errored (only a `notes.push` before R25), the
request would stay in status=`calling` FOREVER once the last dispatched
call completed — apply-end-of-call reads NULL for the counter and
short-circuits its own status flip. Worst-case: customer paid, calls
went out, quotes landed, but the UI never flips to "complete".

**New capture site #2 — `callIdPersistFailed`.** After a successful
Vapi dispatch, engine writes `vapi_call_id` back to the `calls` row.
If that update errored, Vapi was already dialing (potentially already
connected) but the end-of-call callback had nothing to match against
— apply-end-of-call looks up rows BY `vapi_call_id`. Worst silent
failure in the outbound pipeline; the customer's call went out, the
contractor may have picked up, and the transcript + quote dropped on
the floor.

Tag shapes locked:

```
{ lib: 'enqueue', reason: 'plannedCountUpdateFailed', quoteRequestId }
{ lib: 'enqueue', reason: 'callIdPersistFailed',     quoteRequestId, callId, businessId }
```

(Already-locked: `claimFailed`, `insertFailed`.)

Engine-level capture deliberately NOT added for the `dispatch.ok ===
false` skip path — vapi.ts already captures at its HTTP/transport
boundary with `{ lib: 'vapi', reason: 'startCall*' }` tags. A second
engine-level capture would create a duplicate Sentry event (different
stack trace → no dedupe) for the same root cause. If ops ever wants
a distinct "batch-level failure rate" dashboard, we add that tag
facet at call sites (retry, support reprocess) instead.

**Tests:** `lib/calls/engine.test.ts` — +3 tests + 1 regression-guard
that asserts engine never emits `reason: 'updateFailed'`, `'runBatch'`,
or `'dispatchFailed'` catch-alls. Each capture test includes the
PII-guard pattern (`@` + 10+ digit phone negative matches) we use
elsewhere. 9 → 12 total in this file.

### 2. NEW FILE — `app/admin/metadata.test.ts` (+12 tests)

R24 punchlist item (d) / (5). Six admin pages already had
`robots: { index: false, follow: false }`, but nothing asserted the
shape. A future refactor dropping the `robots` field from even one
page's Metadata export would silently un-noindex an operator surface
and ship to Google within a crawl cycle.

Locks noindex + non-empty title for all six surfaces via
parameterized `it.each`:

```
/admin
/admin/businesses
/admin/calls
/admin/failed-calls
/admin/requests
/admin/requests/[id]
```

Parallel to `app/dashboard/metadata.test.ts` and
`app/legal/metadata.test.ts` — same pattern, same invariants, same
reason. Admin surfaces are middleware-guarded by `requireAdmin()`
(audited: all six gates confirmed), but the HTML `robots` meta tag
is belt-and-suspenders. A future route that accidentally skips
`requireAdmin` still refuses to index if the metadata lock holds.

### 3. NEW FILE — `app/api/twilio/sms/route.test.ts` (full-path block, +5 tests)

R24 locked the signature gate perimeter. R25 exercises the full
chain inside the route: match → calls.insert → extract →
quotes.insert → RPC bump. Drift detection targets:

| Target                                  | How it fails silently if it drifts                 |
|-----------------------------------------|----------------------------------------------------|
| `calls` row column shape                | Schema migration renames a column, route writes old name → 400 → Twilio retry storm |
| `increment_quotes_collected` RPC name   | DB migration renames → counter stops bumping, UI never flips to complete |
| RPC `p_request_id` param name           | Same as above, rename path inside the function sig |
| `sms_` synthetic vapi_call_id prefix    | Idempotency lookup keyed on this; a change would let replay-duplicates double-insert |
| `23505` swallow on calls-insert race    | Concurrent-retry races would throw → 500 → Twilio storms us |

+5 tests. One full happy-path (all columns asserted), one
dedupe-short-circuit, one ok:false extractor (audit row but no quote),
one 23505 swallow, one non-23505 error with Sentry capture assertion.
Total for file: 9 → 14 tests.

Helper pattern locked: module-level mutable `adminClientImpl` +
`extractorImpl` that test helpers rewire, rather than `vi.doMock` with
re-imports (which fights Vitest's module cache). Document in
`/docs/` eventually if we build more route-level tests; the pattern
works cleanly here.

### 4. NEW FILE — `app/api/vapi/inbound-callback/route.test.ts` (+12 tests)

The voice analog of twilio/sms. Prior to R25 there were **zero**
tests on this route — it was relying on `lib/calls/vapi.ts`,
`lib/calls/match-inbound.ts`, and `lib/calls/extract-quote.ts` each
having their own suites, with no assertion on how the route composes
them.

Tests cover:

1. Signature gate — one belt-and-suspenders assertion so a refactor
   that drops `verifyVapiWebhook` fails here.
2. Non-end-of-call messages (`status-update` etc.) — 200 ignore.
3. Missing `call.id` → 400 (no downstream work).
4. Missing caller phone → 200 no-op (defensive, documented path).
5. Orphan match (no quote_request) → 200 no-op + NO Sentry capture
   (orphans must not page — wrong-number contractors would flood).
6. Dedupe lookup finds row → 200 no-op.
7. **Full happy-path** — canonical `calls` + `quotes` columns,
   `increment_quotes_collected` RPC name + `p_request_id` param,
   `extracted_data` plumbing from Vapi's structured-data analysis.
8. ok:false extractor → audit calls row yes, quotes no, RPC no.
9. 23505 on calls insert (race) → swallow, no quote, no bump.
10. 23505 on quotes insert (different race) → swallow, NO double-bump
    (critical: the other racer already bumped; counter MUST NOT fire
    again).
11. Non-23505 DB error on calls insert → 500 (so Vapi retries) +
    canonical `{ route: 'vapi/inbound-callback', vapiCallId }` Sentry
    tags.
12. Missing `increment_quotes_collected` RPC (not-yet-migrated DB) →
    log + keep 200 (don't turn a missing helper function into a
    retry storm).

### 5. Security re-sweep

No regressions. Same approved list for `console.*` (4 React error
boundaries + logger + resend PII-redacted trace + tests + CLI
scripts). No live-secret literals outside `lib/env.test.ts` fixtures.
No server `process.env.*` leaked into `'use client'` components.
`dangerouslySetInnerHTML` still confined to JSON-LD injection in
`app/layout.tsx` with `JSON.stringify` escaping. All six
`/admin/**` routes confirmed gated by `requireAdmin()`.

### 6. `npm audit --production`

Identical to R24: **4 vulnerabilities (3 moderate, 1 high)** across
next, uuid, svix, resend. All cross-major. Still blocked on pre-
approval. One minor note: the newest next advisory listed
(`GHSA-3x4c-7xq6-9pq8` — unbounded next/image disk cache) is
self-host-only; we're on Vercel so the risk profile is narrower.

---

## Items still needing your input (12 items — unchanged)

Priority descending by value-per-minute. Capture-site count for
Sentry DSN bumped from ~15 → **~17** with R25's
`plannedCountUpdateFailed` + `callIdPersistFailed` additions.

1. **Sentry DSN (user-input #6) — highest-value unlock.** Every
   `captureException` call site across post-payment, resend, vapi,
   engine (now 4 discrete reasons), stripe webhook, vapi webhook,
   all three cron routes, apply-end-of-call, match-inbound (both
   sites), vapi.ts (3 startCall* modes), twilio/sms route, and
   vapi/inbound-callback route has canonical tag shapes locked by
   tests. Waiting-on-DSN sites now total **~17**. ~10 min.
2. **Upstash Redis creds (user-input #2).** In-memory token buckets
   die with cold starts + can't cross-instance. ~5 min.
3. **Legal counsel review of privacy + terms drafts** (NOT LEGAL
   ADVICE — drafts still noindexed + unlinked from footer). Blocks
   public launch. ~15 min to hand off.
4. **Swap placeholder OG + favicon + apple-touch-icon art.** Metadata
   SHAPE locked by four test files now (root + `/get-quotes` flow +
   legal + dashboard + admin).
5. **Next.js CVE bump.** `^14.3.x` minimum, `^16.2.x` for full fix
   (`16.2.4` is the advisory-clean target). Requires preview-deploy
   testing. ~60 min.
6–12. Unchanged: Stripe account verification, production DNS, Resend
   domain DNS, Vapi number pool sizing, TWILIO_AUTH_TOKEN env in prod,
   BYOT Twilio number purchase, security monitoring vendor selection.

---

## Suggested next autonomous run (Round 26)

Pick 1–2:

1. **Real-network retry harness (MSW / supertest)** — still on the
   R22/R23/R24 punchlist. Proves Stripe + Vapi webhook dedup across
   sequential POST bursts with shifted + replayed signatures. Both
   twilio/sms and vapi/inbound-callback now have unit-level dedupe
   coverage; MSW would prove the behavior under a real fetch stack.
   ~45 min.
2. **`lib/calls/extract-quote.ts` capture-site audit.** The Claude
   extractor has retry logic + a JSON-parse fallback. Does each
   failure path emit a canonical tag (same pattern as engine /
   match-inbound / vapi)? Round 24 locked the downstream sites but
   the extractor itself hasn't been audited. ~30 min.
3. **Cron routes capture-site audit.** Three cron routes
   (`/api/cron/*`) call `captureException` but the tag shapes across
   them haven't been cross-checked. Lock a canonical
   `{ route: 'cron/<name>', reason }` shape. ~30 min.
4. **Next.js 14.3.x CVE bump IF pre-approved.** Intermediate hop —
   safer than 16.x and resolves 3 of the 5 advisories. ~45 min.
5. **`app/api/vapi/webhook/route.ts` full-path drift tests.** The
   outbound end-of-call webhook is the sibling of R25's two new
   test files. It already has route.test.ts coverage, but a drift
   scan would catch column-rename risks the same way. ~30 min.

---

## Summary

Round 25 closed **three** of the five items from Round 24's suggested
punchlist (a: full-path twilio/sms happy case; a: full-path vapi
inbound-callback happy case — brand-new file; c: engine.ts skip-
business capture audit) and the `/admin/**` metadata lock item (d).
Test suite grew by 32 tests, 2 files. Two real captures added (not
hygiene — they close genuine silent-strand paths). All green.

The single highest-value human unlock remains the Sentry DSN: with
R25's two new engine reasons on top of the existing tag surface,
there are now **~17** error-tracker sites waiting on one env var to
go live with per-failure-mode alerting.

— Claude, 2026-04-23 (twenty-fifth run, autonomous)
