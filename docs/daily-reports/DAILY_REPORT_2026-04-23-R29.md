# Daily Report — 2026-04-23 — Round 29 (autonomous)

## TL;DR

957 tests passing across 80 files (R28 close: 932/80; **+25 tests, 0 new files**). `tsc --noEmit` clean. `next lint` clean. `npm audit --omit=dev` identical to R28.

Shipped three capture-site audits from the R29 punchlist. **~38 Sentry capture sites now waiting on DSN unlock** (was ~31 at R28 close). Two of the three audits closed out *real* silent failure modes that could strand paying customers with zero operator visibility.

Zero code changes that touch the customer-facing surface. Purely defensive wiring + tests.

---

## Shipped

### 1. `lib/email/resend.ts` — reason-granularity split (+3 tests)

Pre-R29 all three Resend failure paths (provider error, malformed response, transport throw) captured with the single tag `reason:'sendFailed'`. Sentry's facet search couldn't distinguish "Resend is down" (transport) from "our from address is unverified" (provider error) — they merged into one issue and alert rules couldn't route them differently.

Split into three distinct reasons:

- `sendApiErrored` — provider returned `{ error }` object (validation, rate limit, bounce, domain-not-verified)
- `sendResponseMissingId` — provider success with no `id` (shape drift)
- `sendTransportFailed` — raw throw: DNS, TLS, socket reset, timeout

Wrapper messages (`'Resend sendApiErrored: ...'`, `'Resend sendResponseMissingId'`) now have controlled prefixes so provider string rewording doesn't spawn new Sentry issues per deploy. New type `ResendReason` exported.

**Tests:** `lib/email/resend.test.ts` 16 → 19.
- Updated three existing capture tests to match new reasons.
- **+3 regression guards:** (a) forbids catch-all reason drift across all three paths, (b) tag-schema-lock with EXACT key-set for `{lib, reason}` and `{lib, reason, emailTag}`, (c) reason allow-list with distinct-value assertion (no two paths collide).

### 2. `lib/actions/intake.ts` + `lib/actions/cleaning-intake.ts` — capture audit (+14 tests)

Two parallel zod-validate-insert server actions. Pre-R29, both DB error paths were log-only:

- `categoryLookupFailed` — `service_categories` select errored (permission denied, RLS regression)
- `insertFailed` — `quote_requests` insert errored (check constraint, schema drift, RLS misconfiguration)

A permission-denied on either would silently return generic "Could not save" or "Category unavailable" to every intake submitter. Full intake outage invisible until the first angry email.

Now both capture with canonical `{lib:'intake', reason, vertical:'moving'|'cleaning'}` tags. `vertical` is load-bearing — a merged reason would mask a single-vertical failure (e.g. a category_id rename that only hit cleaning).

**Deliberately NOT captured** (documented in code):
- "Category missing but no DB error" (`{data:null, error:null}`) — config state, not incident. Capturing would flood Sentry on intentional category pauses.
- Zod validation failures — user error, not server error.

**Tests:** `intake.test.ts` 7 → 14; `cleaning-intake.test.ts` 6 → 13.
Per-site capture test + happy-path no-capture + zod-no-capture + missing-row no-capture (config-state guard) + PII negative guard (email/phone/name/address/user_id) + reason allow-list + catch-all forbidden list.

### 3. `app/get-quotes/claim/route.ts` — magic-link landing audit (+8 tests)

This is the "make or break" UX moment: customer paid, clicked the magic link, and this route decides whether they ever see their quotes. Pre-R29 both DB error paths were log-only — a brief Supabase blip would strand the customer on an error page with no operator visibility.

Two new capture sites with canonical `{route:'get-quotes/claim', reason, requestId}` tags:

