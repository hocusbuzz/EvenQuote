# Phase 5 — Stripe checkout + post-payment flow

**Goal**: a guest can complete intake, pay $9.99, receive a magic-link email
that attaches the payment to their account on first sign-in, and land on a
confirmation page. The calling pipeline is stubbed — the *stub still runs*
so we can verify the full paid flow end to end in Phase 5 without wiring
Vapi yet.

---

## What shipped

### Schema

`supabase/migrations/0003_stripe_payments.sql`

- `payments.user_id` → nullable (guest payments before sign-in).
- `payments.stripe_event_id` (unique partial index) → webhook idempotency.
- `payments.claimed_at` → audit trail for when a guest payment was attached
  to a user.
- Partial index on unclaimed payments for the claim-lookup fast path.

No changes to RLS. Service-role writes only — RLS on `payments` already
reads `auth.uid() = user_id`, which correctly returns false for guest rows
and means unauthenticated clients cannot read them.

### Stripe integration

- `lib/stripe/server.ts` — pinned-version Stripe SDK singleton with the
  `server-only` guard.
- `lib/actions/checkout.ts` — `createCheckoutSession(raw)` server action.
  Validates the request id, verifies status, and creates a Checkout Session
  with `client_reference_id`, `customer_email`, metadata, success/cancel
  URLs, and a 30-minute session expiry. Never trusts client-supplied price.
- `app/api/stripe/webhook/route.ts` — verifies signature on the raw body,
  handles `checkout.session.completed`, and ignores everything else. See
  idempotency notes below.

### Post-payment flow

- `lib/actions/post-payment.ts` → `sendPaymentMagicLink({ email, requestId })`.
  Triggers Supabase OTP email with `emailRedirectTo` pointing at
  `/auth/callback?next=/get-quotes/claim?request=<uuid>`.
- `lib/queue/enqueue-calls.ts` → `enqueueQuoteCalls({ quoteRequestId })`.
  **Phase 5 stub**. Advances status `paid → calling` under a conditional
  update so it's idempotent, then logs what it *would* dial. Phase 6
  replaces the inner block with business lookups and Vapi dispatch.

### Pages & routes

- `app/get-quotes/checkout/page.tsx` → real checkout summary + PayButton.
  Uses admin client because the quote_request may be a guest row.
- `components/checkout/pay-button.tsx` → client component that calls the
  server action and `window.location.href`'s to Stripe.
- `app/get-quotes/success/page.tsx` → two states: "check your email"
  (guest, not yet claimed) and "your quotes are in motion" (signed-in
  claimant).
- `app/get-quotes/claim/route.ts` → GET handler that backfills
  `quote_requests.user_id` and `payments.user_id/claimed_at` after the
  user clicks the magic link. Rejects claim if the signed-in user's
  email doesn't match the intake email (key security check).

### Config

- `.env.example` — uncommented + documented the three Stripe vars:
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`.
- `package.json` — added `stripe@^17.3.0` and a `stripe:listen` script
  that forwards CLI events to `localhost:3000/api/stripe/webhook`.

---

## Idempotency — how the webhook avoids double-processing

Stripe retries non-2xx and can re-deliver even on 2xx. The handler is safe
under concurrent and repeated delivery because:

1. **`payments.stripe_event_id` unique index.** The first thing the
   handler does on `checkout.session.completed` is insert a payment row
   keyed on `event.id`. A duplicate event hits the unique index with
   Postgres error `23505`, which we catch and treat as "already done".
2. **Conditional status flip.** The update from `pending_payment → paid`
   uses `WHERE status = 'pending_payment'`. A second invocation can't
   clobber a later status.
3. **`enqueueQuoteCalls` is also guarded.** Advances `paid → calling`
   conditionally; a replay returns early with `advanced: false`.

If any post-payment side effect throws (magic-link email failure, enqueue
error), we log but still return 200 — the payment is already recorded and
retrying the whole event would loop the magic-link send.

---

## Security checks

- Stripe webhook signature verified on the **raw body**, not a re-serialized
  JSON. `await req.text()` before any parsing.
- `STRIPE_SECRET_KEY` lives server-side only. The SDK singleton has a
  `typeof window` guard that throws at import time on the client.
- Checkout amount, success URL, cancel URL all server-controlled. Client
  cannot influence them via the `createCheckoutSession` payload.
- Claim route requires the signed-in user's email to match the intake
  email. Without this, any user with the request UUID could claim a
  stranger's payment by visiting `/get-quotes/claim?request=<uuid>`.
- Request UUID in URLs is not treated as a secret. The magic-link email
  and the email-match check in `/claim` are the authz boundary.

---

## Local test checklist

Prereqs:

- Stripe CLI installed and logged in: `stripe login`
- Supabase local or project running with migration `0003` applied
- `.env.local` populated with Supabase + Stripe test keys

Run in two terminals:

```bash
# Terminal 1
pnpm dev

