'use client';

// Live activity panel on /dashboard/requests/[id].
//
// During the 60-90 min wait between checkout and the report email, the
// customer is staring at a static page that says "we'll email you."
// First-week customers form recommend / no-recommend opinions in this
// silence window. This panel turns silence into pizza-tracker UX.
//
// HOW IT WORKS
// ────────────
// On mount, opens a Supabase Realtime channel scoped to this request:
//   • UPDATE on quote_requests where id=eq.<reqId>
//     → status flips, counter bumps (calls done / quotes collected)
//   • INSERT/UPDATE on calls where quote_request_id=eq.<reqId>
//     → per-call status: queued → calling → completed/failed/no_answer
//
// RLS gates the subscription server-side: a user can only subscribe to
// their own request's rows. The browser Supabase client carries the
// session cookie; the channel inherits it.
//
// VISIBILITY
// ──────────
// Hidden when the request is terminal (completed / failed / refunded).
// At that point the static quotes list (or empty state) is the
// authoritative view. Showing live activity on a finished request
// would be misleading — the cron isn't going to call anyone else.
//
// FAILURE MODES
// ─────────────
// If the channel fails to connect or drops mid-session, we display a
// small "Reconnecting…" badge instead of crashing. The static
// initial state stays visible — stale, but not broken. Supabase's
// client retries internally; we don't add a manual retry layer.
//
// NEW-CALL BUSINESS NAME LOOKUP
// ─────────────────────────────
// Realtime fires for INSERT events on calls, but the row only carries
// business_id, not the joined business.name. We do a one-shot
// businesses.select on insert so the new row renders with a real name
// instead of a UUID. Cached client-side so a later UPDATE on the same
// row reuses it.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import {
  callStatusDisplay,
  shouldShowLiveActivity,
} from '@/lib/dashboard/live-activity';

export type LiveCallRow = {
  id: string;
  business_id: string;
  status: string;
  business_name: string;
  cost: number | null;
  duration_seconds: number | null;
  ended_at: string | null;
  created_at: string;
};

export type LiveRequestState = {
  status: string;
  total_calls_completed: number;
  total_quotes_collected: number;
  total_businesses_to_call: number;
};

type Props = {
  requestId: string;
  initialCalls: LiveCallRow[];
  initialRequest: LiveRequestState;
};

// Local minimal shape of a calls row coming off Realtime — we only
// touch the fields LiveCallRow needs.
type CallsRowFromRealtime = {
  id: string;
  business_id: string;
  status: string;
  cost: number | null;
  duration_seconds: number | null;
  ended_at: string | null;
  created_at: string;
};

