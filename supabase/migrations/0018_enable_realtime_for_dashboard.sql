-- ══════════════════════════════════════════════════════════════════════
-- Migration 0018: enable Supabase Realtime on the dashboard tables.
--
-- The /dashboard/requests/[id] live-activity panel (Tier 1 backlog #4,
-- shipped in commit 7fa56e1) subscribes to:
--   • UPDATE on public.quote_requests for status + counter changes
--   • INSERT/UPDATE on public.calls for per-call status badges
--
-- Realtime listens on the `supabase_realtime` publication. A table only
-- emits change events to subscribed clients once it's a member of that
-- publication — and Supabase ships projects with the publication empty.
-- Without this migration, the live panel renders the SSR seed exactly
-- once and then silently never updates (the channel connects but no
-- events ever arrive).
--
-- RLS is the access boundary, NOT publication membership. The existing
-- policies — `quote_requests: owner read` and `calls: owner read via
-- request` — gate what each subscriber can see; this migration just
-- turns on the firehose those policies filter from.
--
-- Idempotent: `alter publication ... add table` errors if the table is
-- already a member, so we wrap each statement in a DO block that swallows
-- the duplicate-object error code (42710). Safe to re-run.
--
-- To revert (e.g., disable live updates):
--   alter publication supabase_realtime drop table public.quote_requests;
--   alter publication supabase_realtime drop table public.calls;
-- ══════════════════════════════════════════════════════════════════════

do $$
begin
  alter publication supabase_realtime add table public.quote_requests;
exception
  when duplicate_object then
    raise notice 'supabase_realtime already includes public.quote_requests — skipping';
end $$;

do $$
begin
  alter publication supabase_realtime add table public.calls;
exception
  when duplicate_object then
    raise notice 'supabase_realtime already includes public.calls — skipping';
end $$;
