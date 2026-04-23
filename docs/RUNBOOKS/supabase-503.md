# Runbook — Supabase is 503 / DB unreachable

**Severity:** SEV-1. The DB is the source of truth for everything;
nothing works without it.

## Symptom

- `curl https://evenquote.com/api/health` returns 503 with
  `checks: { db: 'fail' }`.
- Server actions all fail; the site loads (Next.js can render static
  shells) but every form submit and dashboard load throws.
- Vercel logs flooded with `fetch failed` from Supabase URLs, or
  `connection terminated unexpectedly`.
- Supabase status page (https://status.supabase.com) shows incident
  on your project's region.

## Why this is bad

The DB is on the hot path of:

- Stripe webhook (writes `payments`, updates `quote_requests`)
- Vapi webhook (writes call transcripts, updates `calls`)
- Cron jobs (retries, report sends)
- Every customer dashboard view

Magic-link sign-in *also* fails because Supabase Auth is the same
project. So even support workarounds like "I'll just send them a link
manually" require the DB to be alive.

## How to confirm

1. **Supabase status page** (https://status.supabase.com) — if there's
   a posted incident in your region, this is upstream and your job is
   to wait + communicate.
2. **Supabase project dashboard** — try opening the SQL editor. If it
   times out for you too, the project is genuinely down (vs. a network
   path issue from Vercel only).
3. **`/api/health` deep probe** vs basic — health does a trivial
   `count` query. If basic health passes but server actions still
   fail, you may be hitting a connection-pool exhaustion (look for
   `Max client connections reached` in logs).

## First three actions

1. **Engage `MAINTENANCE_MODE=true`** in Vercel env, redeploy. This
   serves the maintenance page to humans (you have a much better
   incident posture if customers see "we'll be right back" instead of
   raw error pages) while still allowing webhooks + crons through —
   so when the DB recovers, the queue catches up automatically.
2. **Check Supabase project pause state.** Free tier projects auto-pause
   after a week of no traffic; if you accidentally tripped this you
   need to manually unpause from the project dashboard.
3. **If pool-exhausted (not a Supabase outage):** check whether a new
   deploy introduced an N+1 or a leaking connection. The fastest
   rollback is Vercel → Deployments → previous green deploy →
   "Promote to Production". Pool will drain once the bad code is gone.

## Communicate

- Maintenance page already says the right thing — no extra copy
  needed.
- If outage is upstream (Supabase status page lit up), post a
  Twitter/LinkedIn note linking to their status page. Don't
  speculate on ETA; quote whatever they posted.
- Any in-flight refund/quote conversation: pause until DB is back
  and you can verify state.

## After the fire is out

- Lift `MAINTENANCE_MODE`.
- Tail logs for ~10 min watching for residual errors.
- Verify cron jobs catch up: `cron/retry-failed-calls` will pick up
  any calls left in `calling` past their SLA; `cron/send-reports`
  will pick up any `quote_requests.status='completed'` that didn't
  get an email out yet.
- If pool exhaustion was the cause, add a Postgres `pool_size` cap
  and revisit the change that introduced it. Connection leaks usually
  trace to forgetting to `await` an admin client query in a server
  action.
- Ensure `/api/cron/check-status` is back to `ok`.
