'use client';

// The "Pay $9.99" button on the checkout page.
//
// Responsibilities:
//   1. Call the createCheckoutSession server action with the request id.
//   2. On success: window.location.href = url (full navigation — we want
//      the browser to do a top-level redirect to Stripe, not a client-side
//      route transition).
//   3. If the server tells us the request is already paid, route to the
//      success page instead of creating another session.
//   4. On error: show an inline error banner and re-enable the button.
//
// Why a client component at all?
//   Because server components can't do window.location.href. We need to
//   bounce the whole browser to Stripe's hosted checkout URL. The *action*
//   itself runs server-side (so we never expose the Stripe secret key);
//   this component is just the thin trigger + redirect shim.
//
// useTransition vs local loading state:
//   useTransition lets us keep the UI responsive (it doesn't block
//   rendering) and gives us isPending out of the box. We combine it with
//   an explicit "submitted" flag so that after a successful redirect-kick
//   we keep the button disabled — the page is about to navigate away and
//   we don't want a double-click racing the redirect.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { createCheckoutSession } from '@/lib/actions/checkout';

type Props = {
  requestId: string;
  price: string;
};

export function PayButton({ requestId, price }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);

    startTransition(async () => {
      const result = await createCheckoutSession({ requestId });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if ('alreadyPaid' in result) {
        // Soft-redirect — no need to blow away the SPA for an internal hop.
        router.replace(`/get-quotes/success?request=${result.requestId}`);
        return;
      }

      // Success: bounce the browser to Stripe. Keep the button disabled
      // so a frantic second click doesn't try to re-create the session.
      setSubmitted(true);
      window.location.href = result.url;
    });
  }

  const disabled = isPending || submitted;

  return (
    <div>
      <Button
        type="button"
        variant="lime"
        size="xl"
        onClick={handleClick}
        disabled={disabled}
        aria-busy={disabled}
        className="w-full sm:w-auto"
      >
        {submitted
          ? 'Redirecting to Stripe…'
          : isPending
            ? 'Starting checkout…'
            : `Pay ${price}`}
      </Button>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
