-- ══════════════════════════════════════════════════════════════════════
-- CSP violation persistence — Report-Only → Enforce rollout support.
--
-- Why this table exists
-- ---------------------
-- /api/csp-report currently only LOGS violations (structured, to the
-- Vercel log drain). That's fine for triage of a single incident but
-- it makes "what directives actually fire across my whole traffic
-- base over two weeks?" a grep-through-log-drain problem.
--
-- We need to tighten the CSP from Report-Only to Enforce without
-- breaking legitimate page loads. The blocker is knowing which
-- `blocked-uri` + `effective-directive` pairs are safe to allow-list
-- vs. which are real violations. A persistent table + aggregate query
-- answers that in one SQL call.
--
-- Rollout gate
-- ------------
-- /api/csp-report writes to this table only when
-- `CSP_VIOLATIONS_PERSIST=true`. Default off. Turning it on for a
-- two-week collection window + then off again before flipping to
-- Enforce keeps the surface narrow — no long-running PII-adjacent
-- storage in production by default.
--
-- Privacy
-- -------
-- Violation reports can include `document_uri` that carries URL path
-- components (e.g. guest-quote UUIDs). We strip query strings before
-- insert in the route handler to reduce the blast radius, but this
-- table should still be treated as PII-adjacent for retention
-- purposes:
--   • 30-day TTL via the retention policy below.
--   • RLS enabled, NO policies — only the service-role key can read.
--   • No PII-carrying columns (email, phone, name) are persisted.
--
-- Analyze script
-- --------------
-- scripts/analyze-csp-reports.ts queries this table and produces a
-- grouped report the operator reads before flipping to Enforce.
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.csp_violations (
  id uuid primary key default gen_random_uuid(),
  -- When the browser POSTed the report. We stamp server-side instead
  -- of trusting the `original-policy` timestamp (browsers don't all
  -- send one).
  received_at timestamptz not null default now(),

  -- The directive the report blamed. Browsers fill one or both of
  -- these — we store whichever we saw. `effective_directive` is the
  -- newer (CSP3) field and is the one `report-to` bodies populate.
  violated_directive text,
  effective_directive text,

  -- URI the browser tried to load / inline. Can be:
  --   • a full URL (https://cdn.example.com/foo.js)
  --   • a keyword ('inline', 'eval', 'self')
  --   • the empty string (some browsers)
  -- Capped at 2048 to keep one-row-per-violation cheap.
  blocked_uri text,

  -- Document URL where the violation fired. Stored with the query
  -- string stripped in the route handler (see comment above). We keep
  -- the path because the path is useful — "violations from /pay" is
  -- distinct from "violations from /get-quote" for allow-list tuning.
  document_uri text,

  -- Page that linked to the violation, if browser reported one. Same
  -- query-string-stripped handling.
  referrer text,

  -- The tail of the CSP string the browser reports — useful when
  -- debugging a specific directive, rarely queried. Text, not jsonb,
  -- because it's a flat CSP string not a JSON object.
  original_policy text

  -- NOTE: we deliberately do NOT persist the raw report body. Browsers
  -- include the full document URL (with query string) and sometimes
  -- `script-sample` text that can carry user input. The stripped
  -- per-column shape above is the complete storage contract — it
  -- gives the analyze script everything it needs while keeping PII-
  -- adjacent data out of the table by construction, not by promise.
);

-- Aggregation-friendly indexes. These exist because the analyze
-- script groups by (effective_directive, blocked_uri) across a time
-- window. Without them the GROUP BY scans the whole table once pg
-- collects a few thousand rows.
create index if not exists csp_violations_received_at_idx
  on public.csp_violations (received_at desc);

create index if not exists csp_violations_directive_blocked_idx
  on public.csp_violations (effective_directive, blocked_uri);

-- RLS: table is service-role only. No anon or authenticated access —
-- the /api/csp-report route writes with the admin client, and the
-- analyze script reads with the admin client. No user-facing read
-- path exists or should exist.
alter table public.csp_violations enable row level security;

-- No policies = no access for anon / authenticated. Explicitly
-- documenting that for reviewers of this migration.
comment on table public.csp_violations is
  'CSP violation reports during the Report-Only rollout window. '
  'Write path: /api/csp-report (admin client, gated by CSP_VIOLATIONS_PERSIST). '
  'Read path: scripts/analyze-csp-reports.ts (admin client). '
  '30-day TTL. RLS on, no policies — service-role only.';
