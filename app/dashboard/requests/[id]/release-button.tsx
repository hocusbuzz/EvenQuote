'use client';

// Client component that wraps the releaseContactToBusiness server
// action in a form with optimistic pending state. Separated into its
// own file because the page.tsx is a server component.

import { useTransition, useState } from 'react';
import { releaseContactToBusiness } from '@/lib/actions/release-contact';
import { Button } from '@/components/ui/button';

type Props = {
  quoteId: string;
  alreadyReleased: boolean;
};

export function ReleaseContactButton({ quoteId, alreadyReleased }: Props) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'done' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  if (alreadyReleased || state.kind === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-green-700">
        ✓ Contact shared
      </span>
    );
  }

  function onClick() {
    startTransition(async () => {
      const res = await releaseContactToBusiness(quoteId);
      if (res.ok) {
        setState({ kind: 'done' });
      } else {
        setState({ kind: 'error', message: res.error });
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        onClick={onClick}
        disabled={pending}
        aria-label="Share my contact with this business"
      >
        {pending ? 'Sharing…' : 'Share my contact'}
      </Button>
      {state.kind === 'error' && (
        <p className="text-xs text-red-600">{state.message}</p>
      )}
    </div>
  );
}
