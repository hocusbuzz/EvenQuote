# Preview-deploy webhook smoke test

Runbook for `scripts/smoke-webhook-preview.ts` (added R34, 2026-04-24).

## Why this exists

The R33 feasibility report (`docs/RETRY_HARNESS_FEASIBILITY_R33.md`)
evaluated MSW + supertest for local real-HTTP retry-storm coverage.
Conclusion: the bug class we actually care about (signature HMAC on
raw bytes, middleware ordering, chunked-encoding parity) only
manifests on the real Vercel deployment target. A local harness
doesn't reproduce it. The correct investment is **preview-target
smoke coverage**, not local stubs.

This script is that smoke test. Zero new dependencies — uses the
Stripe SDK (already a production dep) plus Node's built-in `crypto`
for Vapi + Twilio signing.

## When to run

Before promoting any preview deploy that touches:

- `app/api/stripe/webhook/route.ts` or anything it imports.
- `app/api/vapi/webhook/route.ts` or anything it imports.
- `app/api/twilio/sms/route.ts` or anything it imports.
- `middleware.ts` (CSP, maintenance gate, updateSession).
- `lib/security/stripe-auth.ts` / `vapi-auth.ts` / any signature
  verification helper.
- Anything that could affect request-body reading (raw-body
  middleware, edge-vs-node runtime swap, etc.).

If the PR doesn't touch those surfaces, the in-process tests
(`route.test.ts` drift suites, R30 stateful-stub, R31/R32 drift-
capturing stubs) cover it; the smoke step is optional.

## Prerequisites

1. A Vercel preview deployment URL for the PR under review. Grab
   it from the PR check (look for the "Preview" URL in the Vercel
   comment on the PR).
2. The **three webhook secrets** configured in that preview's Vercel
   env. If you rotated a secret recently, confirm the preview deploy
   inherited the new value — smoke tests will fail cleanly if the
   preview's secret doesn't match what you export locally.
3. A preview Supabase (NOT prod). The script WILL insert a row in
   `payments` during the Stripe leg. Use a preview-project env or a
   throwaway database.

## Running the script

```bash
PREVIEW_URL='https://evenquote-preview-xxxxx.vercel.app' \
STRIPE_WEBHOOK_SECRET=whsec_...                          \
VAPI_WEBHOOK_SECRET=shhh...                              \
TWILIO_AUTH_TOKEN=auth_...                               \
  npm run smoke:webhook-preview
```

Or with only one leg:

```bash
# Verify just the Stripe leg (e.g. after a stripe-webhook change):
PREVIEW_URL='...' STRIPE_WEBHOOK_SECRET=whsec_... \
  npm run smoke:webhook-preview -- --only=stripe
```

Dry-run first to catch env typos without hitting the preview:

```bash
PREVIEW_URL='...' STRIPE_WEBHOOK_SECRET=whsec_... VAPI_WEBHOOK_SECRET=... TWILIO_AUTH_TOKEN=... \
  npm run smoke:webhook-preview -- --dry-run
```

## Flags

| Flag              | Default | Effect                                         |
|-------------------|---------|------------------------------------------------|
| `--only=<leg>`    | all     | Run just `stripe`, `vapi`, or `twilio`.        |
| `--retries=N`     | 20      | Retry-storm size (twilio caps at 3).           |
| `--timeout-ms=N`  | 15000   | Per-request timeout in ms.                     |
| `--dry-run`       | false   | Print what would be sent; no network calls.    |

## What it asserts

Per leg:

1. The first signed POST returns 2xx.
2. N retries with the same idempotency key return 200 (no 5xx
   surface).
3. The duplicate-event response body, where the route surfaces one
   (Stripe: "Duplicate event — already processed"), is reported in
   the summary.

Exit codes:

- `0` — all legs passed.
- `1` — at least one assertion failed.
- `2` — missing env / bad flags.

## What it does NOT assert

- **DB row state.** Preview DB rows may be shared with other smoke
  runs; asserting counts here would be flaky. The in-process
  idempotency tests (`app/api/stripe/webhook/route.test.ts` R30
  stateful-stub block, `app/api/vapi/webhook/route.test.ts` R31
  drift-capturing stub, `app/api/twilio/sms/route.test.ts` R32
  drift suite) already lock DB-side invariants against mocked
  Supabase. This script is the wire/transport-level sibling of
  that, not a replacement.
- **Side-effect fan-out.** Email sends, Vapi dialler kicks, and
  the rest of the pipeline aren't verified here. They run against
  real integrations in the e2e walker (`scripts/test-e2e.ts`).

## Common failures and what they mean

**401 / 403 on the first Stripe POST.**
Your `STRIPE_WEBHOOK_SECRET` doesn't match what the preview deploy
expects. Check the Vercel preview env for that PR, rotate if needed.

**5xx during retry storm.**
A regression in the route's idempotency layer. Look at Vercel logs
for the preview — the route's own `captureException` will have
fired (~43 lib-level + ~12 app-level capture sites) once the Sentry
DSN is unlocked. For now, `console.error` in the Vercel function
logs is the signal.

**Timeout / network error.**
Preview deploy is cold-starting or regional. Retry; bump
`--timeout-ms=30000` if the preview runs in a far region.

**Stripe SDK throws "api version mismatch".**
The apiVersion pin in `scripts/smoke-webhook-preview.ts` drifted
from `lib/stripe/server.ts`. Update both to the same string.

## What to do on failure

Do NOT promote the preview to production. The idempotency contract
is what prevents "customer paid twice" and "send-report email fires
twice" failure modes — any regression here is a customer-facing
trust hazard.

Rollback steps:

1. Revert the PR, re-open preview.
2. Bisect if the PR is large.
3. Re-run the smoke test on every candidate revert until it passes.

## Related tests (the in-process siblings)

- `app/api/stripe/webhook/route.test.ts` — stripe drift suite
  (R27/R30) + 20-retry storm stateful stub.
- `app/api/vapi/webhook/route.test.ts` — vapi drift suite
  (R26/R31) + idempotency-column drift.
- `app/api/vapi/inbound-callback/route.test.ts` — vapi inbound
  drift suite (R25).
- `app/api/twilio/sms/route.test.ts` — twilio drift suite (R32).
- `scripts/smoke-webhook-preview.test.ts` — unit tests for the
  signature helpers used by this script.

## Feasibility write-up

See `docs/RETRY_HARNESS_FEASIBILITY_R33.md` for the trade-off
analysis that led to this smoke script instead of an MSW harness.
