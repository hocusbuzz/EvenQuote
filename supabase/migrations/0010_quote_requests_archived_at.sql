-- ══════════════════════════════════════════════════════════════════════
-- quote_requests.archived_at — soft-delete sentinel for admin ops.
--
-- The admin UI needs a non-destructive way to hide completed /
-- uninteresting requests from the default view without removing them
-- from the system (audit trail, refund reconciliation, customer
-- support lookup all depend on the row continuing to exist).
--
-- Pattern: stamp archived_at=now() to archive; clear it (set NULL)
-- to unarchive. All admin list queries filter on archived_at IS NULL
-- by default; an "include archived" toggle passes through.
--
-- Partial index narrows the default list scan — as the table grows,
-- scanning only "active" rows in descending-created order is the hot
-- path. Archived rows stay indexable via the existing id PK.
-- ══════════════════════════════════════════════════════════════════════

alter table public.quote_requests
  add column if not exists archived_at timestamptz;

comment on column public.quote_requests.archived_at is
  'Set by admin to soft-delete. NULL = active (default admin list). '
  'Row is never physically removed — archive/unarchive is reversible.';

create index if not exists quote_requests_active_idx
  on public.quote_requests (created_at desc)
  where archived_at is null;
