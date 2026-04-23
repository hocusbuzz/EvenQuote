# Runbook — Resend bounced / reports not delivering

**Severity:** SEV-2. The product still works (calls completed, data
in DB) but the customer doesn't *see* the value because the email
never lands.

## Symptom

- Customer support: "I never got my report" but
  `quote_requests.status = 'completed'` and the row has matching
  `quotes` populated.
- Resend dashboard shows `bounced` or `complained` events for sends
  to your customers.
- Resend dashboard shows your sending domain reputation has dropped
  (red/yellow indicator) or the domain is "not verified".
- `cron/send-reports` log shows non-2xx responses from the Resend
  API ("invalid api key", "domain not verified", "rate limit").

## Why this is bad

The whole product narrative is "AI calls, you get a clean report by
email." If the email never lands, the customer's experience is "I
paid $9.99 for a black hole." Even if they eventually find the
dashboard, the trust dent is significant.

Worse: bounces and complaints damage the sending domain's reputation
*globally* — future legitimate sends start hitting spam folders. So
this needs a fast halt-and-investigate, not a slow fix.

## How to confirm

1. **Resend dashboard** → Logs. Filter to the last hour. What does the
   error column say?
   - `domain not verified` → DNS regression. SPF/DKIM/DMARC records
     for `evenquote.com` were removed or expired.
   - `rate limit` → too many sends in a short window; either a real
     surge or a bug enqueueing duplicates.
   - `invalid api key` → `RESEND_API_KEY` env var rotated or unset.
2. **Resend dashboard** → Domains. Is `evenquote.com` showing
   "verified" with green SPF/DKIM/DMARC? If any are red, that's the
   issue.
3. **Spot-check an affected request:** read its `quote_requests` row,
   confirm `status='completed'`, then look for a `cron/send-reports`
   log line containing the request id. If the log shows a Resend
   error string, you have your message.

## First three actions

1. **Don't retry-loop.** If sends are bouncing, stop sending. Set a
   feature flag or comment out the call site in
   `lib/cron/send-reports.ts` until you fix the root cause. Mass
   retries against a bad config tank the domain reputation.
2. **Re-verify DNS** in Resend dashboard. Run their built-in
   verification probe and fix any record that's drifted. Likely
   culprits: someone touched the DNS provider for an unrelated
   reason; the registry CNAME flattened a TXT record.
3. **Rotate the API key** if the symptom is `invalid api key`. New
   key into Vercel env, redeploy, retest with one manual send via
   the Resend playground.

## Communicate

- Affected customers: send manually (with the now-working setup)
  using a script that pulls `quote_requests` where `report_sent_at
  is null and status='completed'` and re-fires the template.
- Apologize for the delay; do not refund unless they ask. The work
  was actually done.

## After the fire is out

- Confirm Resend dashboard shows the next batch of sends as
  `delivered` (not `accepted` — accepted just means Resend took the
  job; delivered means the receiving server accepted it).
- Add `cron/send-reports` to a Sentry / log alert that pages on >1
  Resend error per run.
- If DNS drift was the cause, add a CalDAV reminder for quarterly
  DNS audits, and document the SPF/DKIM/DMARC values in
  `docs/DOMAIN_SETUP.md` so re-creation is mechanical.
- Backfill the `report_sent_at` column for the manually-sent batch so
  it doesn't double-fire next cron run.
