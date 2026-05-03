-- ══════════════════════════════════════════════════════════════════════
-- Migration 0020: win-back email tracking column on quote_requests.
--
-- Adds `win_back_sent_at TIMESTAMPTZ` so the send-winbacks cron can
-- (a) identify which paid+completed requests have already been used as
-- win-back triggers and (b) enforce the per-user cooldown so a single
-- customer with multiple historical requests doesn't get re-engaged
-- N times.
--
-- Why on quote_requests vs profiles: a customer can place several
-- quote_requests over time. We trigger ONE win-back per customer per
-- cooldown window, anchored on whichever recent request was the
-- most-recent-eligible. Stamping on quote_requests gives us the audit
-- trail of "which request triggered which send" without needing a
-- separate notifications table. Querying for the per-user cooldown is
-- a NOT EXISTS subquery on the same table — see lib/cron/send-winbacks.ts.
--
-- Idempotent via `if not exists`. Safe to re-run.
-- ══════════════════════════════════════════════════════════════════════

alter table public.quote_requests
  add column if not exists win_back_sent_at timestamptz;

-- Partial index — only the rows we'll actually filter against.
-- Selecting "not yet sent" is the common cron path, so a partial
-- index on the NULL set is the right shape. Once a row's win-back
-- has been sent it never gets re-checked, so it doesn't need an
-- index entry.
create index if not exists quote_requests_win_back_pending_idx
  on public.quote_requests (created_at)
  where win_back_sent_at is null
    and status = 'completed'
    and user_id is not null;

comment on column public.quote_requests.win_back_sent_at is
  'When the send-winbacks cron emailed this request''s owner asking '
  'if they want to start another quote. NULL = not yet sent. Stamped '
  'AFTER successful email send so a Resend failure leaves the row '
  'eligible for the next cron tick.';
