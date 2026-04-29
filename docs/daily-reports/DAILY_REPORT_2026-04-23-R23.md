# Daily Report — 2026-04-23 (Round 23, autonomous)

**Status:** 825 passing across 75 files. `tsc --noEmit` clean. `next lint`
clean. Baseline was Round 22 at 809/74 — delta **+16 tests, +1 file**.

Nothing in production code was destructive or risky. Every change is a
test-locked observability or metadata invariant. Safe to merge.

---

## Shipped this round

### 1. `lib/calls/apply-end-of-call.ts` lib-boundary captureException audit

Mirror of the `engine.ts` pattern. Two capture sites were previously
log-only and invisible to Sentry:

- **`quotesInsertFailed`** — non-23505 insert errors on the `quotes`
  table (permission denied, schema drift, FK violations). 23505
  (unique_violation) is still explicitly NOT captured because it is
  the expected Vapi-retry path and would flood the dashboard.
- **`recomputeFailed`** — `recompute_business_success_rate` RPC
  failures. Best-effort so it still does not throw — but a persistent
  failure here degrades the business selector's ranking silently.
  Ops need a signal.

Canonical tag shapes (PII-free, strict key-set, locked by tests):

```
{ lib: 'apply-end-of-call', reason: 'quotesInsertFailed',
  callId, quoteRequestId }
{ lib: 'apply-end-of-call', reason: 'recomputeFailed',
  callId, businessId }
```

**Test file:** `lib/calls/apply-end-of-call.test.ts` — added 6 tests
(19 → 25 total). Covers:
- canonical tags on non-23505 insert error
- explicit NO-capture on 23505 unique-violation (expected retry path)
- canonical tags on recompute failure + applied=true still returns
- both-sites capture when both fail
- NO-capture on happy path
- NO-capture on counters_applied_at short-circuit (default retry path)

### 2. New file — `app/get-quotes/metadata.test.ts`

Extends the Round 22 root-layout metadata lockdown pattern to the
whole `/get-quotes` flow. +10 tests.

- **`/get-quotes`** (public landing): locks presence of title +
  description; asserts robots does NOT noindex (sitemap lists this
  URL — a silent noindex would drop it from Google).
- **`/get-quotes/checkout`**: locks
  `robots: { index: false, follow: false }`. This URL encodes a
  `quote_request_id` which is a short-lived server-side token — if
  Google indexes it, the id ends up in search results as long as the
  row exists. This is the **highest-value assertion** in the file.
- **`/get-quotes/success`**: same NOINDEX lock, same reasoning.
- **`/get-quotes/[category]` `generateMetadata()`**: three tests
  covering live-vertical title (e.g. "Moving quotes — EvenQuote"),
  waitlist-vertical description phrasing, and the unknown-category
  fallback that must NOT leak the unresolved slug into the tab/OG.

Implementation note worth remembering: the `generateMetadata()` tests
use `vi.doMock()` + `vi.resetModules()` in `beforeEach` because
Vitest's module cache otherwise serves the previously-mocked instance
and the second test sees the first test's fixture data.

### 3. Security + code-hygiene sweep (results: all clean)

Same posture as Round 22. No regressions:
- No stray `console.*` in production code paths (`app/`, `lib/`,
  `middleware.ts`) outside `logger.ts`, `resend.ts`'s PII-redacted
  simulation trace, the React error boundaries (browser-side — fine),
  and CLI scripts (explicit stdout — fine).
- All 13 `app/api/**` routes have an explicit auth gate or are
  public-by-design (`health`, `version`, `csp-report`).
- No server-only `process.env.*` reads leaked into `'use client'`
  components.
- No live secret literals in source (only `whsec_` prefix literal in
  `lib/env.ts` zod validator and in `scripts/test-e2e.ts` as a local
  dev fallback).
- `dangerouslySetInnerHTML` usage is confined to `app/layout.tsx`
  JSON-LD schema injection (Organization + WebSite) with
  `JSON.stringify` escaping — safe.

### 4. `npm audit` re-run

Same vulnerability footprint as Round 22 — **no regression, no new
CVEs**. 7 packages flagged (3 moderate, 4 high):

