-- ══════════════════════════════════════════════════════════════════════
-- increment_quotes_collected RPC — bump quote_requests.total_quotes_collected
-- atomically for inbound-callback and SMS responses.
--
-- Context: Voice-call and SMS callbacks from contractors arrive AFTER
-- the outbound call they're responding to already ran apply_call_end().
-- The outbound call's counter tick represents "we reached out"; the
-- callback represents "they got back to us with a real quote". These
-- are independent events — apply_call_end() is the wrong hammer for
-- the latter because it also bumps total_calls_completed (invariant:
-- the count of completed outbound dials), which we don't want to
-- inflate with inbound responses.
--
-- This RPC does the minimum useful thing: +1 to total_quotes_collected.
-- No status transitions, no sentinels — those are handled upstream by
-- apply_call_end when the OUTBOUND batch completes.
-- ══════════════════════════════════════════════════════════════════════

create or replace function public.increment_quotes_collected(
  p_request_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_count integer;
begin
  update public.quote_requests
  set total_quotes_collected = total_quotes_collected + 1
  where id = p_request_id
  returning total_quotes_collected into v_new_count;

  return coalesce(v_new_count, -1);
end;
$$;

revoke all on function public.increment_quotes_collected(uuid) from public;
revoke all on function public.increment_quotes_collected(uuid) from anon, authenticated;
