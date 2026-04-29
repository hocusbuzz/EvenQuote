# Real-Network Retry Harness — Feasibility Assessment (R33)

_On the punchlist since R22. R30 (stateful-stub), R31 (drift-capturing stub), and R32 (insert-shape drift suite) converged on the invariant shape; this doc captures the remaining work required to land a real-HTTP harness._

## Goal

Replace the current mock-based webhook idempotency tests with a harness
that exercises the full request pipeline (signature verify → body parse
→ DB-layer idempotency → side-effect fan-out) at retry-storm scale,
using a real in-memory HTTP boundary and a real mocked network layer.
The intent is to catch bugs that the current stub-based tests cannot
see — e.g., header parsing differences, middleware ordering, raw-body
handling under chunked encoding.

## What exists today

Stub-based idempotency invariants are locked across all four external
webhooks:

| Webhook | Drift suite | Retry-storm pattern | Locked at |
|---|---|---|---|
| stripe | R27 (8-column insert) | R30 stateful-stub (20-retry storm) | `app/api/stripe/webhook/route.test.ts` |
| vapi/webhook | R26 (15-column insert) | R31 drift-capturing stub | `app/api/vapi/webhook/route.test.ts` |
| vapi/inbound-callback | R25 (full-path block) | — | `app/api/vapi/inbound-callback/route.test.ts` |
| twilio/sms | R32 (10-column + RPC drift) | R32 dedupe short-circuit | `app/api/twilio/sms/route.test.ts` |

These tests call the route's exported `POST()` directly with a
hand-constructed `Request` object. They do NOT traverse:

- Next.js runtime middleware (`middleware.ts`) — CSP nonce injection,
  rate-limit header propagation, etc.
- `next/server` body parsing edge cases — chunked transfer, partial
  chunked read, non-UTF-8 bytes.
- Route-discovery and method-allow-list (GET on a POST-only route).
- Platform-level retry-behavior annotations (Vercel's `maxDuration`,
  region pinning).

## What a real harness would add

1. **Signature-verification drift on raw bytes.** Stripe's HMAC is
   computed over the exact request bytes. A future refactor that
   introduced middleware body-transformation (e.g., a sanitizer)
   would silently break signature verification on the real stack
   but pass the current tests because the test calls `POST()` with a
   string, bypassing Next's request body reader.
2. **Chunked-encoding retry parity.** Stripe and Vapi retry with
   chunked encoding sometimes; a partial-chunk read could surface a
   real bug not reachable from a unit test.
3. **Middleware-ordering regressions.** Rate-limit and CSP middleware
   applied before webhook auth would reject legitimate Stripe retries.
   The current tests cannot catch this class of bug.
4. **Actual HTTP status propagation.** Routes return NextResponse;
   tests inspect `res.status` directly. A harness proves the response
   reaches the wire correctly (e.g., 204s aren't accidentally converted
   to 200 by an edge runtime).

## Blockers for autonomous landing

1. **Dev dependency addition.** MSW (`msw`) and `supertest` are not in
   `package.json`. Installing a dev dependency is a mutating change
   that should pass through user review — it touches `package.json`,
   `package-lock.json`, and introduces a third-party module that ships
   in test binaries.
2. **Next.js App Router test transport.** There is no official Vercel-
   sanctioned way to boot a Next App Router instance inside Vitest and
   serve `POST /api/stripe/webhook` over a real socket. `supertest`
   requires an Express-like `app`; Next.js's handler exports don't
   provide one. Options:

   a. `next dev` subprocess + `fetch()` — works but adds ~30s startup
      per test file and couples tests to a port. Not a good fit for
      CI.

   b. `next.createServer()` + `http.createServer()` — undocumented,
      version-sensitive. Would need a shim for App Router since the
      exposed APIs are pages-router-flavored.

   c. `@edge-runtime/vm` to simulate the Edge runtime — doesn't help
      because our webhooks are Node runtime. Wrong target.

   d. Call route handlers directly but pipe the request through the
      middleware-chain manually — the "best of both" but requires
      replicating Next's middleware composition logic. ~40 lines of
      adapter code that would then need maintenance on every Next
      major.
3. **Vercel deploy parity.** The real bug class we care about (chunked
   bytes, edge-middleware ordering) only manifests on Vercel's
   deployment target. A local MSW harness doesn't reproduce it. The
   durable fix is a post-deploy smoke test that POSTs real signed
   webhook payloads at the preview deployment, not a local harness.

## Recommendation

**Scope down and pivot.** The highest-value version of this work is
NOT an MSW harness; it's a **preview-deploy smoke-test script** that:

1. Constructs a real Stripe-signed webhook payload using the same
   `buildSignedEvent()` helper as the current tests.
2. POSTs it to the preview-deployment URL during Vercel's automated
   preview-deploy hook.
3. Asserts 200 + asserts the `payments` row was inserted.
4. Re-POSTs the same event-id 20 times, asserts 200 each time, asserts
   still exactly one `payments` row.

This catches the middleware-ordering, raw-body, and chunked-encoding
classes of bug that the stub tests can't, AND exercises the real
Vercel deployment target — which is what we actually care about.

It's also a ~60-line script that doesn't add MSW to the dependency
tree. User can run it manually before promoting a preview to
production, or wire it into a GitHub Action that gates the
"Promote to Production" button.

## Recommended R34 action items

**(a) Ask the user:** pre-approve adding `msw@2.x` as a dev dependency
if the local-harness approach is the preferred direction after all.
Signal: how much do we want raw-bytes coverage vs preview-deploy
coverage? They're different test surfaces.

**(b) Alternative:** write `scripts/smoke-webhook-preview.ts` targeting
the preview-deploy URL. This is a pure addition, no new deps, and
gives 70% of the real-harness value. Tentatively estimated at 90 min
including docs. Would cover:

- Stripe signed payload + retry-storm assertion.
- Vapi signed payload + retry-storm assertion.
- Twilio signed payload + idempotency assertion.

**(c) Deferred:** MSW harness proper. Only makes sense AFTER (a) or
(b) has proven the retry-storm invariant holds on the real deploy
target.

## User-input asks added to backlog

1. Pre-approve adding `msw@2.x` + `supertest@7.x` as dev deps OR
   confirm preference for the smoke-script alternative.

_No other blockers; the decision is purely "what test surface do we
want to invest in first."_
