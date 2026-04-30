-- ══════════════════════════════════════════════════════════════════════
-- quote_requests.scheduled_dispatch_at — defer dialing to local hours
--
-- Why (#117):
--   Customers can pay at any time of day (3am insomnia, lunch break,
--   weekend). Dialing a cleaning business at 3am has two costs:
--     (a) low pickup rate → wasted ~$0.20-0.50/call to voicemail
--     (b) annoys the contractor → bad-faith reputation for EvenQuote
--   Defer dispatch to Mon-Fri 9:00 AM – 4:30 PM in the SERVICE AREA's
--   local timezone (lib/scheduling/business-hours.ts resolves this from
--   the request's `state` column).
--
-- Pipeline change:
--   Before: Stripe webhook → enqueueQuoteCalls → runCallBatch → 'calling'
--   After:  Stripe webhook → enqueueQuoteCalls → check local hours
--             • IN HOURS  → runCallBatch immediately (status='calling')
--             • OUT       → set scheduled_dispatch_at, leave status='paid'
--           Cron (/api/cron/dispatch-scheduled-requests, every ~5 min)
--             picks up 'paid' rows where scheduled_dispatch_at <= now()
--             and total_calls_made = 0, then calls runCallBatch.
--
-- Column is nullable: existing rows + immediate-dispatch (in-hours) rows
-- both leave it NULL. The success page reads it to swap "calling now"
-- copy for "we'll start at 9am [local]" copy when it's set & in future.
-- ══════════════════════════════════════════════════════════════════════

alter table public.quote_requests
  add column if not exists scheduled_dispatch_at timestamptz;

comment on column public.quote_requests.scheduled_dispatch_at is
  'When non-NULL, indicates this request was paid outside the service '
  'area''s local business hours and is queued for the dispatch cron to '
  'pick up at-or-after this UTC instant. NULL on rows dispatched '
  'immediately (paid during local business hours) and on legacy rows.';

-- Hot path for the dispatch cron: find paid + scheduled + due requests.
-- Partial index keeps it tiny — only rows actually waiting for cron.
-- Excludes already-dispatched rows (total_calls_made > 0) so a cron
-- replay after dispatch is a no-op on the index scan.
create index if not exists quote_requests_scheduled_dispatch_idx
  on public.quote_requests (scheduled_dispatch_at)
  where status = 'paid'
    and scheduled_dispatch_at is not null
    and total_calls_made = 0;
