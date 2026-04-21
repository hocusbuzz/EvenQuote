# Phase 1 — Project Setup & Database

## 1. Project folder structure at end of Phase 1

```
evenquote/
├── .env.example
├── .env.local                    # you create this locally (gitignored)
├── .gitignore
├── next.config.mjs
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── middleware.ts                 # stub for now, real logic in Phase 2
├── app/
│   ├── layout.tsx
│   ├── page.tsx                  # placeholder landing (Phase 3 replaces)
│   └── globals.css
├── lib/
│   └── supabase/
│       ├── client.ts             # browser client
│       ├── server.ts             # server component / route handler client
│       └── admin.ts              # service-role client (server-only)
├── supabase/
│   ├── migrations/
│   │   └── 0001_initial_schema.sql
│   └── seed/
│       ├── 0001_service_categories.sql
│       └── 0002_sample_businesses.sql
├── scripts/
│   └── verify-db.ts              # sanity check script
└── docs/
    └── PHASE_1.md                # this file
```

## 2. Initialize the project

Run these commands in the directory where you want the project to live.
Do NOT let `create-next-app` ask interactively — the flags below lock the choices.

```bash
npx create-next-app@latest evenquote \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir=false \
  --import-alias="@/*" \
  --use-npm \
  --no-turbopack

cd evenquote

# Core dependencies
npm install \
  @supabase/supabase-js \
  @supabase/ssr \
  zod \
  zustand

# Dev dependencies
npm install -D \
  tsx \
  dotenv \
  @types/node
```

After running these, **replace the generated files** with the versions in this Phase 1 bundle (listed below). The `create-next-app` defaults are fine but we want a couple of tweaks (path aliases, a cleaner `page.tsx` placeholder, etc.).

## 3. shadcn/ui — defer to Phase 3

The spec lists shadcn/ui in the stack, but it's a UI layer, not a dependency. We install it in Phase 3 when we start building the landing page, because `shadcn` init creates files (`components/ui/*`, `lib/utils.ts`) that we don't need yet and would just be unused clutter.

## 4. Supabase project setup

1. Go to https://supabase.com and create a new project. Pick a region close to you; pick a strong DB password and save it in your password manager.
2. Wait ~2 min for provisioning.
3. In the Supabase dashboard:
   - **Project Settings → API** → copy `Project URL`, `anon public` key, `service_role` key. Put them in `.env.local`.
   - **SQL Editor** → paste and run `supabase/migrations/0001_initial_schema.sql` (full file below).
   - Then run `supabase/seed/0001_service_categories.sql`.
   - Then run `supabase/seed/0002_sample_businesses.sql`.
4. **Authentication → Providers**: leave defaults for now. We configure magic link + Google OAuth in Phase 2.

## 5. Environment variables (running list)

Maintained in `.env.example`. Phase 1 needs only the three Supabase vars. Every later phase will append.

## 6. Test checklist (verify before Phase 2)

Run each of these. All should pass.

- [ ] `npm run dev` starts without error on http://localhost:3000
- [ ] Placeholder homepage renders "EvenQuote — coming soon"
- [ ] In Supabase SQL editor, `SELECT count(*) FROM service_categories;` returns `1` (moving)
- [ ] `SELECT count(*) FROM businesses;` returns `20`
- [ ] `SELECT count(*) FROM businesses WHERE phone LIKE '+1555%';` returns `20` — confirms all seed phone numbers are fake 555-range (no accidental real-world calls during dev)
- [ ] All 10 tables exist: `\dt public.*` in SQL editor, or query `information_schema.tables` — should show: `profiles, service_categories, businesses, quote_requests, calls, quotes, payments` plus auth.users (Supabase-managed)
- [ ] `npx tsx scripts/verify-db.ts` prints "✅ DB connection OK" and lists table row counts
- [ ] RLS is enabled on every user-facing table (query below returns 0):
  ```sql
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('profiles','quote_requests','calls','quotes','payments')
    AND NOT rowsecurity;
  ```

Once all boxes check, say **"Phase 1 complete. Proceed to Phase 2."**
