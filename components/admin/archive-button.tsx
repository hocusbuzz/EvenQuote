'use client';

// Archive / Unarchive button on /admin/requests/[id]. Wraps the
// server action so the page can pass the requestId + current
// archived state without duplicating the action-call boilerplate
// in every page that needs it.

import { useState, useTransition } from 'react';
import { setRequestArchived } from '@/lib/actions/admin';

export function ArchiveButton({
  requestId,
  archived,
}: {
  requestId: string;
  archived: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setError(null);
    startTransition(async () => {
      const res = await setRequestArchived(requestId, !archived);
      if (!res.ok) setError(res.error);
    });
  };

  const label = archived ? 'Unarchive' : 'Archive';
  const hover = archived ? 'hover:bg-lime' : 'hover:bg-destructive/20';

  return (
    <div className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={handle}
        disabled={isPending}
        className={
          'rounded-md border-2 border-foreground/60 px-3 py-1.5 font-mono text-xs uppercase tracking-widest disabled:opacity-50 ' +
          hover
        }
      >
        {isPending ? '…' : label}
      </button>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
