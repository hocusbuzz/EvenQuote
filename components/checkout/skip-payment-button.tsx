'use client';

// Dev-only "Skip payment" button. POSTs to /api/dev/skip-payment
// (which is itself gated to non-production) and redirects to the
// success page on completion.
//
// The parent page only RENDERS this component when NODE_ENV !==
// 'production' — see checkout/page.tsx — so this component doesn't
// need its own gate. The API endpoint double-checks regardless.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function SkipPaymentButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = () => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/dev/skip-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quote_request_id: requestId }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string; note?: string };
        if (!res.ok || !body.ok) {
          setError(body.error ?? body.note ?? `HTTP ${res.status}`);
          return;
        }
        router.push(`/get-quotes/success?request=${requestId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={handle}
        disabled={isPending}
        className="w-full rounded-md border-2 border-dashed border-ink/60 bg-background px-4 py-2 font-mono text-xs uppercase tracking-widest text-muted-foreground hover:bg-lime/30 disabled:opacity-50"
      >
        {isPending ? 'Skipping…' : '⚡ Skip payment (dev only)'}
      </button>
      {error ? (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      ) : (
        <p className="mt-2 text-center text-[11px] uppercase tracking-widest text-muted-foreground">
          Bypasses Stripe. Only rendered when NODE_ENV !== production.
        </p>
      )}
    </div>
  );
}