# Terminal 2 — forwards webhook events to local server
pnpm stripe:listen
# copy the whsec_... it prints into .env.local as STRIPE_WEBHOOK_SECRET,
# then restart pnpm dev
```

### Scenarios

**1. Happy-path guest flow**
- [ ] Open `/get-quotes` in an incognito window, fill intake, submit.
- [ ] Redirected to `/get-quotes/checkout?request=<uuid>`; summary shows
      correct city/state/price/email.
- [ ] Click "Pay $9.99" → redirected to Stripe.
- [ ] Pay with test card `4242 4242 4242 4242`, any future date, any CVC.
- [ ] Lands on `/get-quotes/success?session_id=cs_test_...` showing
      the "check your email" variant.
- [ ] `payments` row inserted with `user_id IS NULL`, `status='paid'`,
      and `stripe_event_id` populated.
- [ ] `quote_requests.status` is now `calling` (webhook flipped to
      `paid`, then stub advanced to `calling`).
- [ ] Magic-link email received at the intake email.
- [ ] Click magic link → lands on `/get-quotes/success?request=<uuid>`
      showing the "your quotes are in motion" variant.
- [ ] `payments.user_id` is now populated, `claimed_at` set.
- [ ] `quote_requests.user_id` is now populated.

**2. Already-paid redirect**
- [ ] Visit `/get-quotes/checkout?request=<paid-uuid>` → redirected to
      `/get-quotes/success`.

**3. Cancel path**
- [ ] Start checkout, click Stripe's "back" link → redirected to
      `/get-quotes/checkout?request=<uuid>&cancelled=1` with dismissible
      banner. Button still works.

**4. Duplicate webhook delivery (idempotency)**
- [ ] In a second Terminal 2, run
      `stripe events resend <evt_...>` using the event id from the first
      run. Server should log `duplicate event, already processed` and
      respond 200. No second `payments` row.

**5. Bad signature**
- [ ] `curl -X POST localhost:3000/api/stripe/webhook -d '{}'` → 400
      with `Invalid signature`.

**6. Claim-email mismatch**
- [ ] Sign in as a user whose email is NOT the intake email.
- [ ] Visit `/get-quotes/claim?request=<guest-uuid>`.
- [ ] Redirected to `/auth-code-error` with the "different email"
      message. `payments.user_id` stays NULL.

**7. Double-claim by same user (magic-link re-click)**
- [ ] Click magic link twice. Second click: no error, payment stays
      claimed (still same user_id), no duplicate writes.

**8. Logged-in buyer (skips the email dance)**
- [ ] Sign in, start intake, pay. `payments.user_id` and
      `quote_requests.user_id` already match the session — success page
      renders the claimed variant directly.

---

## Known gaps / Phase 6 handoff

- **No reconciler yet.** If `sendPaymentMagicLink` or `enqueueQuoteCalls`
  throws after we return 200, nothing retries. Phase 6 should add a
  periodic sweep over `quote_requests.status='paid' AND updated_at < now() - 10m`.
- **Stripe CLI only in dev.** Production webhook config (endpoint URL,
  event types, signing secret rotation) needs a runbook — add in Phase 6
  along with Vercel deployment notes.
- **Single SKU.** Inline `price_data`. When we add upsells (rush
  delivery, extra call count) switch to catalog Prices and feature-flag
  the line items.
- **Refunds.** Not handled. `charge.refunded` event is currently ignored;
  we'd need to decrement status and potentially halt the calling job.
