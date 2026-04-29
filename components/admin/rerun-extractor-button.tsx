'use client';

// "Re-run extractor" button on /admin/requests/[id].
//
// Walks every completed call on this request that doesn't already
// have a quotes row and fires the Anthropic extractor again. Useful
// when the first extraction returned ok:false (prompt issue, missing
// API key, transient Anthropic outage) and you want to retry without
// re-dialing. Idempotent — quotes.call_id is unique, double-clicks
// are safe.
//
// Mirrors retry-unreached-button.tsx in shape so both buttons feel
// uniform on the admin page.

import { useState, useTransition } from 'react';
import { rerunExtractor } from '@/lib/actions/admin';

export function RerunExtractorButton({ requestId }: { requestId: string }) {
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setNote(null);
    setError(null);
    startTransition(async () => {
      const res = await rerunExtractor(requestId);
      if (res.ok) {
        setNote(res.note ?? 'Done.');
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
        {isPending ? 'Extracting…' : '↻ Re-run extractor'}
      </button>
      {note ? <p className="mt-1 text-xs text-foreground">{note}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