export function LiveStatus({ requestId, initialCalls, initialRequest }: Props) {
  const [calls, setCalls] = useState<LiveCallRow[]>(initialCalls);
  const [request, setRequest] = useState<LiveRequestState>(initialRequest);
  // 'idle' before the channel handshake completes; flips to 'live' on
  // SUBSCRIBED and 'reconnecting' on any error/timeout/closed event.
  const [channelState, setChannelState] = useState<
    'idle' | 'live' | 'reconnecting'
  >('idle');

  // Cache business_id → name so a later UPDATE on a row inserted
  // mid-session can render the friendly name without re-fetching.
  // useRef so updating it doesn't re-trigger the subscription effect.
  const businessNameCache = useRef<Map<string, string>>(
    new Map(initialCalls.map((c) => [c.business_id, c.business_name])),
  );

  useEffect(() => {
    const supabase = createClient();

    // Look up a business name for a call inserted via Realtime.
    // Best-effort — if it fails, the row keeps its placeholder.
    async function resolveBusinessName(businessId: string): Promise<string> {
      const cached = businessNameCache.current.get(businessId);
      if (cached) return cached;
      const { data } = await supabase
        .from('businesses')
        .select('name')
        .eq('id', businessId)
        .maybeSingle();
      const name = data?.name ?? 'Local pro';
      businessNameCache.current.set(businessId, name);
      return name;
    }

    const channel = supabase
      .channel(`request-${requestId}`)
      // calls rows for THIS request — RLS enforces the user can only
      // see their own.
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'calls',
          filter: `quote_request_id=eq.${requestId}`,
        },
        async (
          payload: RealtimePostgresChangesPayload<CallsRowFromRealtime>,
        ) => {
          if (payload.eventType === 'DELETE') return;
          const row = payload.new;
          if (!row || !row.id) return;
          const name = await resolveBusinessName(row.business_id);
          const next: LiveCallRow = {
            id: row.id,
            business_id: row.business_id,
            status: row.status,
            business_name: name,
            cost: row.cost,
            duration_seconds: row.duration_seconds,
            ended_at: row.ended_at,
            created_at: row.created_at,
          };
          setCalls((prev) => {
            const idx = prev.findIndex((c) => c.id === next.id);
            if (idx === -1) return [...prev, next];
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
          });
        },
      )
      // Status + counter changes on the parent request.
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'quote_requests',
          filter: `id=eq.${requestId}`,
        },
        (payload: RealtimePostgresChangesPayload<LiveRequestState>) => {
          // Supabase types `payload.new` as `T | {}` to cover DELETE
          // events. We filter to UPDATE above, so it's always T at
          // runtime — narrow via a discriminated cast on `status`.
          if (payload.eventType !== 'UPDATE') return;
          const next = payload.new as LiveRequestState;
          if (!next || !next.status) return;
          setRequest({
            status: next.status,
            total_calls_completed: next.total_calls_completed ?? 0,
            total_quotes_collected: next.total_quotes_collected ?? 0,
            total_businesses_to_call: next.total_businesses_to_call ?? 0,
          });
        },
      )
      .subscribe((status) => {
        // Supabase emits 'SUBSCRIBED' on success; on failure modes
        // (CHANNEL_ERROR, TIMED_OUT, CLOSED) we show "Reconnecting…"
        // and let the client library retry internally.
        if (status === 'SUBSCRIBED') {
          setChannelState('live');
        } else if (status === 'CLOSED') {
          // CLOSED happens during cleanup (unmount) too — don't flag
          // it as a problem if the component is unmounting.
          setChannelState((prev) => (prev === 'live' ? 'reconnecting' : prev));
        } else {
          setChannelState('reconnecting');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [requestId]);

  const visible = shouldShowLiveActivity(request.status);

  // Sort by created_at so newest calls go to the bottom — visually
  // matches "the system is working through a list."
  const sortedCalls = useMemo(
    () =>
      [...calls].sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      ),
    [calls],
  );

  if (!visible) return null;

  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-5 text-card-foreground">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-semibold">Live activity</h2>
        <ChannelBadge state={channelState} />
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        {request.total_calls_completed}/{request.total_businesses_to_call ?? 0}{' '}
        call{request.total_businesses_to_call === 1 ? '' : 's'} done ·{' '}
        {request.total_quotes_collected} quote
        {request.total_quotes_collected === 1 ? '' : 's'} collected
      </p>

      {sortedCalls.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Lining up the call list — first call goes out within a couple of
          minutes.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {sortedCalls.map((c) => (
            <CallRow key={c.id} call={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CallRow({ call }: { call: LiveCallRow }) {
  const display = callStatusDisplay(call.status);
  const toneClass =
    display.tone === 'positive'
      ? 'text-green-700'
      : display.tone === 'negative'
        ? 'text-amber-700'
        : 'text-muted-foreground';
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="truncate">{call.business_name}</span>
      <span className={`shrink-0 text-xs font-mono uppercase tracking-widest ${toneClass}`}>
        {display.label}
      </span>
    </li>
  );
}

function ChannelBadge({ state }: { state: 'idle' | 'live' | 'reconnecting' }) {
  if (state === 'live') {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
        Live
      </span>
    );
  }
  if (state === 'reconnecting') {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Reconnecting…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      Connecting…
    </span>
  );
}
