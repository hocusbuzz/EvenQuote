'use client';

// Email capture for verticals we haven't built yet.
//
// Used on /get-quotes/handyman and /get-quotes/lawn-care. ZIP is
// optional — capturing it helps us prioritize which metros to seed
// first when we do ship the vertical. Success state is terminal (no
// clear-and-retry) so the confirmation actually feels like confirmation.

import { useState, useTransition } from 'react';
import { joinWaitlist } from '@/lib/actions/waitlist';
import { FormField } from './form-field';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

type Props = {
  categorySlug: string;
  categoryName: string;
  /** One-sentence note about what this vertical will look like. */
  description: string;
};

export function WaitlistCapture({
  categorySlug,
  categoryName,
  description,
}: Props) {
  const [email, setEmail] = useState('');
  const [zip, setZip] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ alreadyOnList: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await joinWaitlist({
        categorySlug,
        email,
        zipCode: zip || undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone({ alreadyOnList: result.alreadyOnList });
    });
  };

  if (done) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        <p className="label-eyebrow mb-3">
          {done.alreadyOnList ? 'Already on the list' : 'You\'re on the list'}
        </p>
        <h2 className="font-display text-3xl font-bold tracking-tight">
          We'll email you when {categoryName.toLowerCase()} goes live.
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          We're prioritizing metros by signup density — more signups in your ZIP means
          we'll launch there first.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6 sm:p-8">
      <p className="label-eyebrow mb-3">Coming soon</p>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {categoryName} quotes are on the way.
      </h2>
      <p className="mt-3 text-muted-foreground">{description}</p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5">
        <FormField label="Email" htmlFor="wl_email" required>
          <Input
            id="wl_email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </FormField>

        <FormField
          label="ZIP code"
          htmlFor="wl_zip"
          hint="Optional — helps us pick launch cities."
        >
          <Input
            id="wl_zip"
            inputMode="numeric"
            autoComplete="postal-code"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            placeholder="92101"
          />
        </FormField>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}

        <Button type="submit" variant="lime" disabled={isPending} className="w-full sm:w-auto">
          {isPending ? 'Adding you…' : 'Notify me when it\'s live'}
        </Button>
      </form>
    </div>
  );
}
