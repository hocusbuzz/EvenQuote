'use client';

// "Resend report" button on /admin/requests/[id].
//
// Re-renders the report email from CURRENT DB state and sends it
// again to the request's recipient. Used when the customer says
// they didn't get the original (spam, deleted, lost). Each click
// sends one extra email — the action does NOT dedupe (the operator's
// intent IS to send another copy). Confirm dialog is the human guard.

import { useState, useTransition } from 'react';
import { resendReportEmail } from '@/lib/actions/admin';

export function ResendReportButton({ requestId }: { requestId: string }) {
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    if (
      !window.confirm(
        'Re-render the report from current data and email it again? Each click sends one new email.'
      )
    ) {
      return;
    }
    setNote(null);
    setError(null);
    startTransition(async () => {
      const res = await resendReportEmail(requestId);
      if (res.ok) {
        setNote(res.note ?? 'Sent.');
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
        className="rounded-md border-2 border-foreground/80 bg-cream px-3 py-1.5 font-mono text-xs uppercase tracking-widest hover:bg-foreground/5 disabled:opacity-50"
      >
        {isPending ? 'Sending…' : '✉ Resend report'}
      </button>
      {note ? <p className="mt-1 text-xs text-foreground">{note}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
