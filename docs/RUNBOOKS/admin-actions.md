# Runbook — Admin actions reference

When something goes sideways, `/admin/requests/<id>` has six one-click
buttons. This doc tells you which to press for which symptom, what
they actually do under the hood, and what's safe to double-click.

The audience is "Antonio at 2am holding a phone, has 30 seconds to
decide which button." Optimised for recipe-following.

## Cheat sheet

| Symptom | Click |
| --- | --- |
| Customer paid, no calls happened, no quotes | **Refund $9.99** + **Mark failed** |
| Calls completed but no quotes extracted from any of them | **Re-run extractor** |
| Calls completed with a couple quotes; customer wants more options | **Retry unreached (up to 5)** |
| Customer says they didn't get the report email | **Resend report** |
| Want this row off the main /admin list | **Archive** |
| Need to bring it back later | **Archive** (toggles) |

When in doubt: **Refund first**, ask questions second. Refunds are
idempotent on Stripe's side (shared idempotency key with the cron's
zero-quote refund path) so a "wrong" refund click is recoverable —
the customer is happy and you can always re-charge later if it really
was a mistake. The reverse is much harder.

---

## The buttons

Located in two places on `/admin/requests/<id>`:

- **OPS ACTIONS** group near the top (Refund / Mark failed / Resend report) — destructive or money-moving, each has a confirm dialog
- **Calls** section header (Retry unreached / Re-run extractor) — additive, no confirm
- **Header row** (Archive) — toggle

### `↺ Refund $9.99`

**What it does**

Calls Stripe `refunds.create` with idempotency key `refund-zero-quotes-<paymentId>`
(the same key the send-reports cron uses for its automatic zero-quote
refund path). Updates `payments.status='refunded'`. Stamps
`quote_requests.report_data.refund_outcome='issued'` and
`refund_issued_by_admin_at` so the row carries an audit trail.

**When to use**
- Customer asked for a refund directly
- Request stuck in `paid` or `calling` with no path forward and you
  want to escape the customer rather than wait for the cron's logic
- Test request needs cleaning up

**Safe to double-click?** Yes. Stripe's idempotency key returns the
existing refund instead of creating a second one. A second click
returns "Already refunded — no-op."

**Side effects you should know about**
- Customer's card is credited within 5-10 business days (Stripe's
  bank-side window — out of our control)
- Does NOT change `quote_requests.status` — pair with **Mark failed**
  if you want the row to surface in the failed-state filter
- Does NOT send an email — pair with **Resend report** OR rely on
  the next cron tick to send the refund-issued email

**What it can't do**
- If `payments.stripe_payment_intent_id` is null (super old or
  dev-trigger row), the button errors with "manually in the Stripe
  dashboard" — do it by hand at https://dashboard.stripe.com → Payments

---

### `⚠ Mark failed`

**What it does**

Forces `quote_requests.status='failed'`. That's it — single-row UPDATE,
no Stripe touch, no email.

**When to use**
- After clicking **Refund** and you want the row to read as terminal
  in the customer's `/dashboard` (the empty-state copy branches on
  status)
- Request is hung mid-pipeline and you want it OUT of `paid` /
  `calling` / `processing` so the watchdog crons stop firing alerts
  on it

**Safe to double-click?** Yes. Setting `status='failed'` on an already-
failed row is a no-op write.

**Side effects you should know about**
- Customer's `/dashboard/requests/<id>` flips to the "We hit a snag"
  empty state (see `lib/dashboard/empty-state.ts`)
- send-reports cron only scans `processing` and `completed` rows, so
  marking `failed` REMOVES the row from automatic refund processing.
  If you want the cron to refund it, leave status as `processing`
  instead.

**Common pairing**
- **Refund + Mark failed** is the standard "make this customer whole
  and end the cycle" combo

---

### `✉ Resend report`

**What it does**

Re-renders the report email from CURRENT DB state (not from the
saved snapshot — so any quotes that landed via **Re-run extractor**
in the meantime are included) and sends via Resend. Stamps
`report_data.last_resent_at` for audit. Preserves prior
`refund_outcome` from the original send (so a "refund issued" email
stays a "refund issued" email even if a quote landed afterward).

**When to use**
- Customer says "I didn't get the email" (spam folder, deleted, lost)
- You ran **Re-run extractor** and want the customer to see the new
  quotes that landed

**Safe to double-click?** **No.** Each click sends a new email. The
button has a confirm dialog as the human guard. Double-click =
duplicate email = mild customer confusion.

**Side effects you should know about**
- Counts as a real Resend send against your monthly quota
- Does NOT touch row state (`status`, `report_sent_at`) — purely
  additive
- Tag in Resend dashboard: `quote-report-resend` (vs the original
  `quote-report`) — so you can distinguish

**What it can't do**
- If there's no recipient email (no profile, no intake.contact_email),
  the button errors. That should be impossible for a real paid
  request but can happen on test data.

---

### `↻ Re-run extractor`

**What it does**

Walks every completed call on the request that doesn't already have a
`quotes` row and re-runs the Anthropic extractor on the saved
transcript. Inserts new `quotes` rows for any successful extractions.
Bumps `total_quotes_collected` via `increment_quotes_collected` RPC.

**When to use**
- The first extraction returned `ok:false` (prompt issue, missing
  ANTHROPIC_API_KEY at the time, transient Anthropic outage) and you
  want to retry without re-dialing
- You tweaked the per-vertical extraction prompt in
  `service_categories.extraction_schema` and want to apply it
  retroactively

