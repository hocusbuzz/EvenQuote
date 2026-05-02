'use client';

// "Refund now" button on /admin/requests/[id].
//
// Fires refundRequestNow which calls Stripe refunds.create with an
// idempotency key shared with the cron's zero-quotes refund path —
// double-clicking the button or racing it against the cron is safe
// (Stripe returns the existing refund instead of creating a second).
//
// Confirm dialog because money flow is irreversible from the operator's
// POV (Stripe doesn't expose a refund-undo). Customer always benefits
// from the refund, so the worst case is "we refunded a request that
// would have completed" — embarrassing, not catastrophic.

import { useState, useTransition } from 'react';
import { refundRequestNow } from '@/lib/actions/admin';

export function RefundNowButton({ requestId }: { requestId: string }) {
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    if (
      !window.confirm(
        'Refund $9.99 to the customer via Stripe now? This is idempotent — if a refund already exists, this is a no-op.'
      )
    ) {
      return;
    }
    setNote(null);
    setError(null);
    startTransition(async () => {
      const res = await refundRequestNow(requestId);
      if (res.ok) {
        setNote(res.note ?? 'Refunded.');
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
        className="rounded-md border-2 border-foreground/80 bg-cream px-3 py-1.5 font-mono text-xs uppercase tracking-widest hover:bg-destructive/20 disabled:opacity-50"
      >
        {isPending ? 'Refunding…' : '↺ Refund $9.99'}
      </button>
      {note ? <p className="mt-1 text-xs text-foreground">{note}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
