'use client';

// "Mark failed" button on /admin/requests/[id].
//
// Forces the request to status='failed'. Used when a request is hung
// mid-pipeline and the operator wants to hand it off (usually paired
// with a refund click — markFailed alone just changes a label).
//
// Confirm dialog because the status flip is durable and visible to
// the customer in /dashboard. Idempotent on the server — a re-click
// that flips 'failed' → 'failed' is a no-op.

import { useState, useTransition } from 'react';
import { markFailed } from '@/lib/actions/admin';

export function MarkFailedButton({ requestId }: { requestId: string }) {
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    if (
      !window.confirm(
        "Force this request to status='failed'? This is durable and visible on the customer's dashboard."
      )
    ) {
      return;
    }
    setNote(null);
    setError(null);
    startTransition(async () => {
      const res = await markFailed(requestId);
      if (res.ok) {
        setNote(res.note ?? 'Marked failed.');
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
        {isPending ? 'Updating…' : '⚠ Mark failed'}
      </button>
      {note ? <p className="mt-1 text-xs text-foreground">{note}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
