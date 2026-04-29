'use client';

// "Retry unreached businesses" button on /admin/requests/[id].
// Fires the retryUnreachedBusinesses server action, which dispatches
// up to 5 additional calls to NEW businesses (not already dialed)
// for this quote_request.
//
// Non-destructive: doesn't change the request's status, doesn't
// touch existing calls. It adds a second mini-batch and bumps
// total_businesses_to_call so the status-advance invariant holds.

import { useState, useTransition } from 'react';
import { retryUnreachedBusinesses } from '@/lib/actions/admin';

export function RetryUnreachedButton({ requestId }: { requestId: string }) {
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setNote(null);
    setError(null);
    startTransition(async () => {
      const res = await retryUnreachedBusinesses(requestId);
      if (res.ok) {
        setNote(res.note ?? 'Dispatched.');
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={handle}
        disabled={isPending}
        className="rounded-md border-2 border-foreground/80 bg-lime px-3 py-1.5 font-mono text-xs uppercase tracking-widest hover:bg-lime-deep disabled:opacity-50"
      >
        {isPending ? 'Dispatching…' : '↻ Retry unreached (up to 5)'}
      </button>
      {note ? <p className="mt-1 text-xs text-foreground">{note}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
