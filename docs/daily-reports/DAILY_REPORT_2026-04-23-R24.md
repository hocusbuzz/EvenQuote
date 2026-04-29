# Daily Report — 2026-04-23 (Round 24, autonomous)

**Status:** 858 passing across 78 files. `tsc --noEmit` clean. `next
lint` clean. Baseline was Round 23 at 831/76 — delta **+27 tests, +2
files**.

No production-code regressions. Every new test is a security- or
observability-invariant lock. One real bug fix (schema-drift in
`scripts/verify-db.ts` that would have failed on any post-seed-0002
DB). Safe to merge.

---

## Shipped this round

### 1. `lib/calls/vapi.ts` — per-failure-mode Sentry reason tags

Round 20 captured all three `startOutboundCall` failure paths with
`reason: 'startCall'` (a single catch-all). That works, but Sentry
dashboards can't fire per-mode alerts without regex-parsing the error
message. Round 24 splits it into three discrete reasons:

```
{ lib: 'vapi', reason: 'startCallHttpFailed',      httpStatus, businessId? }
{ lib: 'vapi', reason: 'startCallMissingId',       businessId? }
{ lib: 'vapi', reason: 'startCallTransportFailed', businessId? }
```

Why it matters once Sentry DSN is wired:
- `startCallHttpFailed` + `httpStatus >= 500` → Vapi outage (page)
- `startCallHttpFailed` + `httpStatus 4xx` → our config/auth (investigate)
- `startCallMissingId` → API contract violation (page on first)
- `startCallTransportFailed` → our network/DNS/TLS (infra bucket)

**Tests:** `lib/calls/vapi.test.ts` — updated 3 existing tests + added
a regression-guard test that asserts none of the three modes emits the
old catch-all `'startCall'` reason. +1 test (22 → 23 total).

### 2. NEW FILE — `lib/calls/match-inbound.test.ts`

`lib/calls/match-inbound.ts` is untracked / brand-new and had **zero
tests** going into this round. It's the phone→quote_request resolver
used by BOTH the Vapi inbound-callback webhook AND the Twilio inbound
SMS webhook. A bug here silently drops real contractor responses —
customer sees "we couldn't reach anyone" on a request we actually
connected to. Worst failure mode in the entire pipeline.

+17 tests covering:
- **Phone normalization** (4): E.164 → 10-digit, leading-1 strip,
  empty/null/undefined, non-11-digit passthrough
- **Matching logic** (7): empty input short-circuits DB, no match,
  format-agnostic match (+14155551234 vs (415) 555-1234), multi-business
  phone chains pick most-recent call, no recent call returns null,
  extraction schema hydration, null-join fallback, ghost business_id
  defensive fallback
- **Lib-boundary capture sites** (4): `businessesLookupFailed` strict
  key-set `{lib, reason}`, `callsLookupFailed` with businessId, PII
  guard (caller phone never in tags), serialized-tag inspection
- **No-capture guards** (2): happy path, null-match path (the
  documented "store as orphan" outcome must NOT page Sentry — otherwise
  every wrong-number caller floods the dashboard)

Canonical tag shapes now locked:
```
{ lib: 'match-inbound', reason: 'businessesLookupFailed' }
{ lib: 'match-inbound', reason: 'callsLookupFailed', businessId }
```

### 3. NEW FILE — `app/api/twilio/sms/route.test.ts` (security focus)

`app/api/twilio/sms/route.ts` is the new inbound-SMS webhook — untracked,
untrusted write surface, 270 lines, **zero tests** before this round.
The signature-verification gate is the ONLY thing stopping someone
from POSTing fake contractor quotes into real customer requests. That
warranted focused perimeter coverage before we point a real Twilio
number at it.

+9 tests covering:
1. Prod + no `TWILIO_AUTH_TOKEN` → 500 "misconfigured" (NEVER processes)
2. Dev + no token → soft-accept (local testing path)
3. Prod + invalid signature → 401 (before reaching `match-inbound`)
4. Prod + missing signature → 401
5. Prod + valid signature → 200 + TwiML
6. `X-Forwarded-Proto`/`X-Forwarded-Host` reconstruction (required for
   Vercel/cloudflared-fronted deploys where the inner URL differs from
   the URL Twilio signed against)
7. Missing `From` / missing `Body` → 400 after signature passes
8. Length-mismatched signature does NOT crash (the
   `providedSig.length === expected.length` guard is load-bearing —
   `crypto.timingSafeEqual` throws on length mismatch)

All assertions verify the gate fires BEFORE `match-inbound` or
`extract-quote` is called. A broken gate would let unauthenticated
writes land in `quotes` — catching that regression is the whole point.

### 4. `scripts/verify-db.ts` — schema drift fix

**This was a real bug, not just hygiene.** The Round 23 suggested
"SDK-drift check" found one actual break:

```
Check: service_categories row count
Expected: exactly 1
After seed 0002: 4 (moving + cleaning + handyman + lawn-care)
Result: script exits 1 on any DB that has run both seeds.
```

Any ops run on a fully-seeded DB would have failed this check.

Fixed:
- `service_categories` count check: `=== 1` → `>= 1` (accepts both
  Phase 1 and multi-vertical seed states)
- `businesses` count check: `=== 20` → `>= 20` (forward-compatible
  with `ingest-businesses.ts` output that adds real Google Places rows
  on top of the seed)
