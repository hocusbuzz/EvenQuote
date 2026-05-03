-- ══════════════════════════════════════════════════════════════════════
-- Migration 0019: schedule the check-status cron.
--
-- Adds a 6th pg_cron job that ticks every 15 min and POSTs to
-- /api/cron/check-status. The route exercises Stripe + Vapi + Resend
-- with cheap authenticated probes (customers.list, GET /account, GET
-- /domains) and returns 503 + Sentry-captures when any integration
-- probe fails. The route handler exists since pre-launch but was
-- never actually scheduled — the file system had it, the Postgres
-- scheduler did not. This migration closes that gap.
--
-- Why this matters NOW: paid traffic about to ramp. Three silent
-- failure modes that only surface AFTER a customer hits the funnel:
--   • Stripe key rotated / revoked → checkout 500s, no payments
--     processed, all paid-traffic spend wasted.
--   • Vapi key rotated / out of credits → /api/vapi/dispatch 401s,
--     calls never placed, customer paid $9.99 for silence.
--   • Resend key revoked / domain unverified → reports never sent,
--     row sits in 'processing' indefinitely, customer paid for nothing.
--
-- Without this cron, we'd discover any of those via a cold Sentry
-- capture from inside the Stripe webhook OR a customer support
-- ticket — by which point the damage is done. With it, we find out
-- within 15 min and have a chance to rotate the key before more
-- customers hit the broken path.
--
-- Why every 15 min: matches the check-stuck-requests cadence (also
-- 15 min) so the failure-detection window for both ops surfaces is
-- the same. Faster (every 5 min) would burn API quota on three
-- providers without faster real-world action — the operator isn't
-- watching the dashboard between ticks anyway. Slower (every 30 min)
-- means a brand-new customer could pay during a Stripe outage with
-- 30+ min of detection lag.
--
-- Reuses private.trigger_cron_route() from migration 0008. Idempotent
-- via cron.schedule()'s upsert-by-name semantics. Safe to re-run.
-- To stop the job:
--   select cron.unschedule('evenquote-check-status');
-- ══════════════════════════════════════════════════════════════════════

select cron.schedule(
  'evenquote-check-status',
  '*/15 * * * *',
  $$select private.trigger_cron_route('/api/cron/check-status');$$
);

-- ── refresh the ops view to include the new job ──────────────────────
create or replace view private.evenquote_cron_history as
select
  j.jobname,
  jrd.status,
  jrd.return_message,
  jrd.start_time,
  jrd.end_time,
  jrd.end_time - jrd.start_time as duration
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname in (
  'evenquote-retry-failed-calls',
  'evenquote-send-reports',
  'evenquote-check-stuck-requests',
  'evenquote-dispatch-scheduled-requests',
  'evenquote-reconcile-calls',
  'evenquote-check-status'
)
order by jrd.start_time desc;
