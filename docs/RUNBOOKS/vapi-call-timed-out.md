# Runbook — Vapi calls timing out / not completing

**Severity:** SEV-2 normally; SEV-1 if more than 30% of in-flight
quote requests are stuck in `calling` for >2× their SLA.

## Symptom

- `quote_requests.status = 'calling'` for many requests well past the
  expected completion window (typical: 30 min from enqueue).
- Per-business `calls.status` is mostly `failed` or `no_answer` — and
  this is unusual relative to your normal mix.
- Vapi dashboard shows your account in "rate-limited" or "paused"
  state, or shows error spikes.
- `/api/status` returns 503 with `vapi: 'fail'`.

## Why this is bad

Calls are the value EvenQuote sells. If they don't complete, customers
get a sparse or zero-quote report, which trips the cron's
zero-quote-refund path — money out, brand dinged. Even a partial outage
that returns 1-2 quotes instead of 5+ is a meaningful product
regression that customers will (rightly) complain about.

## How to confirm

1. `curl -H "x-cron-secret: $CRON_SECRET" https://evenquote.com/api/status`
   — if `vapi: 'fail'` with a message, the integration is broken at the
   account level. If `vapi: 'ok'`, it's instance-level.
2. Vapi dashboard → recent calls. Filter to your `assistantId`. Look
   at status mix and average duration. If most show `ended_reason:
   "no-answer"`, businesses just aren't picking up. If most show
   `ended_reason: "error"`, our config is wrong.
3. Query Supabase:
   ```sql
   select status, count(*) from calls
     where created_at > now() - interval '1 hour'
     group by status order by 2 desc;
   ```
   Compare to a normal hour. A sudden flip to mostly `failed` means
   ours; a flat flat distribution but lower volume means low call
   throughput somewhere upstream.

## First three actions

1. **Check the Vapi dashboard for an account-level alert** — paused,
   over-quota, billing-failed, etc. If yes: pay the bill or contact
   Vapi support. Nothing to fix on our side.
2. **Spot-check one stuck request** by hitting
   `/api/dev/trigger-call?requestId=<uuid>&token=$DEV_TRIGGER_TOKEN`.
   If that one call goes through to completion, the issue is throughput
   on the queue. If it fails the same way, the issue is per-call.
3. **Pause new intakes** by flipping `MAINTENANCE_MODE=true` in Vercel
   and redeploying. The maintenance allowlist keeps webhooks + crons
   running so in-flight requests can self-heal, but no *new* customers
   will pay into a broken pipeline.

## Communicate

- Customers with stuck requests: hold off on emails until you know
  whether the cron will eventually complete them. The
  `cron/retry-failed-calls` job re-attempts within its SLA window
  before the report is sent — most "timeouts" self-heal.
- If you have to manually refund: use Stripe dashboard, then INSERT
  into `payments` with status `refunded` referencing the same
  `stripe_event_id` for traceability.

## After the fire is out

- Lift `MAINTENANCE_MODE`.
- Verify the `cron/retry-failed-calls` job ran during the window —
  Vercel cron history.
- If the cause was Vapi-side, save the post-mortem from their support
  thread in `docs/RUNBOOKS/incidents/`.
- If the cause was ours (e.g. assistant config drift), add the
  specific failure mode to `lib/calls/vapi.test.ts` as a regression
  guard.
