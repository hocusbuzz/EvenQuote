-- ══════════════════════════════════════════════════════════════════════
-- Migration 0012: schedule the stuck-request watchdog cron.
--
-- Adds a 4th pg_cron job that ticks every 15 min and POSTs to
-- /api/cron/check-stuck-requests. The route emails the ops inbox
-- (EVENQUOTE_SUPPORT_EMAIL) when ≥1 quote_request has been parked past
-- its SLA — see lib/cron/check-stuck-requests.ts for thresholds.
--
-- Why every 15 min and not faster:
--   • Fastest stuck threshold is 15 min ('paid'). Polling at the same
--     frequency means worst-case detection latency is 30 min, which
--     is fine for ops alerting.
--   • Polling at 5 min would mean 4× more cron run rows + 4× more
--     "stuck rows still here" emails for the SAME unresolved issue.
--     That's spam, not signal.
--   • If stuck rows exist long enough that you get the SAME alert
--     four hours later, you'd have learned about it on the first
--     tick anyway — extra ticks are duplicate noise.
--
-- Reuses private.trigger_cron_route() from migration 0008 (Vault-loaded
-- secret + base URL). No code or vault changes required — just the
-- new cron.schedule() call.
--
-- Idempotent via cron.schedule()'s upsert-by-name semantics. Safe to
-- re-run. To stop the job:
--   select cron.unschedule('evenquote-check-stuck-requests');
-- ══════════════════════════════════════════════════════════════════════

select cron.schedule(
  'evenquote-check-stuck-requests',
  '*/15 * * * *',
  $$select private.trigger_cron_route('/api/cron/check-stuck-requests');$$
);

-- ── refresh the ops view to include the new job ──────────────────────
-- Same view shape as 0008, just adds the new job name to the filter.
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
  'evenquote-check-stuck-requests'
)
order by jrd.start_time desc;
