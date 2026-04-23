// /check-email
//
// Shown immediately after a magic link is sent. Deliberately simple —
// the user's next action is in their inbox, not here. The "resend" link
// sends them back to /login to try again.

import type { Metadata } from 'next';
import Link from 'next/link';

// Ephemeral transactional page — don't let it show up in search results.
export const metadata: Metadata = {
  title: 'Check your email',
  robots: { index: false, follow: false },
};

export default function CheckEmailPage() {
  return (
    <>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-foreground/5">
        <svg
          aria-hidden="true"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      </div>

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Check your email</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        We sent you a sign-in link. Click it from the same browser and you'll be signed in.
      </p>

      <ul className="mb-6 space-y-2 text-sm text-muted-foreground">
        <li>• The link expires in 60 minutes.</li>
        <li>• Open it in the same browser where you requested it.</li>
        <li>• Not seeing it? Check spam or promotions folders.</li>
      </ul>

      <Link
        href="/login"
        className="inline-flex h-10 w-full items-center justify-center rounded-md border border-black/15 px-4 text-sm font-medium hover:bg-foreground/5 dark:border-white/15"
      >
        Resend link
      </Link>
    </>
  );
}
