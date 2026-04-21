# Phase 3 — Landing Page & UI Foundation

## What's new vs Phase 2

- **shadcn/ui installed** with the "new-york" style and neutral base, customized
  with a brand design token layer. Two components vendored: `Button` (with a
  custom `lime` variant) and `Accordion`.
- **Design system in `globals.css`**: HSL-based light/dark CSS variables for
  all shadcn tokens, plus brand tokens (`--lime`, cream, ink).
- **Typography upgrade**: Fraunces (display serif with SOFT/WONK axes) + Geist
  Sans (body) + Geist Mono (labels). Loaded via `next/font` so fonts self-host
  and inline their subset CSS — zero external requests, no FOUT.
- **Landing page sections** in `components/site/`:
  - `Hero` — asymmetric editorial layout, lime "price sticker" ornament
  - `HowItWorks` — 3 numbered steps with `rule-top` editorial dividers
  - `Pricing` — single-tier card, lime price panel, honest "what you'll never get" list
  - `FAQ` — accordion with 6 real-world questions
  - `FinalCTA` — closing ask on lime block
  - `SiteNavbar` — sticky, auth-aware (shows Dashboard vs Sign in)
  - `SiteFooter` — editorial dark footer with brand block + nav columns
- **Dashboard** updated to share the same navbar and Tailwind tokens as the
  rest of the app (no more hardcoded `neutral-*` colors; dark mode now works).

## Design direction

Picked: **bold + direct, editorial**. Specifically:
- **Color**: ink (`#0A0A0A`) + cream (`#F5F1E8`) + electric lime (`#CEFF00`). Lime
  is reserved for 3 moments: the price sticker, one FAQ underline, the final CTA.
- **Type**: Fraunces at display sizes with `-4%` tracking and a 1:1 line-height for
  that stacked-mass feel. Geist Mono in monospace, uppercase, wide-tracked eyebrows
  play the role of a magazine "kicker".
- **Layout**: grid-breaking asymmetry in the hero, a rotated circular price badge
  with an offset shadow (`shadow-[8px_8px_0_0_...]`), thin top-rule dividers on
  editorial columns.
- **Restraint**: zero stock photos, zero lottie animations, zero fake
  testimonials. Typography is the decoration.

## Install steps

```bash
# 1. Install new dependencies (added vs Phase 2):
npm install \
  @radix-ui/react-accordion \
  @radix-ui/react-slot \
  class-variance-authority \
  clsx \
  lucide-react \
  tailwind-merge \
  tailwindcss-animate

# 2. Everything else is in place — the files in this bundle replace the
# existing ones. Specifically REPLACED from earlier phases:
#   - app/layout.tsx        (now loads fonts)
#   - app/globals.css       (full shadcn + brand tokens)
#   - app/page.tsx          (composes landing sections)
#   - app/dashboard/page.tsx (uses shared chrome)
#   - tailwind.config.ts    (full design system)
#   - package.json

# 3. Run
npm run dev
```

## Why shadcn@2.3.0 pinned

The latest shadcn CLI targets Tailwind v4. We're on Tailwind 3.4.13 from Phase 1.
If you ever run the CLI to add more components, use `npx shadcn@2.3.0 add ...`
to stay compatible. The Tailwind 3 vs 4 CSS differences are not small — do not
mix versions.

## Adding more shadcn components later

As later phases need more UI primitives (Card, Dialog, Input, Select, etc.),
run:

```bash
npx shadcn@2.3.0 add input label card dialog select
```

The CLI will use our `components.json` and drop sources into `components/ui/`.

### ⚠️ Don't overwrite the Button

`components/ui/button.tsx` has a custom `lime` variant that is NOT part of stock
shadcn. If you re-add Button via the CLI, it will overwrite the file. Comment at
the top of the file reminds you to re-apply the variant if that happens.

## Test checklist (verify before Phase 4)

- [ ] `npm install` completes with no peer-dep warnings that block the build
- [ ] `npm run dev` starts on :3000 with no console errors
- [ ] `/` renders the full landing page (5 sections + navbar + footer)
- [ ] Custom fonts load — headings are serif (Fraunces), not system serif
- [ ] Hero price sticker is a lime circle with offset shadow, tilted ~6° on desktop
- [ ] Navbar shows "Get quotes" button when logged out, "Dashboard" when logged in
- [ ] FAQ accordion expands and collapses smoothly (Radix animation)
- [ ] Click "Sign in" or "Dashboard" — header navigation works
- [ ] On mobile (<1024px): price sticker hidden, hero stacks vertically,
      "Sign in" button hides in navbar (only primary CTA shows)
- [ ] `/dashboard` (after sign-in) shows the updated UI with site navbar on top,
      styled with tokens (no raw `neutral-900` anywhere visible)
- [ ] Dark mode: add `class="dark"` to `<html>` via devtools — all sections
      remain readable, FAQ/navbar/dashboard all flip correctly
- [ ] `npm run build` completes successfully (catches any Tailwind class typos)
- [ ] Lighthouse: accessibility ≥ 95 on `/` (color contrast, headings, alt text)

## Known limitations deferred to later phases

- No mobile nav drawer — navbar is one CTA, so a hamburger would be overkill
- `/get-quotes` link is dead — Phase 4 builds the intake form
- No `/pricing` page — the section scrolls into view from `/#pricing`; we can
  break it out if SEO needs a standalone page later
- No blog or marketing content — pre-launch, not needed
- Dark mode toggle UI — tokens support it, but no switcher component yet.
  Phase 10+ adds one to the dashboard header if there's demand.

Once all boxes check, say **"Phase 3 complete. Proceed to Phase 4."**
