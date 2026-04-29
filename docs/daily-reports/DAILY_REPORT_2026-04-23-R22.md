# EvenQuote daily report — 2026-04-23 (Round 22)

**Run type:** scheduled autonomous run (Antonio away).
**Scope given:** "Refine code for EvenQuote to make it production-ready.
Examine what improvements and fixes and tests need to be run
independently by you while I'm away. Create tasks for each of them and
process them. Make this a secure, marketable product."

## TL;DR

Baseline at session start: **795 tests across 73 files.**
Close of Round 22: **809 tests across 74 files.** Delta: **+14 tests,
+1 file.** `npx tsc --noEmit` clean, `npx next lint` clean.

Shipped the four code-side items from Round 21's "suggested next
session" list, plus a targeted security/marketability sweep. No human
input was required to land any of them. One new high-priority item
surfaced that **does** need you — detailed at the bottom.

## What shipped

### 1. Lib-boundary captureException audit — `lib/queue/enqueue-calls`

`enqueueQuoteCalls` is a pass-through facade over `runCallBatch`.
Engine already fires `captureException` with `{ lib: 'enqueue',
reason: 'claimFailed' | 'insertFailed', quoteRequestId }` at its own
boundary (locked by `lib/calls/engine.test.ts`). The facade must stay
silent so a single logical error fires **exactly one** lib-tagged
capture event — double-capture would re-fingerprint the same error
under two lib tags and inflate alert volume when Sentry goes live.

Round 22 adds three new lock tests:

- happy path → no capture
- engine returns `ok:false` (soft failure) → no capture
- engine throws → exception propagates, facade does NOT re-capture

Mirrors the `lib/actions/post-payment.test.ts` audit pattern from
Round 19. File total now 10/10 (was 7).

### 2. Lib-boundary captureException audit — `lib/actions/post-payment`

Round 19 already covered the core audit (canonical tags, PII
negative-assertion, happy-path no-capture). Round 22 fills three gaps
a future refactor could regress through:

- Empty email input throws → no capture (was: untested — defensive
  try/catch here would flood Sentry with every malformed webhook
  payload)
- Empty requestId input throws → no capture (same reasoning)
- Tag object key-set strictly `['lib', 'reason', 'requestId']` — no
  extra facets like `email` / `userId` / free-text `details` that
  could leak PII

File total now 13/13 (was 10).

### 3. Root layout Open Graph / Twitter / robots metadata lock

New file: `app/layout.metadata.test.ts` (8 tests). Locks the shape
of the root-page metadata so a future edit — intentional or not —
can't silently drop an OG field and degrade every shared link to a
no-image preview. Explicitly verifies:

- `metadataBase` resolves to an absolute URL (needed for relative
  OG paths to become crawler-resolvable)
- Title is the `{default, template}` shape (so sub-pages compose
  the `" | EvenQuote"` suffix)
- Canonical alternate = `/` (UTM variants don't split link equity)
- OG block: `type`, `url`, `title`, `description`, `siteName`,
  `locale` — each a separate test failure mode
- Twitter: `card: 'summary_large_image'` with title + description
- Robots: indexable at the root (complement to
  `app/legal/metadata.test.ts` which locks the INVERSE on draft
  legal pages)
- `formatDetection` disables auto-linkification of emails /
  addresses / phones

Implementation note: next/font and geist do dynamic module
resolution that Vitest/Vite can't follow (Node ESM rejects geist's
directory import of `next/font/local`). Mocked the font loaders +
`next/headers` at the top of the test; only the `metadata` export
is exercised, so no runtime concern. This same mock pattern is
available for future root-layout tests.

### 4. CSP_PLAN.md — end-to-end analyze workflow

Documented the Round 21 analyze-script rollout as a six-step
runbook (A–F):

- **A.** Apply `supabase/migrations/0009_csp_violations.sql` via
  `supabase db push` or SQL editor.
- **B.** Flip `CSP_VIOLATIONS_PERSIST=true` in Vercel prod for ~2
  weeks.
- **C.** Run `npx tsx scripts/analyze-csp-reports.ts --days=14` —
  sample output included in the doc so you know what "ready to
  flip" looks like.
- **D.** Populate `next.config.mjs` → `minimalCsp` allow-lists.
  Every host in the policy should trace back to an aggregator row.
- **E.** Flip `CSP_ENFORCE=true`. 24h watch on `/api/csp-report`.
- **F.** Flip `CSP_VIOLATIONS_PERSIST=false` to close the window
  once Enforce has been stable for a week.