- **New check added:** every `service_categories` row has non-null
  `extraction_schema` AND `places_query_template`. Migration 0005
  added these columns; seed 0002 backfills them. A category missing
  either is either a seed bug or a DB that didn't run seed 0002. Ops
  sees a pointed error instead of mysterious extractor behavior later.
- "All 555-range phones" check now emits a more helpful error message
  after ingest has run (expected-but-warn state: "real phones ingested
  — remove TEST_OVERRIDE_PHONE before any dial").

`scripts/ingest-businesses.ts`: audited, **clean**. Column references
(`service_categories.id/name/slug`, delegation to `upsertBusinesses`)
all line up with current schema + existing unit tests on the lib
layer.

### 5. Security re-sweep (results: all clean + one new surface covered)

- `console.*` confined to the same approved list as Round 23 (logger +
  logger.test + PII-redacted resend trace + React error boundaries +
  tests + CLI scripts). No new leaks.
- All `app/api/**` routes auth-gated or public-by-design — including
  the NEW `twilio/sms` route (Twilio signature HMAC-SHA1 + timing-safe
  compare + prod hard-refuse) and NEW `vapi/inbound-callback` route
  (shares `VAPI_WEBHOOK_SECRET` with the outbound webhook).
- No live secret literals. Only hits are test fixtures in
  `lib/env.test.ts` (`'sk_live_xxx'`, `'sk_live'`) and audit documentation.
- No server-only `process.env.*` leaked into `'use client'` components.
- `dangerouslySetInnerHTML` still confined to JSON-LD injection in
  `app/layout.tsx` with `JSON.stringify` escaping.

### 6. `npm audit` re-run

Production-only audit: **4 vulnerabilities (3 moderate, 1 high)** —
next, uuid, svix, resend. All require cross-major SemVer bumps. Still
blocked on your pre-approval. Full audit (including dev) matches
Round 23's 7-package footprint.

---

## Items still needing your input (12 items — unchanged order)

Priority descending by value-per-minute:

1. **Sentry DSN (user-input #6) — highest-value unlock.** Every
   `captureException` call site across post-payment, resend, vapi,
   engine, stripe webhook, vapi webhook, all three cron routes,
   apply-end-of-call, **match-inbound (both sites)**, and **vapi.ts
   (now three discrete modes)** has canonical tag shapes locked by
   tests. Waiting-on-DSN capture sites now total **~15**. ~10 min:
   sign up at sentry.io, paste `SENTRY_DSN` into Vercel env.
2. **Upstash Redis creds (user-input #2).** In-memory token buckets
   die with cold starts + can't cross-instance. ~5 min.
3. **Legal counsel review of privacy + terms drafts.** Still noindexed
   + unlinked from the footer. Blocks public launch. ~15 min.
4. **Swap placeholder OG + favicon + apple-touch-icon art.** Metadata
   SHAPE locked by three test files (root + `/get-quotes` flow + legal).
5. **Next.js CVE bump.** `^14.3.x` minimum, `^16.2.x` for full fix.
   Requires preview-deploy testing. ~60 min.
6–12. Unchanged: Stripe account verification, production DNS, Resend
   domain DNS, Vapi number pool sizing, TWILIO_AUTH_TOKEN env in prod,
   BYOT Twilio number purchase, security monitoring vendor selection.

---

## Suggested next autonomous run (Round 25)

Pick 1–2:

1. **Happy-path + end-to-end tests for `twilio/sms` and
   `vapi/inbound-callback`**. Round 24 covered the signature gate on
   twilio/sms and the match resolver independently — but no test
   exercises the full insert-calls + insert-quotes + bump-counter
   path inside either route. Would catch drift on the `calls` row
   shape or `increment_quotes_collected` RPC rename. ~45 min.
2. **Real-network retry harness (MSW / supertest)** — still on the
   Round 22/23 punchlist. Proves Stripe + Vapi webhook dedup across
   sequential POST bursts with shifted + replayed signatures. ~45
   min.
3. **`lib/calls/engine.ts` retry path audit.** The batch dispatcher
   has a "skip business, continue batch" pattern for per-call
   failures. Does each skip emit to the tracker with a canonical
   tag? Round 20 didn't look; Round 24 touched vapi.ts but not the
   engine layer wrapping it. ~30 min.
4. **Next.js CVE bump IF pre-approved.** `^14.3.x` first (safer).
   ~45 min.
5. **Admin surface metadata lockdown** (`/admin/**` — four new pages
   landed this round in untracked state). Every admin surface should
   noindex + no-follow. Mirror the Round 23 pattern from
   `/dashboard`. ~15 min.

---

## Summary

Round 24 closed **three** of the five items from Round 23's suggested
punchlist (b: lib capture audits for vapi + match-inbound; e:
verify-db.ts SDK-drift check) and added one security-gap coverage item
that wasn't on the list (twilio/sms signature tests — a brand-new
untracked route with zero tests).

Test suite grew by 27 tests, 2 files. One real bug fix shipped
(`scripts/verify-db.ts` schema drift). All green.

The single highest-value human unlock remains the Sentry DSN: with
Round 24's `startCallHttpFailed` / `startCallMissingId` /
`startCallTransportFailed` split on top of the existing match-inbound
and apply-end-of-call capture shapes, there are now ~15 error-tracker
sites waiting on one env var to go live with per-failure-mode alerting.

— Claude, 2026-04-23 (twenty-fourth run, autonomous)