| Package | Severity | Fix requires |
|---|---|---|
| `next` (direct) | high | SemVer-major → 16.2.4 |
| `eslint-config-next` (direct, dev) | high | SemVer-major → 16.2.4 |
| `@next/eslint-plugin-next` (transitive) | high | via eslint-config-next |
| `glob` (transitive, dev) | high | via eslint-config-next |
| `resend` (direct) | moderate | SemVer-major |
| `svix` (transitive, via resend) | moderate | via resend |
| `uuid` (transitive, via svix) | moderate | via resend |

Every fix is a cross-major jump. Still out of scope for autonomous
runs. **This stays on the human-input list.**

---

## Items still needing your input (12 items — unchanged order)

Priority descending by value-per-minute:

1. **Sentry DSN (user-input #6) — highest-value unlock.** Every
   `captureException` call site across post-payment, resend, vapi,
   engine, stripe webhook, vapi webhook, all three cron routes, and
   now **apply-end-of-call (both sites)** has canonical tag shapes
   locked by tests. ~10 min: sign up at sentry.io, paste `SENTRY_DSN`
   into Vercel env — the next autonomous run can `npm i
   @sentry/nextjs` + uncomment the init block.
2. **Upstash Redis creds (user-input #2).** In-memory token buckets
   die with cold starts + can't cross-instance. ~5 min.
3. **Legal counsel review of privacy + terms drafts.** Still
   `robots: { index: false, follow: false }`, still not linked from
   footer. Blocks public launch. ~15 min to send to counsel.
4. **Swap placeholder OG + favicon + apple-touch-icon art.**
   Metadata SHAPE locked by `app/layout.metadata.test.ts` + the new
   `app/get-quotes/metadata.test.ts`, so real art can drop in
   without silently breaking fields.
5. **Next.js CVE bump.** `^14.3.x` at minimum, `^16.2.x` for full
   fix. See the `npm audit` block above. Requires preview-deploy
   testing. ~60 min.
6–12. Unchanged from Round 22: Stripe account verification,
   production DNS, Resend domain DNS, Vapi number pool sizing, etc.
   See Round 19 block for the full list.

---

## Suggested next autonomous run (Round 24)

Pick 1–2:

1. **Real-network retry harness for stripe + vapi webhooks** (MSW /
   supertest). Round 21 shipped in-process `Promise.all` retry-storm
   tests; a harness that serializes 10 sequential POSTs with the
   Stripe-Signature timestamp shifted would prove dedup across both
   a fresh-signature AND a replayed-signature burst. ~45 min.
2. **Metadata lockdown for `/dashboard`** (the signed-in surface).
   Owner-view pages should noindex. ~10 min.
3. **Lib-boundary capture audit sweep of the last two uncovered
   lib files**: `lib/calls/match-inbound.ts` and `lib/calls/vapi.ts`
   `startOutboundCall` — each has a handful of error paths that log
   but don't emit. ~30 min.
4. **`scripts/verify-db.ts` + `scripts/ingest-businesses.ts` SDK
   drift check** — these scripts reference columns + tables from
   Phase 1 and haven't been touched since then. A forward-compat
   check would prevent "ops runs it, it explodes, they're blocked"
   scenarios. ~20 min.
5. **Next.js CVE bump IF pre-approved** — leave a signal in
   scheduled-task notes for Round 24 to attempt. Start with
   `^14.3.x` (safer than `^16.x`). ~45 min.

---

## Summary

Round 23 closed **two** of the four items from Round 22's suggested
punchlist (item b: apply-end-of-call capture audit; item d: metadata
sub-page lockdown). The other two (a: Next.js bump, c: MSW retry
harness) stay parked — (a) is blocked on your pre-approval, (c) is
bigger than one autonomous run.

Test suite grew by 16 tests, 1 file. All green. No production-code
regressions. Security sweep identical to Round 22 — no new leaks.

**Single highest-value unlock remains the Sentry DSN.** Two more
canonical tag shapes now depend on it (`apply-end-of-call` /
`quotesInsertFailed` and `recomputeFailed`), bringing the waiting-
on-DSN sentry sites to ~12.

— Claude, 2026-04-23 (twenty-third run, autonomous)
