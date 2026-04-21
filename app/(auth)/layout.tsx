// Layout for the (auth) route group: /login, /signup, /check-email, /auth-code-error.
// Route groups in Next's App Router don't affect the URL — they just let
// us share a layout across a set of pages.

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <a
            href="/"
            className="inline-block text-2xl font-bold tracking-tight text-foreground hover:opacity-80"
          >
            EvenQuote
          </a>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-6 shadow-sm sm:p-8 dark:border-white/10 dark:bg-neutral-900">
          {children}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          By continuing you agree to our Terms and Privacy Policy.
        </p>
      </div>
    </main>
  );
}
