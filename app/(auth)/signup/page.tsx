// /signup
//
// Magic link creates the account on first click (shouldCreateUser: true),
// so /signup and /login use the same underlying mechanism. Keeping them
// as separate pages purely for UX / SEO / analytics.

import type { Metadata } from 'next';
import Link from 'next/link';
import { MagicLinkForm } from '@/components/auth/magic-link-form';
import { GoogleButton, AuthDivider } from '@/components/auth/google-button';

export const metadata: Metadata = {
  title: 'Sign up',
  description:
    'Create your EvenQuote account. No password — we email you a secure sign-in link.',
  robots: { index: true, follow: true },
};

type SearchParams = { [key: string]: string | string[] | undefined };

export default function SignupPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const rawNext = typeof searchParams.next === 'string' ? searchParams.next : undefined;

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        No password needed — we'll email you a secure sign-in link.
      </p>

      <MagicLinkForm next={rawNext} submitLabel="Get started" />
      <AuthDivider />
      <GoogleButton next={rawNext} />

      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link
          href={rawNext ? `/login?next=${encodeURIComponent(rawNext)}` : '/login'}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
