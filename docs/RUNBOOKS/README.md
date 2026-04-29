# Runbooks

One-page incident playbooks for the four most likely production
breakages. Each one is the same shape: **symptom → why this is bad →
how to confirm → first three actions → what to communicate → after
the fire is out**.

The audience is "Antonio at 2am holding a phone." Optimised for
recipe-following, not for being clever.

| Scenario | When you'd reach for this |
| --- | --- |
| [soft-launch.md](./soft-launch.md) | First production deploy. Steps 1–13, in order. Read this before pushing the green button. |
| [stripe-webhook-down.md](./stripe-webhook-down.md) | Customers paid but never got a magic link or their request didn't progress past `pending_payment`. |
| [vapi-call-timed-out.md](./vapi-call-timed-out.md) | Quote requests stuck in `calling` long past their SLA, or per-business calls in `failed`/`no_answer` storm. |
| [supabase-503.md](./supabase-503.md) | `/api/health` returns 503. Site appears up but every server action throws. |
| [resend-bounced.md](./resend-bounced.md) | Reports aren't landing in inboxes. Customers complain they never received their quote report. |

## When in doubt

1. Check `/api/health` and `/api/status` first. They tell you whether
   it's the DB (`/health`) or the paid integrations (`/status`).
2. Check Vercel cron failure history — `check-status` is scheduled to
   ping every 10 min; a red line on its run history is your timeline.
3. Check Sentry / Vercel logs scoped to the relevant logger namespace
   (`stripe/webhook`, `vapi/webhook`, `cron/send-reports`, etc.). All
   logs are PII-redacted at the `lib/logger.ts` layer.

## Severity guide

| Severity | Definition | Example |
| --- | --- | --- |
| SEV-1 | Customers paying and not receiving service. Money at risk. | Stripe webhook down for >15 min during business hours. |
| SEV-2 | One channel of value broken; workaround exists. | Resend down — reports not delivered. Vapi calls still happening; data is in DB. |
| SEV-3 | Degraded but no customer impact yet. | One business returning consistent failures; others fine. |

If you're unsure, default to SEV-2 and downgrade once you have
information.
