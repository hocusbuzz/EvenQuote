# Runbook — Stripe webhook stopped firing

**Severity:** SEV-1 if it's been >15 min during business hours. Customers
have paid us and are owed service.

## Symptom

Any of these:

- Customer support: "I paid but never got a magic link."
- Stripe dashboard shows successful checkout sessions, but
  `quote_requests.status` is still `pending_payment` for those rows.
- Vercel logs for the `stripe/webhook` namespace are silent or only
  show `signature verification failed` errors.
- Stripe dashboard → Developers → Webhooks shows a red dot on the
  EvenQuote endpoint with mounting "Failed delivery" counts.

## Why this is bad

Stripe charges the card on `checkout.session.completed`. Our handler is
the *only* thing that writes the `payments` row, flips the
`quote_requests.status` to `paid`, sends the magic link, and enqueues
calls. If it's down: money in, no service out. The customer experience
is "I paid for nothing."

Stripe will retry failed deliveries for ~3 days, so as long as you
restore the endpoint within that window the queue self-heals. After 3
days, you have to pull the events from the Stripe dashboard manually.

## How to confirm

1. **Stripe dashboard** → Developers → Webhooks → EvenQuote endpoint.
   Look at "Recent deliveries". If the last 5+ are red, this is your
   incident.
2. **Vercel logs** → filter to `route=/api/stripe/webhook`. If you see
   no requests, Stripe isn't reaching us. If you see 401/500 spam,
   something's failing on our side.
3. `curl https://evenquote.com/api/health` — should be 200. If it's
   503, jump to [supabase-503.md](./supabase-503.md) instead; the
   webhook can't write if the DB is down.

## First three actions

1. **Read the actual error.** Stripe dashboard → click any failed
   delivery → "Response" tab. The HTTP status and body tell you
   whether it's auth (401, missing/wrong secret), signature (400),
   or handler (500).
2. **Check `STRIPE_WEBHOOK_SECRET` in Vercel env**, scoped to the
   *production* environment. If it doesn't match the one Stripe shows
   on the endpoint settings page (Reveal → copy), rotate the Stripe
   side, paste into Vercel, redeploy.
3. **Manually re-trigger** the most recent failed delivery from the
   Stripe dashboard ("Resend" button on the delivery detail). If it
   now returns 200, monitor for 5 min and resend the rest in batches.

## Communicate

- Internal: status page, post a SEV note in your own log.
- External: if any customer has reached out, reply manually with a
  magic link generated from `/api/dev/backfill-call` (after fixing
  the underlying issue) and apologize. Do NOT issue refunds yet —
  the calls likely went through once you restored.

## After the fire is out

- Open a ticket: "Stripe webhook outage retro — date — root cause".
- If the cause was secret rotation drift, add a calendar reminder for
  next quarterly rotation to update both sides simultaneously.
- Spot-check `payments` table for the affected window: are
  `stripe_event_id` values unique, do counts match Stripe dashboard?
- Verify `/api/cron/check-status` continues to fire and reports `ok`.
