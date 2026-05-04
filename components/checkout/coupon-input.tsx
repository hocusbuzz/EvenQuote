'use client';

// "Have a coupon code?" collapsible input on the checkout page.
//
// Defaults to collapsed so the surface stays focused on the primary
// action (Pay $9.99). Expands to a single-field form on click.
// Submission either redirects to /success on a valid code or shows
// an inline error otherwise.

import { useState, useTransition } from 'react';
import { redeemCoupon } from '@/lib/actions/coupons';

export function CouponInput({ requestId }: { requestId: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await redeemCoupon({ quoteRequestId: requestId, code });
      if (res.ok) {
        // Hard navigation so the destination page server-renders
        // with the row's new 'paid' status, not a stale snapshot.
        window.location.href = res.redirectUrl;
      } else {
        setError(res.error);
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Have a coupon code?
      </button>
    );
  }

  return (
    <form onSubmit={handle} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <label htmlFor="coupon-code" className="sr-only">
        Coupon code
      </label>
      <input
        id="coupon-code"
        type="text"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="ABCD-EFGH-JKMN"
        // Match the standard input shape (16px to avoid iOS zoom-on-focus).
        className="rounded-md border-2 border-foreground/40 bg-background px-3 py-2 font-mono text-base uppercase tracking-wider placeholder:text-foreground/30 focus:border-foreground focus:outline-none sm:flex-1"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending || code.trim().length === 0}
          className="rounded-md border-2 border-foreground bg-foreground px-4 py-2 font-mono text-xs font-semibold uppercase tracking-widest text-background hover:bg-foreground/90 disabled:opacity-50"
        >
          {isPending ? 'Redeeming…' : 'Redeem'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setCode('');
            setError(null);
          }}
          className="rounded-md border-2 border-foreground/30 px-3 py-2 font-mono text-xs uppercase tracking-widest text-muted-foreground hover:bg-foreground/5"
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p
          role="alert"
          className="basis-full text-xs text-destructive sm:order-last sm:mt-1"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
