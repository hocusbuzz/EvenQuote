'use client';

// Google OAuth button.
//
// Feature-flagged via NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED. The button simply
// doesn't render when the flag is off, so there's no confusing "disabled"
// state or broken-link UX. To turn it on:
//   1. In Google Cloud, create OAuth 2.0 credentials (Web app).
//   2. In Supabase → Auth → Providers, enable Google with the client ID/secret.
//   3. Set NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true in env.
//
// See docs/PHASE_2.md for the full walk-through.

import { useFormState, useFormStatus } from 'react-dom';
import { signInWithGoogle, type ActionResult } from '@/lib/actions/auth';

type Props = { next?: string };

function Button() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-black/15 bg-white px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-neutral-800 dark:text-white dark:hover:bg-neutral-700"
    >
      {/* Inline SVG — no extra dependency for a single icon */}
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.58 2.7-3.9 2.7-6.62z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
        />
        <path
          fill="#FBBC05"
          d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
        />
      </svg>
      {pending ? 'Redirecting…' : 'Continue with Google'}
    </button>
  );
}

async function action(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return await signInWithGoogle(formData);
}

// Inner component that actually uses hooks. Only mounts when the flag
// is on — keeps hook ordering consistent (no conditional hook calls).
function GoogleButtonInner({ next }: Props) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form action={formAction}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Button />
      {state && 'error' in state ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function GoogleButton({ next }: Props) {
  // Reading NEXT_PUBLIC_* at module level is fine — these are inlined at build time.
  if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== 'true') {
    return null;
  }
  return <GoogleButtonInner next={next} />;
}

// A separator shown only when Google is enabled, so /login and /signup
// don't render an orphaned "or" line.
export function AuthDivider() {
  if (process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED !== 'true') {
    return null;
  }
  return (
    <div className="relative my-4">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-black/10 dark:border-white/10" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-white px-2 text-muted-foreground dark:bg-neutral-900">or</span>
      </div>
    </div>
  );
}
