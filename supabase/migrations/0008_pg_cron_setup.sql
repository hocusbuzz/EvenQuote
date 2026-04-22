-- ══════════════════════════════════════════════════════════════════════
-- Migration 0008: pg_cron + pg_net setup for EvenQuote crons
--
-- Why this exists:
--   Vercel Hobby caps cron invocations at once-per-day, but our
--   /api/cron/retry-failed-calls and /api/cron/send-reports need to
--   run every 10 and 5 minutes respectively. Rather than pay for
--   Vercel Pro just for crons, we schedule them inside Postgres with
--   pg_cron and hit the Next.js routes via pg_net.http_post.
--
--   Both cron routes already accept `Authorization: Bearer <CRON_SECRET>`
--   so no application code changes are needed — only this migration and
--   the companion vercel.json cleanup.
--
-- One-time setup AFTER this migration applies (do these once, in the
-- Supabase SQL editor, then never again):
--
--   select vault.create_secret('https://evenquote.com', 'evenquote_app_url');
--   select vault.create_secret('<paste CRON_SECRET here>', 'evenquote_cron_secret');
--
-- Values can be rotated later with vault.update_secret(); the functions
-- below re-read vault on every invocation.
--
-- To stop a job:   select cron.unschedule('evenquote-retry-failed-calls');
-- To watch runs:   select * from cron.job_run_details order by start_time desc limit 20;
-- ══════════════════════════════════════════════════════════════════════

-- ── extensions ────────────────────────────────────────────────────────
-- pg_net runs in the `extensions` schema on Supabase by convention.
-- pg_cron installs into the `cron` schema.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ── private schema for helpers ────────────────────────────────────────
-- Supabase only exposes `public`, `storage`, and `graphql_public` via
-- PostgREST by default. Putting helpers in `private` keeps them off the
-- REST surface area so no client can invoke them directly.
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

-- ── helper: POST to a cron route with Vault-loaded secret ─────────────
-- Both cron routes use identical auth. Rather than write two near-
-- identical wrappers, parameterize the path.
--
-- security definer so the function (not the caller) reads vault.
-- search_path = '' prevents schema-injection via a malicious caller.
create or replace function private.trigger_cron_route(p_path text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base_url text;
  v_secret text;
  v_request_id bigint;
begin
  select decrypted_secret
    into v_base_url
    from vault.decrypted_secrets
   where name = 'evenquote_app_url';

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'evenquote_cron_secret';

  if v_base_url is null or v_secret is null then
    -- Don't raise — that would make cron.job_run_details look like a
    -- red flashing error on every tick before the operator sets
    -- secrets. Log a warning and no-op instead.
    raise warning 'private.trigger_cron_route: evenquote_app_url or evenquote_cron_secret not set in vault; skipping % ', p_path;
    return null;
  end if;

  -- Trim trailing slash on base URL to avoid accidental `//` in path.
  v_base_url := rtrim(v_base_url, '/');

  select net.http_post(
    url     := v_base_url || p_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := '{}'::jsonb,
    -- 60s matches Vercel's serverless default so we don't time out
    -- before the function's own timeout kicks in.
    timeout_milliseconds := 60000
  ) into v_request_id;

  return v_request_id;
end;
$$;

-- Lock down execution to the `postgres` role (which is what pg_cron
-- jobs run as). No anon/authenticated/public access.
revoke all on function private.trigger_cron_route(text) from public;
revoke all on function private.trigger_cron_route(text) from anon;
revoke all on function private.trigger_cron_route(text) from authenticated;

-- ── schedule jobs (idempotent via cron.schedule job name) ─────────────
-- cron.schedule() is UPSERT by job name: safe to re-run this migration.
-- Schedules mirror the previous vercel.json values exactly.

select cron.schedule(
  'evenquote-retry-failed-calls',
  '*/10 * * * *',
  $$select private.trigger_cron_route('/api/cron/retry-failed-calls');$$
);

select cron.schedule(
  'evenquote-send-reports',
  '*/5 * * * *',
  $$select private.trigger_cron_route('/api/cron/send-reports');$$
);

-- ── sanity view (optional, handy for ops) ─────────────────────────────
-- A tiny read-only view over cron.job_run_details filtered to our jobs.
-- Lives in private so it's not exposed via PostgREST; query it from
-- the SQL editor.
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
where j.jobname in ('evenquote-retry-failed-calls', 'evenquote-send-reports')
order by jrd.start_time desc;
