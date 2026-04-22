-- ════════════════════════════════════════════════════════════════════════
-- EvenQuote — one-shot prod setup.  Paste this WHOLE file into your
-- Supabase SQL editor and hit Run.  Safe to re-run (everything is
-- idempotent).
--
-- What it does:
--   (1) Applies migration 0008 — enables pg_cron + pg_net, creates the
--       private.trigger_cron_route() helper, schedules the two jobs.
--   (2) Stores evenquote_app_url + evenquote_cron_secret in Supabase
--       Vault so the scheduled jobs can authenticate against the Next.js
--       cron routes.
--   (3) Prints verification rows so you can confirm success.
--
-- Where to run it:
--   Supabase dashboard → your project → SQL editor (left sidebar) →
--   "+ New query" → paste this whole file → Run.
-- ════════════════════════════════════════════════════════════════════════

-- ─── (1) migration 0008_pg_cron_setup.sql ───────────────────────────────
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

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
    raise warning 'private.trigger_cron_route: evenquote_app_url or evenquote_cron_secret not set in vault; skipping %', p_path;
    return null;
  end if;

  v_base_url := rtrim(v_base_url, '/');

  select net.http_post(
    url     := v_base_url || p_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function private.trigger_cron_route(text) from public;
revoke all on function private.trigger_cron_route(text) from anon;
revoke all on function private.trigger_cron_route(text) from authenticated;

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

-- ─── (2) Vault secrets ──────────────────────────────────────────────────
-- create_secret is insert-only; if a secret already exists, update instead.
do $vault$
declare
  v_url_exists boolean;
  v_sec_exists boolean;
begin
  select exists(select 1 from vault.secrets where name = 'evenquote_app_url')
    into v_url_exists;
  select exists(select 1 from vault.secrets where name = 'evenquote_cron_secret')
    into v_sec_exists;

  if v_url_exists then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'evenquote_app_url'),
      'https://evenquote.com'
    );
  else
    perform vault.create_secret('https://evenquote.com', 'evenquote_app_url');
  end if;

  if v_sec_exists then
    perform vault.update_secret(
      (select id from vault.secrets where name = 'evenquote_cron_secret'),
      'EfoPWjYhd6n3BpLUrJvmVrynProU1Ii3hYbbMroZACyJEvFpQW__riXpODHRpeCd'
    );
  else
    perform vault.create_secret(
      'EfoPWjYhd6n3BpLUrJvmVrynProU1Ii3hYbbMroZACyJEvFpQW__riXpODHRpeCd',
      'evenquote_cron_secret'
    );
  end if;
end
$vault$;

-- ─── (3) verification ───────────────────────────────────────────────────
-- Expect: two rows in cron.job, both active=true; two rows with the
-- vault names; both secrets return non-null decrypted_secret.
select jobname, schedule, active from cron.job where jobname like 'evenquote-%' order by jobname;
select name, length(decrypted_secret) as secret_length
  from vault.decrypted_secrets
  where name in ('evenquote_app_url', 'evenquote_cron_secret')
  order by name;