**Safe to double-click?** Yes. `quotes.call_id` is UNIQUE — duplicate
inserts from a re-run are caught and counted as "already landed."

**Side effects you should know about**
- Burns Anthropic API credits (~cents per call)
- Sequential per call (not parallel) — for a 5-call request that's
  ~5-15 sec while it's working
- Does NOT bump call counters or flip `quote_requests.status` —
  those already advanced when the original webhook landed

**Common pairing**
- After **Re-run extractor** lands new quotes, **Resend report** to
  push them out to the customer

---

### `↻ Retry unreached (up to 5)`

**What it does**

Dispatches up to 5 NEW Vapi calls to businesses we haven't dialed yet
on this request. Bumps `total_businesses_to_call` so the
status-advance invariant holds. Goes through the same engine as the
initial dispatch.

**When to use**
- Original batch had too many voicemails / refusals and the customer
  needs more coverage
- A specific stuck request is nearly done but a couple calls in the
  original batch failed mid-flight and you want fresh attempts

**Safe to double-click?** **Soft-yes.** Capped at 5 new calls per
click — `runAdditionalBatch` enforces it. So a double-click costs at
most 10 additional Vapi calls (~$0.50–1.50 worst case). Not a
disaster but not free either.

**Side effects you should know about**
- Real Vapi calls = real Vapi spend. Each call is up to 6 min × ~$0.15
  = ~$0.90 worst case
- If no NEW businesses are available in the coverage area (already
  dialed everyone we know about), the button returns "No new
  businesses available in coverage area."
- Updates `total_businesses_to_call`, which extends the customer's
  `total_calls_completed/total_businesses_to_call` counter

---

### `Archive`

**What it does**

Toggles `quote_requests.archived_at` between `now()` and `null`. Pure
visibility — archived rows are filtered OUT of the default `/admin`
overview but remain queryable.

**When to use**
- Test requests cluttering the `/admin` view
- Refunded + closed-out requests you don't want at the top of the
  list anymore

**Safe to double-click?** Yes. The button reads the current state and
flips the opposite — double-click returns to the prior state.

**Side effects you should know about**
- The customer's `/dashboard` view does NOT change. Archive is purely
  for operator-facing list filtering.
- Does NOT cascade to Stripe / Vapi / anything else.

---

## Decision tree

```
Customer paid, you opened /admin/requests/<id>
│
├─ status='paid' but it's been >30 min and total_calls_completed=0?
│  → check the "Scheduled dispatch (#117 deferral)" banner.
│    If scheduledFor is in the future, it's WORKING AS DESIGNED —
│    do NOT click anything. The cron will pick it up at the
│    scheduled time.
│    If scheduledFor is in the past or absent, the engine missed it.
│    → Refund + Mark failed.
│
├─ status='calling' for >25 min?
│  → check the calls section. Are most calls 'no_answer' / 'failed'?
│    If yes: this is a coverage problem.
│    → Refund + Mark failed (kindest customer outcome).
│    → Optionally: Retry unreached if you think a fresh batch
│      might work (e.g., it's now business hours and the original
│      batch went out at 5am).
│
├─ status='processing' for >60 min?
│  → check the calls section. Are most calls 'completed' but with
│    no transcripts / no quote rows?
│    If yes: extraction failed.
│    → Re-run extractor first.
│    → If it still doesn't pull quotes: Refund + Mark failed.
│
├─ status='completed' but customer says no email arrived?
│  → check the quote_requests row in admin: is report_sent_at set?
│    If yes, Resend already shipped it once. Customer probably has
│    it in spam.
│    → Resend report (sends another copy).
│    If no, the cron didn't fire OR send failed silently.
│    → Check Sentry for `lib:cron-send-reports`. Then Resend report.
│
└─ Just want this row off your screen?
   → Archive.
```

## What about the existing crons?

The new admin buttons COEXIST with the four crons that run automatically:

- **send-reports** (every 5 min) — handles the normal "process →
  email + maybe refund" flow. Most stuck-request scenarios resolve
  themselves on the next tick. Always check the cron history before
  manual intervention.
- **retry-failed-calls** (every 10 min) — re-dials failed dispatches.
  Pre-empts the need to click **Retry unreached** in many cases.
- **check-stuck-requests** (every 15 min) — emails ops when a row is
  past its SLA. If you're reading this doc, you probably got that email.
- **dispatch-scheduled-requests** (every 5 min) — handles #117
  deferred-dispatch requests at their scheduled time. If a row has
  the "Scheduled dispatch" banner, leave it alone until the cron has
  had its chance.
- **reconcile-calls** (every 30 min) — pulls fresh state from Vapi
  for calls stuck because their webhook was dropped. Often resolves
  "calls in_progress for 60+ min" on its own.
- **check-status** (every 15 min) — exercises Stripe + Vapi + Resend
  with health probes. If you're seeing widespread weirdness, check
  this cron's run history first — a red line points at the integration
  that broke.

**Heuristic:** wait for ONE cron tick before clicking anything manual.
The crons are designed to handle 95% of the recovery automatically;
the buttons are for the 5% that fall through.

## Audit trail

Every click is logged via `lib/logger.ts` (PII-redacted) with the
admin's `user_id`. Refunds also carry `actor_user_id` in Stripe
metadata. Sentry captures (on failure only) tag the `requestId` so
you can grep by request later.

There's no separate "audit log" table today. If you need to know
"who refunded what when" the sources of truth are:
1. Stripe refund object's metadata (`actor_user_id`, `source`)
2. Vercel logs for the `actions/admin` namespace
3. `quote_requests.report_data.refund_issued_by_admin_at` timestamp
