// /auth-code-error
//
// Lands here when the callback route couldn't exchange a code for a session:
// expired link, reused link, user denied OAuth, etc. Shows the provider's
// error message when one was supplied (server-trusted, not URL-injectable
// for arbitrary HTML since we render it as text).

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Sign-in failed',
  robots: { index: false, follow: false },
};

type SearchParams = { [key: string]: string | string[] | undefined };

export default function AuthCodeErrorPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const message =
    typeof searchParams.message === 'string'
      ? searchParams.message
      : 'Your sign-in link was invalid or has expired.';

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Sign-in failed</h1>
      <p className="mb-6 text-sm text-muted-foreground">{message}</p>

      <Link
        href="/login"
        className="inline-flex h-10 w-full items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"
      >
        Try again
      </Link>
    </>
  );
}