Also updated the doc's "Status" header to reflect Round 21's
landing of the persistence gate + aggregator + migration.

### 5. `scripts/seed-csp-sample.ts` — local dry-run helper

New script that inserts ~50 realistic mocked CSP violations into
`csp_violations` so the analyze script's output format is visible
in ~30 seconds on local Supabase, before the real prod collection
window opens. Safety rails:

- Hard refusal if `NEXT_PUBLIC_SUPABASE_URL` looks like a hosted
  Supabase project (contains `.supabase.co` and no `localhost` /
  `127.0.0.1`). Override with `ALLOW_PROD_SEED=true` only if you
  absolutely mean to.
- Prints the row IDs it inserted so you can clean up with one SQL
  statement afterward.
- Sample set covers legitimate violations (Stripe js, Google
  Fonts, Unsplash images), browser noise (chrome-extension://),
  expected inline JSON-LD violations, and one synthetic XSS probe
  so the aggregator's "this is the kind of thing you WANT to keep
  blocked" case has a representative row.

### 6. Security / marketability sweep

Methodology: grep for common issue patterns across `app/` and
`lib/`, read suspicious hits, flag what's wrong. Findings:

- **Public API routes audit.** Every handler under `app/api/` has
  either: CRON_SECRET auth (`assertCronAuth`), webhook signature
  verification (Stripe `verifyStripeWebhook` / Vapi
  `verifyVapiWebhook`), NODE_ENV + token gate
  (`assertDevToken`), or is a no-secret public-by-design probe
  (`/health`, `/status`, `/version`, `/api/csp-report`). No
  unauthenticated write endpoints.
- **Rate limits on server actions.** `lib/actions/*` — intake
  (moving + cleaning), checkout, waitlist, release-contact, auth
  — all call `rateLimit` / `assertRateLimit` /
  `assertRateLimitFromHeaders`. No unbounded user-input paths.
- **No stray `console.log`.** The only non-test `console.*` hits
  are in `lib/logger.ts` (the logger itself) and
  `lib/email/resend.ts` (simulation-mode trace — already
  PII-redacted via `redactPII`).
- **No dangling secrets.** No `sk_live_` / `pk_live_` / `whsec_`
  literals in source. Only env-var references.
- **TODO / FIXME.** Only three in app code, all expected:
  - `app/legal/privacy/page.tsx` — "replace with publish date"
    (blocked on counsel review, tracked)
  - `app/legal/terms/page.tsx` — "pick jurisdiction" + publish
    date (same)
  - `lib/calls/vapi.ts` — phone-number formatting comment (not
    a TODO, a format example `"(XXX) XXX-XXXX"`)
- **Security headers.** `next.config.mjs` ships `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, `Strict-Transport-Security`, and the
  minimal static CSP.
- **`force-dynamic` everywhere.** Every `app/api/**/route.ts`
  either exports `const dynamic = 'force-dynamic'` or
  `revalidate`. No accidentally-cached handlers.
- **robots.ts + sitemap.ts** present at `app/robots.ts` and
  `app/sitemap.ts`.
- **Favicons + OG.** `public/favicon.ico`, `public/icon.png`,
  `public/apple-touch-icon.png`, `public/og-image.png` all
  present — placeholders, pending real art (already tracked in
  the 11-item outstanding list).

## Verification

- `npx vitest run` — **809/809 across 74 files**, ~28s
- `npx tsc --noEmit` — clean
- `npx next lint` — clean
- Delta vs. Round 21 close: **+14 tests, +1 file**
  - enqueue-calls.test.ts: +3 tests (7 → 10)
  - post-payment.test.ts: +3 tests (10 → 13)
  - app/layout.metadata.test.ts: new file, +8 tests

## New item that DOES need you — high priority

**`npm audit` flags multiple high/moderate vulns in Next.js 14.2.35.**

We're already on the latest 14.2.x (14.2.35 is the line's final
published version — there is no `14.2.36`). The advisories list:

- HTTP request smuggling in rewrites (high)
- Image Optimizer remotePatterns DoS (high)
- HTTP request deserialization DoS on insecure RSC (high)
- Unbounded `next/image` disk-cache growth (moderate)
- Server Components DoS (moderate)

`npm audit fix` without `--force` is a no-op because the fix
requires jumping to a newer **minor** (Next 14.3.x) or **major**
(Next 15.x) version. That's out of scope for an autonomous run —
Next minor upgrades touch the build pipeline, App Router internals,
and middleware behavior in ways that warrant preview-deploy
testing before merging.

**Action for you:** schedule ~60 min to bump Next to `^14.3` (or
`^15.0`) and run a preview. The framework's escape valves we rely
on (middleware, rewrites, server actions, `force-dynamic`) are
stable across both targets. Start with `^14.3` — it's the lower-
risk bump.

**Why it matters now:** the HTTP smuggling CVE is exploitable in
any Next.js deployment that accepts Stripe webhooks — an attacker
who smuggles a request past the edge could bypass our signature
check. We currently mitigate via the Stripe-Signature constant-time
verify in `lib/security/stripe-auth.ts`, which is belt-and-braces,
but the framework-level bypass window is exactly the kind of thing
that makes a security review flag us.

## Items still needing your input (unchanged from Round 21)

Same 11 items, same order — descending value-per-minute. The top
three are identical to last round's "pick from the top" list:

1. **Sentry DSN (user-input #6) — highest-value unlock.** Every
   captureException call site — post-payment, resend, vapi,
   engine, stripe webhook, vapi webhook, all three cron routes —
   now has canonical tag shapes locked by tests. Tags are load-
   bearing; the moment the DSN lands, they become real dashboards.
   ~10 min. sign up at sentry.io, paste `SENTRY_DSN` into Vercel
   env, I'll `npm i @sentry/nextjs` + uncomment the init block
   on the next run.
2. **Upstash Redis creds (user-input #2).** `UPSTASH_REDIS_REST_URL`
   + `UPSTASH_REDIS_REST_TOKEN`. In-memory token buckets don't
   survive Vercel cold starts or scale past one instance. ~5 min.
3. **Legal counsel review of privacy + terms drafts.** Still
   `robots: { index: false, follow: false }`, still not linked
   from the footer. Blocks public launch. Metadata.test.ts
   prevents stray edits from going live pre-review. ~15 min to
   send to counsel.
4. **Swap placeholder OG + favicon + apple-touch-icon art.** The
   new `app/layout.metadata.test.ts` locks the metadata SHAPE, so
   swapping in real files will not silently drop any field. ~10
   min once you have art.
5. **Next.js CVE bump** (new this round — see above). ~60 min.
6-11. Unchanged: Stripe account verification, production DNS,
   Resend domain DNS, Vapi number pool sizing, etc. See Round
   19's block for the full list.

## Unlocked by this round (no user input needed)

- `scripts/seed-csp-sample.ts` — you can now dry-run the CSP
  analyze script locally:
  ```
  npx tsx scripts/seed-csp-sample.ts
  npx tsx scripts/analyze-csp-reports.ts --days=30
  ```
  Use this to verify the aggregator's output format before
  opening the prod collection window (step B in CSP_PLAN.md).

## Suggested next autonomous run

1. **Next.js CVE bump to 14.3.x.** (If and only if you've
   pre-approved it — I'll wait for that signal.) Bump, run
   `npm audit`, run `npm test`, run a production build, flag any
   regressions. ~45 min.
2. **`lib/calls/apply-end-of-call.ts` capture audit.** This is the
   remaining lib-boundary site that hasn't had its Sentry tag
   shape locked — `quotes insert failed` and
   `recompute_business_success_rate failed` both log today but
   don't reach the tracker. Mirror the `lib/calls/engine.test.ts`
   pattern. ~20 min.
3. **Integration test: stripe webhook + vapi webhook under real
   network retry conditions.** Round 21 shipped in-process
   `Promise.all` retry-storm tests. A MSW / supertest harness
   that serializes 10 sequential POSTs with the
   `Stripe-Signature` timestamp value shifted would prove dedup
   survives both a fresh-signature and a replayed-signature
   burst. ~45 min.
4. **Metadata lockdown for sub-pages.** `app/layout.metadata.test.ts`
   covers the root. `/pricing`, `/how-it-works`, `/get-quotes`
   pages compose titles via the template — one shared helper
   test + per-page assertion would prevent silent drift. ~15 min.

## Summary

Round 22 closed four of five items from Round 21's "suggested
next session" list (the fifth — a real-network retry harness —
remains). Test suite grew by 14 tests, 1 file. All green.
Security sweep turned up one genuinely-new high-priority item
(Next.js CVE bump) that needs you; nothing else is blocked.

Sentry DSN is still the single highest-value unlock — every
captureException tag shape locked this quarter becomes a real
dashboard the moment that one env var lands.

— Claude, 2026-04-23 (twenty-second run, autonomous)
