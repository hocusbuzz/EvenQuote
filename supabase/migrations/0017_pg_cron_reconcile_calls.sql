-- ══════════════════════════════════════════════════════════════════════
-- Migration 0017: schedule the reconcile-calls cron.
--
-- Adds a 6th pg_cron job that ticks every 30 min and POSTs to
-- /api/cron/reconcile-calls. The route reconciles `calls` rows that are
-- stuck mid-flight because the end-of-call webhook never arrived (dead
-- tunnel in dev, deploy auth window in prod, Vapi outage). See
-- lib/cron/reconcile-calls.ts for the algorithm.
--
-- Why every 30 min and not faster:
--   • The "stuck" cutoff itself is 30 min on `started_at` — Vapi's own
--     webhook retry policy gives the delivery ~5–10 min before giving
--     up, so 30 min is comfortably past "the webhook should have fired
--     by now if it was going to." Polling at the same cadence means the
--     worst-case time between a webhook drop and reconciliation is
--     ~60 min.
--   • Vapi rate limits — we cap each tick at 50 GETs and back off on
--     a 429 by stopping the batch early. Faster ticks would burn quota
--     to no benefit since 99% of the time the table is empty.
--   • Cost — pg_cron + Vercel invocation are both negligible at this
--     cadence (~48 ticks/day, mostly returning scanned=0).
--
-- Reuses private.trigger_cron_route() from migration 0008. No vault or
-- code changes required.
--
-- Idempotent via cron.schedule()'s upsert-by-name semantics. Safe to
-- re-run. To stop the job:
--   select cron.unschedule('evenquote-reconcile-calls');
-- ══════════════════════════════════════════════════════════════════════

select cron.schedule(
  'evenquote-reconcile-calls',
  '*/30 * * * *',
  $$select private.trigger_cron_route('/api/cron/reconcile-calls');$$
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
  'evenquote-reconcile-calls'
)
order by jrd.start_time desc;
