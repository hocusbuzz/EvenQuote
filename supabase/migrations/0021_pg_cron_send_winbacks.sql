-- ══════════════════════════════════════════════════════════════════════
-- Migration 0021: schedule the send-winbacks cron.
--
-- Adds a 7th pg_cron job that runs DAILY at 17:00 UTC and POSTs to
-- /api/cron/send-winbacks. The route picks up satisfied past customers
-- (paid+completed quote_requests, 7-30 days old, user not yet
-- re-engaged) and emails them asking if they have another job to
-- quote. See lib/cron/send-winbacks.ts for the selection rules +
-- per-user 60-day cooldown.
--
-- Why daily at 17:00 UTC:
--   • Daily, not hourly — these are check-in emails to a satisfied
--     past customer, not transactional. Once-per-day is plenty of
--     resolution; hourly would risk an over-eager triple-fire from a
--     manual cron edit.
--   • 17:00 UTC = 10:00 PT / 13:00 ET / 09:00 BST. Hits the morning
--     business-inbox window for the largest US time-zone overlap,
--     which is where almost all of our customers live.
--   • Send budget is bounded server-side (MAX_PER_RUN=50 in the
--     handler) so even an off-by-one cron edit can't spam customers.
--
-- Reuses private.trigger_cron_route() from migration 0008 (Vault-loaded
-- secret + base URL). No code or vault changes required.
--
-- Idempotent via cron.schedule()'s upsert-by-name semantics. Safe to
-- re-run. To stop the job:
--   select cron.unschedule('evenquote-send-winbacks');
--
-- Pre-flight: this cron is a no-op until the FIRST customer crosses
-- the 7-day window (the candidate query returns zero rows otherwise).
-- Pre-launch you can verify the schedule is registered without it
-- doing anything visible.
-- ══════════════════════════════════════════════════════════════════════

select cron.schedule(
  'evenquote-send-winbacks',
  '0 17 * * *',
  $$select private.trigger_cron_route('/api/cron/send-winbacks');$$
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
  'evenquote-check-status',
  'evenquote-send-winbacks'
)
order by jrd.start_time desc;