- `requestLoadFailed` — `quote_requests` select errored
- `quoteBackfillFailed` — `quote_requests` update errored post-auth (the trust-destroying path — they paid, auth matched, and we still couldn't link)

**Deliberately NOT captured** (documented):
- Missing-row with `error===null` — user-facing URL error (wrong id, tampered, expired magic link). Capturing would flood on share-link misuse.
- Email mismatch — false-positive heavy: users with two emails forget which they used. Already logged via `log.warn`.
- Payments backfill fail — non-fatal by design (quote_requests is source of truth; `payments.claimed_at` is cosmetic). A concurrent magic-link reclick races here and capturing would flood.

**PII contract:** `requestId` is a UUID already exposed in the URL — safe to tag. `userId` and `email` are NEVER tagged; user-level correlation belongs on Sentry's user scope, not tag facets.

**Tests:** `claim/route.test.ts` 11 → 19.
Per-site capture + no-capture guards for each deliberately-silent path (missing row, email mismatch, payments race, idempotent re-click, zod fail) + PII negative guard + reason allow-list.

---

## Verification

```
vitest run           → 957 passed (80 files)      [R28: 932/80, delta +25]
tsc --noEmit         → clean
next lint            → no warnings or errors
npm audit --omit=dev → 4 vulns (3 mod, 1 high)    [IDENTICAL to R28]
```

Supply-chain state unchanged: next, uuid (via svix→resend chain), svix, resend. All cross-major. Still blocked on your pre-approval.

---

## Tag-shape catalog (end of R29)

All canonical lib-level and route-level Sentry tag shapes now locked:

**Lib-level:**
- `{lib:'vapi', reason:'startCall*'}`
- `{lib:'match-inbound', reason:'businessesLookupFailed'|'callsLookupFailed'}`
- `{lib:'apply-end-of-call', reason:'quotesInsertFailed'|'recomputeFailed'}`
- `{lib:'enqueue', reason:'claimFailed'|'insertFailed'|'plannedCountUpdateFailed'|'callIdPersistFailed'|'noBusinessesFallbackFailed'}`
- `{lib:'extract-quote', reason:'extractHttpFailed'|'extractMissingToolUse'|'extractSchemaCoercionFailed'|'extractTransportFailed'}`
- `{lib:'cron-send-reports', reason:'sendFailed'|'finalStampFailed'|'refundLookupFailed'|'refundCreateFailed'|'refundStatusUpdateFailed'}`
- `{lib:'cron-retry-failed-calls', reason:'candidateQueryFailed'|'applyCallEndFailed'}`
- `{lib:'post-payment', reason:'signInWithOtp'}`
- `{lib:'checkout', reason:'stripeSessionCreateFailed'|'stripeReturnedEmptyUrl'}`
- **NEW R29:** `{lib:'resend', reason:'sendApiErrored'|'sendResponseMissingId'|'sendTransportFailed', emailTag?}`
- **NEW R29:** `{lib:'intake', reason:'categoryLookupFailed'|'insertFailed', vertical:'moving'|'cleaning'}`

**Route-level:**
- `{route:'cron/send-reports', reason:'runFailed'}`
- `{route:'cron/retry-failed-calls', reason:'runFailed'}`
- `{route:'cron/check-status', reason:'integrationProbeFailed', stripe, vapi}`
- `{route:'vapi/webhook', vapiCallId}`
- `{route:'vapi/inbound-callback', vapiCallId}`
- `{route:'twilio/sms'}`
- `{route:'stripe/webhook', eventType, eventId}` / `{route:'stripe/webhook', site:'magic-link'|'enqueue-calls', requestId}`
- **NEW R29:** `{route:'get-quotes/claim', reason:'requestLoadFailed'|'quoteBackfillFailed', requestId}`

---

## Action items for Antonio (unchanged from R28 except the Sentry ROI)

The outstanding human-input list is **12 items, unchanged from R28**. The priority order has shifted slightly — now ~38 capture sites waiting on Sentry DSN means the observability ROI of unlocking it is even higher.

### Highest-value unlocks (my recommendation)

1. **Sentry DSN** (user-input #6) — now blocks visibility into ~38 capture sites across vapi, match-inbound, apply-end-of-call, enqueue, extract-quote, cron jobs, post-payment, checkout, resend, intake, and the claim route. Setting `SENTRY_DSN` in Vercel env turns every one of these on at once. **This is the single biggest lever you have.**

2. **Next.js CVE bump** (user-input #?) — 14.2.35 → 14.3.x. Still shows 1 high severity CVE. I can execute this in ~45 min if you pre-approve; needs acceptance of any Next.js 14.3.x breaking changes (minor, but real). Waiting for your go/no-go.

3. **Legal pages** — still drafted but not linked into production. Per your past guidance I won't auto-link unreviewed legal content. Review + link is a <30 min job on your end.

### Suggested next autonomous run (Round 30)

- (a) Real-network retry harness (MSW/supertest) for stripe + vapi webhook retry storm. On punchlist since R22. ~45 min.
- (b) `lib/actions/post-payment.ts` capture-site deep audit — `{lib:'post-payment', reason:'signInWithOtp'}` exists but was only spot-checked at R27. Cross-check for silent paths the same way R29 did intake.ts. ~30 min.
- (c) `app/auth/callback/route.ts` capture audit — paired with the claim route but not yet audited. If this route fails silently, the magic-link flow breaks before the customer reaches `/get-quotes/claim`. ~30 min.
- (d) `lib/supabase/admin.ts` error-boundary review — the admin client's thin wrapper doesn't catch init failures; a rotated service-role key would surface as per-query errors instead of one loud startup failure. ~30 min.
- (e) `app/api/stripe/webhook/route.ts` retry-idempotency drift-detection — the R27 drift suite covered columns; add a second suite for idempotency-key reuse under retry storm (currently only unit-tested). ~30 min.

---

## What did NOT ship in R29 (and why)

- **Next.js CVE bump** — waiting on your pre-approval. I marked this explicitly at R22, R23, R24, R25, R26, R27, R28. Same posture here.
- **Legal page auto-link** — your standing rule is no auto-linking of unreviewed legal content. Rule held.
- **`lib/email/templates.ts` content review** — not part of the R29 scope. Templates are static HTML and haven't changed since the R18 content pass.

---

## No customer-surface changes

All changes are observability wiring + tests. No route returns a different status. No user sees a different error message. Safe to deploy continuously — every new capture path is gated by `SENTRY_DSN` being set, which still isn't.
