-- ══════════════════════════════════════════════════════════════════════
-- Migration 0014: schedule the dispatch-scheduled-requests cron (#117).
--
-- Adds a 5th pg_cron job that ticks every 5 min and POSTs to
-- /api/cron/dispatch-scheduled-requests. The route picks up requests
-- whose dispatch was deferred to local business hours and dials them
-- now. See lib/cron/dispatch-scheduled-requests.ts for the query.
--
-- Why every 5 min:
--   • Customer expectation: paid at 8:55 AM (5 min before opening) →
--     should not have to wait 15+ minutes after 9:00. 5-min polling
--     means worst-case wait past the dispatch window is ≤5 min.
--   • Cost: ~12 ticks/hour × 24h = 288 ticks/day, mostly returning
--     scanned=0. The route is cheap (one indexed query against the
--     partial scheduled-dispatch index from migration 0013).
--   • Volume bound: dispatchScheduledRequests caps at 50 rows/tick,
--     enough headroom for a typical morning rush across all timezones.
--
-- Reuses private.trigger_cron_route() from migration 0008 (Vault-loaded
-- secret + base URL). No code or vault changes required.
--
-- Idempotent via cron.schedule()'s upsert-by-name semantics. Safe to
-- re-run. To stop the job:
--   select cron.unschedule('evenquote-dispatch-scheduled-requests');
-- ══════════════════════════════════════════════════════════════════════

select cron.schedule(
  'evenquote-dispatch-scheduled-requests',
  '*/5 * * * *',
  $$select private.trigger_cron_route('/api/cron/dispatch-scheduled-requests');$$
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
  'evenquote-dispatch-scheduled-requests'
)
order by jrd.start_time desc;
