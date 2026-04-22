// /login
//
// Magic-link first, Google OAuth below (when enabled). Captures ?next=
// from the URL so users land back where they came from after auth.

import Link from 'next/link';
import { MagicLinkForm } from '@/components/auth/magic-link-form';
import { GoogleButton, AuthDivider } from '@/components/auth/google-button';

type SearchParams = { [key: string]: string | string[] | undefined };

export default function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const rawNext = typeof searchParams.next === 'string' ? searchParams.next : undefined;

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Enter your email and we'll send you a magic link.
      </p>

      <MagicLinkForm next={rawNext} submitLabel="Send magic link" />
      <AuthDivider />
      <GoogleButton next={rawNext} />

      <p className="mt-6 text-sm text-muted-foreground">
        New here?{' '}
        <Link
          href={rawNext ? `/signup?next=${encodeURIComponent(rawNext)}` : '/signup'}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </>
  );
}
