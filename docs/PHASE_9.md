# Phase 9 — Report generation + email delivery

Phase 7 closed the reliability gaps on the call side. Phase 8 shipped
the opt-in contact release pipeline. Phase 9 is the missing middle:
the moment between "all calls done" and "customer gets to click a
Share button" — turning the raw `quotes` rows into a rendered report
and actually putting it in the customer's inbox.

## What shipped

### Cron (`app/api/cron/send-reports/route.ts`)

New serverless route that:

1. Scans `quote_requests WHERE status='processing' AND report_sent_at
   IS NULL`, ordered oldest-first, capped at `MAX_PER_RUN = 25` per
   invocation.
2. For each one: resolves a recipient, loads the quotes + business
   names, calls `renderQuoteReport` from `lib/email/templates.ts`,
   persists a `report_data` snapshot, sends via Resend, then stamps
   `report_sent_at` and flips `status → 'completed'`.
3. Returns a structured JSON summary for Vercel Cron's log:
   `{ ok, scanned, sent, failed, skipped, details }`.

Auth: same pattern as `retry-failed-calls` — `CRON_SECRET` via either
`x-cron-secret` header or `Authorization: Bearer <secret>`. Vercel
Cron sends the Bearer header automatically.

Exports `sendPendingReports(admin)` alongside the route handlers so
a one-off local script or a test can invoke the core logic without
HTTP.

### Recipient resolution

The customer may or may not have claimed the request with a
Supabase auth account by the time the report is ready:

- `user_id IS NOT NULL` → pull from `profiles.email` + `full_name`.
  This is the post-claim path; the customer signed in via the magic
  link after checkout.
- `user_id IS NULL` → fall back to `intake_data.contact_email` and
  `contact_name`. Guest flow, pre-claim. The report still has a
  dashboard CTA — clicking it through the claim route will attach
  ownership on first sign-in.
- Neither available → skip, log as `skipped: "no recipient email"`.

### Snapshot storage

Before sending, the cron writes `report_generated_at` and a
compact `report_data` JSON snapshot to `quote_requests`. The snapshot
captures the payload that went into the email — `category_name`,
`coverage_summary`, `quote_count`, and a minimal `payload_snapshot`
with city/state + the quote cards. Deliberately trimmed: no
rendered HTML (regeneratable from the snapshot + current templates),
no PII beyond city/state.

This means a later UI ("see the email I sent you") can faithfully
reconstruct what the customer saw without re-querying live data
whose counts may have drifted.

### Failure behavior

- Send fails → keep `status='processing'`, don't stamp
  `report_sent_at`. Next cron run retries. No retry counter; sustained
  failure is an ops-level concern to surface via log volume.
- Final stamp fails AFTER a successful send → loud error log with
  the Resend message id. Next run would re-send (since
  `report_sent_at IS NULL`), so ops needs to manually stamp to
  prevent a duplicate. This is vanishingly rare (a network hiccup
  between a successful Resend response and a Supabase UPDATE), but
  it's the one inconsistent-state this cron can leave behind.

### Cron wiring (`vercel.json`)

Added `/api/cron/send-reports` at `*/5 * * * *`. Five minutes is the
sweet spot:

- Tight enough that a customer waiting on a report doesn't sit on
  `processing` for long.
- Loose enough that retries after a transient Resend error don't
  hammer the provider.

Vercel Hobby caps cron at daily, so this too requires Pro or wiring
through Supabase Scheduled Functions. Same approach documented in
`docs/PHASE_7.md`.

## How to test locally

1. **End-to-end happy path.** Run a full batch:

   ```bash
   # seed a request + enqueue calls, then simulate end-of-call webhooks
   # until apply_call_end flips status → 'processing'
   curl -H 'x-cron-secret: <secret>' \
        http://localhost:3000/api/cron/send-reports
   ```

   Expected JSON: `{ ok:true, scanned:1, sent:1, failed:0, skipped:0, ... }`.
   The quote_request row should now have `report_generated_at`,
   `report_data`, `report_sent_at` populated, and `status='completed'`.
   Without `RESEND_API_KEY` the console logs `[email] simulated send → …`.

2. **Guest recipient fallback.** Clear `user_id` on a processing
   request:

   ```sql
   update quote_requests set user_id = null where id = '<id>';
   ```

   Run the cron. The email goes to `intake_data.contact_email` instead.

3. **No recipient.** Clear `user_id` AND `intake_data.contact_email`
   (rare — intake forms require email, but sanity-check):

   ```sql
   update quote_requests
      set user_id = null,
          intake_data = intake_data - 'contact_email'
    where id = '<id>';
   ```

   The cron logs `skipped: "no recipient email"` and leaves the row in
   `processing` for support to fix.

4. **Retry after send failure.** Temporarily break `RESEND_API_KEY`
   (set to an invalid value, not unset — unset means simulation mode).
   Run the cron: it logs an error and leaves the row. Fix the key and
   re-run: the row flips to `completed`.

## Pre-deploy fix: retry-exhaustion counter bump

Discovered during the pre-deploy trace. The Phase 7 retry worker hard-
capped at `retry_count=3`. Dispatch-exhausted rows have no
`vapi_call_id`, so the Vapi webhook never fires for them, so
`apply_call_end` never counts them toward `total_calls_completed`. Net
effect: a single dead phone number stranded the whole quote_request in
`status='calling'` forever, and this Phase 9 cron (filtering
`status='processing'`) never fired — customer paid, got nothing.

Fix applied in two places:

1. `app/api/cron/retry-failed-calls/route.ts` — when a retry pushes
   `retry_count` to 3, call `apply_call_end(request_id, false)` to count
   the permanent dispatch failure toward completed. Lets the status flip
   fire once the surviving calls wind down.
2. `lib/calls/engine.ts` — set `total_businesses_to_call` immediately
   after inserting the calls rows (not at the end of the function). If
   the engine crashes mid-dispatch, the denominator is still correct, so
   apply_call_end can still transition the request.

## Known gaps (Phase 10+)

- **No delivery webhook listener.** Resend can POST
  delivered/bounced/complained events but we don't subscribe. Adding
  this would let us distinguish "inbox" from "blackhole" and surface
  bounces on the request detail page.
- **No "resend me the email" button.** Once `report_sent_at` is
  stamped, there's no user-facing way to get the email again. A
  self-serve resend is a cheap Phase 10 win.
- **No refund trigger for zero-quote rounds.** The template handles
  an empty quotes list gracefully, but we still stamp `completed` and
  keep the $9.99. Product call: either auto-refund when
  `total_quotes_collected = 0`, or surface a "request a refund"
  button in the report. Deferred to Phase 10 pricing work.
- **HTML rendering is pure string concat.** Fine for the two
  templates we have but inelegant. Phase 10 candidate: migrate to
  React Email with server-rendered HTML if we grow beyond 3-4
  templates.
