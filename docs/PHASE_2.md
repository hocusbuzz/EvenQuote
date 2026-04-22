# Phase 2 — Authentication & User Profiles

## Project folder structure at end of Phase 2

```
evenquote/
├── .env.example                         # updated with Phase 2 flag
├── middleware.ts                        # now real (session refresh + route guard)
├── app/
│   ├── layout.tsx, globals.css
│   ├── page.tsx                         # updated: Sign in / Dashboard CTA
│   ├── (auth)/
│   │   ├── layout.tsx                   # shared card layout
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   ├── check-email/page.tsx
│   │   └── auth-code-error/page.tsx
│   ├── auth/
│   │   ├── callback/route.ts            # code → session exchange
│   │   └── signout/route.ts             # POST signout
│   └── dashboard/page.tsx               # protected, proves auth works
├── components/auth/
│   ├── magic-link-form.tsx
│   └── google-button.tsx                # feature-flagged
├── lib/
│   ├── auth.ts                          # getUser / requireUser / requireAdmin
│   ├── actions/auth.ts                  # server actions
│   └── supabase/
│       ├── client.ts, server.ts, admin.ts
│       └── middleware.ts                # session refresh helper
└── supabase/…, scripts/…, docs/…
```

## What's new vs Phase 1

- **Middleware** (`middleware.ts` + `lib/supabase/middleware.ts`) refreshes auth
  cookies on every request and redirects unauthenticated users hitting
  `/dashboard` or `/admin` to `/login?next=<path>`.
- **Magic-link auth** using Supabase's passwordless OTP flow. Works out of the
  box — Supabase provides dev SMTP with rate limits, which is fine for testing.
- **Google OAuth wired behind a feature flag**
  (`NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED`). Button only renders when `true`.
- **Auth pages**: `/login`, `/signup`, `/check-email`, `/auth-code-error` —
  minimal styling, Phase 3 will polish with shadcn.
- **Protected `/dashboard`** that reads the profile row (confirms the
  Phase 1 DB trigger is doing its job).
- **Server-side auth helpers** in `lib/auth.ts`: `getUser`, `getProfile`,
  `requireUser`, `requireAdmin`.

## Supabase dashboard configuration

Magic link works with zero config in dev. The one setting worth verifying:

1. **Authentication → URL Configuration**
   - **Site URL**: `http://localhost:3000` (change to your prod URL later)
   - **Redirect URLs** (allow-list): add `http://localhost:3000/auth/callback`.
     In production, add your prod URL too. Supabase rejects callbacks to
     URLs not on this list.

2. **Authentication → Email Templates** (optional)
   - The default "Magic Link" template works fine. If you want to customize
     wording/branding, do it here. Keep `{{ .ConfirmationURL }}` intact.

3. **Authentication → Providers**
   - Email provider should be enabled by default. No action needed.
   - Google provider: leave disabled for now (see below).

## Enabling Google OAuth later

When you're ready:

1. **Google Cloud Console**
   - Create a project (or reuse one).
   - APIs & Services → Credentials → Create Credentials → OAuth client ID.
   - Application type: Web application.
   - Authorized redirect URI: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
     (copy the exact URL Supabase shows you on its Google provider page —
     not your app URL).
   - Note the client ID and client secret.

2. **Supabase → Authentication → Providers → Google**
   - Enable the toggle.
   - Paste client ID and client secret.
   - Save.

3. **Your app**
   - Set `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true` in `.env.local`.
   - Restart `npm run dev`.
   - "Continue with Google" button now appears on /login and /signup.

No code changes required — that's the whole point of the flag.

## Test checklist (verify before Phase 3)

- [ ] `npm run dev` starts clean on :3000
- [ ] Hitting `/dashboard` while logged out redirects to `/login?next=%2Fdashboard`
- [ ] `/login` renders the magic-link form and NO Google button (flag is off)
- [ ] Submit a real email address → success → redirects to `/check-email`
- [ ] Magic-link email arrives (check spam if not) and clicking it lands you
      on `/dashboard` (not `/login` — the `?next` was preserved)
- [ ] `/dashboard` shows your email, profile ID, role `customer`, and a
      valid "Created" timestamp
- [ ] In Supabase SQL editor, `select count(*) from profiles;` returns 1
      (or however many test users you've created). The DB trigger auto-created
      this row — confirms `handle_new_user()` is working.
- [ ] Click "Sign out" → lands on `/` with "Get started" / "Sign in" CTA
      (not "Go to dashboard") → hitting `/dashboard` again bounces to login
- [ ] Invalid email in the form shows a red error message below the input
- [ ] Hitting `/login` while logged in redirects straight to `/dashboard`
- [ ] Promote yourself to admin (run in SQL editor, replace email):
      ```sql
      update profiles set role = 'admin' where email = 'you@example.com';
      ```
      Then `/dashboard` shows `role: admin`. (No admin UI yet — that's Phase 11.)
- [ ] RLS sanity check: open a second browser (incognito) without signing in
      and try `SELECT * FROM profiles` from the Supabase SQL editor using
      the **anon key** via REST — should return empty. (Not strictly required,
      but good habit.)

## Known limitations deferred to later phases

- No email verification page beyond the magic-link itself (magic link IS the
  verification — user never typed a password)
- No profile edit UI (Phase 10 adds it to the dashboard)
- No admin role-grant UI (Phase 11 — for now, promote via SQL)
- Rate limiting on the magic-link form (Phase 12 — Supabase has built-in
  per-email rate limiting that covers the main abuse vector)
- Error states are functional but unstyled — Phase 3 prettifies everything

Once all boxes check, say **"Phase 2 complete. Proceed to Phase 3."**
