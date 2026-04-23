# Incident Postmortems

This folder is the home for blameless postmortems after a real incident.

## When to write one

After any **SEV-1** or **SEV-2** (see [../README.md](../README.md) for
the severity guide). SEV-3s are optional — write one if a pattern is
emerging or if the fix touched a load-bearing system.

Don't wait for everything to be polished. A draft within 48 hours
beats a perfect doc that never lands.

## File naming

`YYYY-MM-DD-short-name.md`

Examples:
- `2026-05-12-stripe-webhook-paused.md`
- `2026-06-03-vapi-rate-limit-storm.md`

The date is the day the incident started, not the day you wrote the
postmortem. One postmortem per incident, even if it spanned multiple
days.

## Template

Copy this into a new file and fill in:

```markdown
# YYYY-MM-DD — short, plain-English title

**Severity:** SEV-1 / SEV-2 / SEV-3
**Duration:** HH:MM start → HH:MM resolved (timezone)
**Customer impact:** What did users see? How many? Money lost?
**Author:** Antonio
**Status:** draft / final

## Summary

One paragraph. What broke, what the impact was, what fixed it.

## Timeline

- HH:MM — first signal (alert / customer / Vercel page)
- HH:MM — initial hypothesis
- HH:MM — discovered actual cause
- HH:MM — fix applied
- HH:MM — confirmed resolved

Times in your local timezone.

## Root cause

What actually happened, mechanically. Code, config, or upstream
provider. No "human error" — find the system gap that let the human
mistake reach production.

## What went well

What about our setup made this easier than it could have been?
(Runbook existed, alerts fired correctly, logs had the right context,
rollback was one command, etc.)

## What went poorly

What slowed us down? Missing dashboard, unclear log message, surprise
dependency, alert that didn't fire?

## Action items

| # | Action | Owner | Due |
|---|--------|-------|-----|
| 1 | ... | Antonio | YYYY-MM-DD |
| 2 | ... | Antonio | YYYY-MM-DD |

Each action should be falsifiable — "improve monitoring" doesn't
count; "add an alert at p95 latency >2s on /api/health" does.

## Lessons

One or two sentences a future you would want to read. The TL;DR.
```

## Conventions

- **Blameless.** "The middleware didn't validate X" — not "I forgot
  to validate X." Systems fail; people surface the failure.
- **Don't redact post-hoc.** If a customer email or specific account
  appeared during the incident, replace with `<customer-A>` /
  `<account-1234>` patterns at write-time. Never paste raw PII.
- **Link to commits / PRs / runbooks.** Postmortems are research
  material later — make the trail navigable.
- **Update the runbook.** If a runbook in `../` was either incomplete
  or wrong, fix it as part of writing the postmortem. The runbook
  should be the doc you wished you'd had.
