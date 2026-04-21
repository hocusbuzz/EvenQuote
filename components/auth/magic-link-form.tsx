'use client';

// Magic-link email form.
//
// Uses React's useFormState + useFormStatus (via useActionState in React 19;
// we're on React 18.3 here so useFormState from react-dom is the right call)
// for error display without needing a separate client-side fetch layer.
//
// On success, we navigate client-side to /check-email so the user knows
// to check their inbox — the server action itself just returns { ok: true }
// and we do the navigation here to preserve the form's useFormState.

import { useFormState, useFormStatus } from 'react-dom';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithMagicLink, type ActionResult } from '@/lib/actions/auth';

type Props = {
  // 'next' is the post-login redirect target (captured from ?next= on /login).
  next?: string;
  // Label tweak for login vs signup — auth flow is identical, just wording.
  submitLabel?: string;
};

// Submit button that disables itself during pending action.
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 w-full items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? 'Sending…' : label}
    </button>
  );
}

async function action(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return await signInWithMagicLink(formData);
}

export function MagicLinkForm({ next, submitLabel = 'Send magic link' }: Props) {
  const router = useRouter();
  const [state, formAction] = useFormState(action, null);

  // On success, bounce to /check-email (keeps the "sent" confirmation as
  // its own page, which is easier to link to and reload-safe).
  useEffect(() => {
    if (state && 'ok' in state && state.ok) {
      const params = new URLSearchParams();
      if (next) params.set('next', next);
      router.push(`/check-email${params.toString() ? `?${params}` : ''}`);
    }
  }, [state, next, router]);

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          className="flex h-10 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:opacity-50 dark:border-white/15"
        />
      </div>

      {state && 'error' in state ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton label={submitLabel} />
    </form>
  );
}
