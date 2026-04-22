# Phase 4 — Intake Form & Quote Request Flow

## What's new vs Phase 3

- **Multi-step intake form** at `/get-quotes` with 5 steps (Origin, Destination, Details, Contact, Review) following the seeded schema from Phase 1.
- **Zod validation** as the single source of truth for the form shape — client (per-step on Next) and server (re-validation in the action).
- **Zustand store with localStorage persistence**. Users can close the tab mid-flow and come back to the same step with the same data.
- **Editorial progress bar** — numbered step dots connected by a thick rule, lime accent on the active step, ink fill on completed ones.
- **Server action** `submitMovingIntake` persists the row as `status: 'pending_payment'`. Guest-accessible — no sign-in required yet.
- **Schema migration 0002** makes `user_id` nullable so guest submissions work. Phase 5 will backfill when users sign in at checkout.
- **shadcn primitives**: `Input`, `Label`, `Textarea`, `Select`, `Checkbox` all vendored.
- **Placeholder `/get-quotes/checkout`** shows the saved request — Phase 5 replaces it with the real Stripe flow.

## New files at end of Phase 4

```
evenquote/
├── app/
│   └── get-quotes/
│       ├── page.tsx                                # intake page
│       └── checkout/page.tsx                       # placeholder, Phase 5 replaces
├── components/
│   ├── get-quotes/
│   │   ├── form-shell.tsx                          # orchestrator
│   │   ├── form-field.tsx                          # label + input + error
│   │   ├── address-block.tsx                       # shared by origin/destination
│   │   ├── progress.tsx                            # editorial step indicator
│   │   ├── step-nav.tsx                            # back/next buttons
│   │   └── steps.tsx                               # all 5 steps in one file
│   └── ui/                                         # vendored shadcn primitives
│       ├── input.tsx
│       ├── label.tsx
│       ├── textarea.tsx
│       ├── select.tsx
│       └── checkbox.tsx
├── lib/
│   ├── actions/
│   │   └── intake.ts                               # server action
│   └── forms/
│       ├── moving-intake.ts                        # Zod schemas + STEPS
│       ├── intake-store.ts                         # Zustand + useIsHydrated
│       └── use-step-validation.ts                  # validation hook
└── supabase/migrations/
    └── 0002_guest_quote_requests.sql               # user_id now nullable
```

## Install steps

```bash
# 1. New deps (4 Radix primitives). Zustand was already in Phase 1.
npm install \
  @radix-ui/react-checkbox \
  @radix-ui/react-label \
  @radix-ui/react-select

# Note: @radix-ui/react-accordion and @radix-ui/react-slot were added
# in Phase 3 and carry over.

# 2. Apply the migration.
# In Supabase SQL Editor, paste and run:
#   supabase/migrations/0002_guest_quote_requests.sql
# Safe on existing DBs — only drops a NOT NULL constraint.

# 3. Run
npm run dev
```

## Design notes

- **Error UX**: errors clear as soon as the user starts fixing the field (`onFieldChange` in `AddressBlock`, `clearError` in step components). No stale red "required" messages lingering after correction.
- **Special items** are rendered as a card-style multi-select (4-column grid on desktop). Checkbox-inside-label pattern — entire card is the click target.
- **Progress scrolls to top on step change** so users don't land mid-page on step 2 after clicking Next on a long step 1.
- **Review step** shows all data with per-section "Edit" links that jump straight back to the relevant step.
- **Server fallback**: if server validation rejects a field, we jump to the offending step and surface the error in the shell's banner. Defense-in-depth against a client that might bypass Zod.
- **Hydration guard**: first paint is a skeleton until Zustand rehydrates. No SSR/CSR content mismatch. Uses Zustand's `persist.hasHydrated()` + `onFinishHydration()` API — the pattern from their docs.

## Test checklist (verify before Phase 5)

### Core flow
- [ ] Homepage "Get quotes for $9.99" button lands on `/get-quotes`
- [ ] Step 1 (Origin) renders with 4 fields (street/city/state/ZIP). Progress dots show `1` filled, `2-5` outlined.
- [ ] Submit step 1 empty → all 4 fields show red errors underneath
- [ ] Start typing in a field with an error → error disappears
- [ ] Fill in invalid ZIP ("abcde") → shows "Must be a 5-digit ZIP" on next
- [ ] Valid state/ZIP combo (e.g. `San Diego, CA, 92101`) → advances to step 2
- [ ] Step 2 advances to step 3 with same pattern
- [ ] Step 3: home size dropdown has 7 options; date input rejects past dates via `min`; special items toggle on click (card gets filled border)
- [ ] Step 4: phone accepts `(555) 123-4567`; email rejects `foo@bar` (no TLD — actually Zod accepts this, verify what you expect)
- [ ] Step 5 (Review): shows all 4 sections with "Edit" links; clicking Edit jumps to the right step
- [ ] "Continue to payment" on Review → creates row and redirects to `/get-quotes/checkout?request=<uuid>`
- [ ] Placeholder checkout page shows the saved request ID + location + `pending_payment` status

### Persistence
- [ ] Fill out steps 1-3, refresh the page → lands back on step 3 with all fields still populated
- [ ] Open `/get-quotes` in an incognito window → starts fresh at step 1 (localStorage is per-profile)
- [ ] Fill a field, open devtools → Application → Local Storage → see `evenquote:intake:moving` entry with version `1` and draft data

### DB
- [ ] After completing a submission, query in Supabase SQL Editor:
  ```sql
  select id, status, city, state, intake_data, user_id, created_at
  from quote_requests order by created_at desc limit 1;
  ```
  Should show status=`pending_payment`, destination city/state/zip, full intake in JSONB, user_id NULL (guest).
- [ ] Sign in as a real user, submit another request → row has user_id populated this time.

### Edge cases
- [ ] Hit `/get-quotes/checkout` directly (no `?request=`) → 404
- [ ] Hit `/get-quotes/checkout?request=00000000-0000-0000-0000-000000000000` → 404
- [ ] Submit from Review with a field that passes client Zod but fails server Zod (simulate via devtools localStorage edit) → banner error appears and step jumps to offending section

### Build
- [ ] `npm run build` completes with no errors or new warnings

## Known limitations deferred to later phases

- **No real checkout.** Phase 5 replaces the placeholder with Stripe.
- **Guest requests are orphaned** until Phase 5 adds the sign-in-at-checkout + user_id backfill logic.
- **No intake form for other categories** — `moving` only. When we add HVAC/cleaning/etc., each needs its own Zod schema + step definitions. The current architecture makes this easy (swap `moving-intake.ts`), but we haven't built the router yet.
- **No `rate limit`** on submissions — anonymous users can spam the DB with draft rows. Phase 5's Stripe gate largely solves this (no payment, no calls), and Phase 12 adds proper rate limits.

Once all boxes check, say **"Phase 4 complete. Proceed to Phase 5."**
