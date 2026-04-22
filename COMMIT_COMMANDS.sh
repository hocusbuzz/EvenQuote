#!/bin/bash
# Run this from ~/Documents/Claude/Projects/EvenQuote in your Mac Terminal.
# It removes a stale git lock left over from an earlier session, stages every
# file in the working tree (including the new lib/cron/ and lib/text/
# directories the 6 patches depend on), and creates the initial commit with
# a message documenting each fix.
#
# Safe to re-run: after the commit lands, running it again will just say
# "nothing to commit, working tree clean".

set -e

cd "$(dirname "$0")"

# 1. Clear the stale lock from the previous session. The Cowork sandbox
#    cannot delete files under .git/ (filesystem permission), so we do
#    this from the host.
rm -f .git/index.lock .git/tbQ9pcr

# 2. Stage everything. The patches touch 8 files and add 2 new ones
#    (lib/text/pii.ts and lib/cron/send-reports.ts — both currently
#    untracked).
git add -A

# 3. Commit.
git commit -m "Fix 6 production bugs: webhook double-counting, auth fail-open, PII leak, Stripe race, false refund promise, silent enum mismatch

1. app/api/vapi/webhook/route.ts
   Terminal-status short-circuit now covers completed | failed | no_answer
   | refused. Vapi retries of a no_answer/refused call no longer double-
   fire apply_call_end, which was advancing quote_requests to 'processing'
   before the real last call landed.

2. lib/calls/vapi.ts
   verifyVapiWebhook() hard-fails in production when VAPI_WEBHOOK_SECRET
   is unset. Previously fell open — any unauthenticated POST was accepted,
   turning the webhook into a write surface against the service-role
   Supabase client. Dev still accept-all-with-warning for local testing.

3. lib/text/pii.ts (new) + app/get-quotes/checkout/page.tsx +
   app/get-quotes/success/page.tsx
   Contact email on guest-URL pages is now masked (b*************@hotmail.com).
   These pages live behind a UUID/session_id in the URL; any referrer leak
   or shoulder-surf previously exposed the full inbox address.

4. app/get-quotes/success/page.tsx
   New 'pending-webhook' state with a <meta http-equiv=refresh content=3>
   card. When Stripe's redirect beats our /api/stripe/webhook POST by a
   second or two (common), paying customers no longer 404 — the page
   auto-polls until the payments row lands.

5. lib/cron/send-reports.ts + lib/email/templates.ts
   Zero-quote path now actually refunds the \$9.99 via
   stripe.refunds.create() with idempotencyKey 'refund-zero-quotes-<paymentId>',
   then marks payments.status='refunded'. New RefundOutcome type
   (issued | pending_support | not_applicable) drives email copy so we
   never promise a refund we didn't issue.

6. app/api/stripe/webhook/route.ts
   Payments insert writes status='completed' (matches payment_status enum:
   pending | completed | failed | refunded). Previously wrote 'paid',
   which the enum doesn't include — every live insert was silently
   failing with Postgres 22P02. Root cause of missing payments rows
   despite Stripe confirming successful charges."

echo
echo "✓ Committed. Inspect with: git log -1"
