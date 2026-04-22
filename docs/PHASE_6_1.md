# Phase 6.1 — Multi-vertical foundation

Phase 6 shipped the end-to-end moving flow: intake → pay → ingest businesses
→ Vapi outbound call → extract quote → store. Phase 6.1 generalizes that
pipeline so new verticals drop in via data changes, not code changes — and
lights up the first expansion vertical (house cleaning).

## What shipped

### Schema (`supabase/migrations/0005_multi_vertical.sql`)

- `service_categories.extraction_schema` (jsonb) — per-category prompt
  augmentation for the webhook's quote extractor. Shape:
  ```jsonc
  {
    "domain_notes": "...",              // free-text guidance for the LLM
    "includes_examples": ["bedrooms"],  // what "includes" typically means here
    "excludes_examples": ["fridge"],    // what gets charged extra
    "price_anchors": "2BR $120-220",    // sanity-check range
    "onsite_estimate_common": true      // if true, prices allowed to be null
  }
  ```
- `service_categories.places_query_template` (text) — e.g. `"movers near {zip}"`.
  The ingest CLI substitutes `{zip}` at query time.
- `waitlist_signups` — email capture for verticals we haven't built yet.
  Unique `(category_id, email)` so retries dedupe. RLS on with no policies;
  only service-role writes.

### Seed (`supabase/seed/0002_multi_vertical_categories.sql`)

- Backfills `moving` with its new `extraction_schema` and `places_query_template`.
- Inserts three new categories:
  - **House Cleaning** (`cleaning`) — live intake form.
  - **Handyman** (`handyman`) — waitlist only.
  - **Lawn Care** (`lawn-care`) — waitlist only.

Each seed row is a complete vertical: `intake_form_schema`, `call_script_template`
(with `{{variables}}` the assistant will hydrate), `disclosure_text`,
`extraction_schema`, `places_query_template`. A new vertical only needs a seed
INSERT and a waitlist entry — no code changes required unless it's going live.

### Backend (already generalized from 6.0 → 6.1)

- `lib/calls/engine.ts` — `buildVariableValues` strips contact PII and full
  addresses regardless of category, then passes every remaining intake key
  through to the Vapi assistant as a `{{variable}}`. Per-vertical scripts
  reference their own keys.
- `lib/calls/extract-quote.ts` — accepts optional `categoryContext` param.
  The universal quote shape (price range, includes/excludes, availability,
  contact, onsite flag, confidence) stays as literal columns on `quotes`;
  only the LLM prompt is augmented from `extraction_schema`.
- `app/api/vapi/webhook/route.ts` — joins `service_categories` at call-lookup
  time and passes the flattened category context into extraction.

### Frontend

- `lib/forms/cleaning-intake.ts` — Zod schemas for the cleaning flow
  (location / home / service / contact / review).
- `lib/forms/cleaning-store.ts` — separate Zustand store so drafts don't leak
  between verticals. localStorage key: `evenquote:intake:cleaning`.
- `components/get-quotes/cleaning-steps.tsx` + `cleaning-form-shell.tsx` —
  cleaning's 5-step intake. Visual system is shared (StepNav, FormField,
  Progress); wiring is cleaning-specific.
- `components/get-quotes/waitlist-capture.tsx` — email + optional ZIP capture
  for deferred verticals. Idempotent via `waitlist_signups_unique`.
- `app/get-quotes/page.tsx` — now a category picker that renders tiles from
  `service_categories`. Live verticals get a "$9.99 — get quotes →" CTA;
  deferred ones get a "Waitlist" badge.
- `app/get-quotes/[category]/page.tsx` — dynamic dispatcher. Looks up the
  category by slug; dispatches to `IntakeFormShell` (moving),
  `CleaningFormShell` (cleaning), or `WaitlistCapture` (everything else).
  Next's router gives precedence to the specific `checkout`, `claim`, and
  `success` routes, so those are unaffected.

### Actions

- `lib/actions/cleaning-intake.ts` — `submitCleaningIntake` mirrors
  `submitMovingIntake` but stores the single service address on the top-
  level city/state/zip columns.
- `lib/actions/waitlist.ts` — `joinWaitlist` writes to `waitlist_signups`.
  Returns `ok: true` for both new signups and duplicates (23505) so the
  UX is identical from the user's perspective.

## How to add another live vertical

1. **Seed it**: add a row to `service_categories` with full `intake_form_schema`,
   `call_script_template`, `disclosure_text`, `extraction_schema`,
   `places_query_template`.
2. **Ingest businesses**: `pnpm ingest:businesses --category <slug> --query "..."`.
3. **Build the form**: `lib/forms/<slug>-intake.ts` + `<slug>-store.ts`,
   `components/get-quotes/<slug>-steps.tsx` + `<slug>-form-shell.tsx`,
   `lib/actions/<slug>-intake.ts`. Follow the cleaning pattern.
4. **Register it**: add to `LIVE_FORMS` in `app/get-quotes/[category]/page.tsx`
   and to `LIVE_SLUGS` in `app/get-quotes/page.tsx`.

## How to add a waitlist-only vertical

Just step 1 above. The picker and dynamic route automatically render the
waitlist capture for any `is_active` category not in `LIVE_FORMS`.

## Testing locally

- Visit `/get-quotes` → should show four tiles (moving + cleaning live,
  handyman + lawn-care waitlist).
- `/get-quotes/moving` → existing moving form.
- `/get-quotes/cleaning` → new 5-step cleaning form.
- `/get-quotes/handyman` → waitlist capture; submitting should insert a row
  into `waitlist_signups` (verify with `select * from waitlist_signups`).
- `/get-quotes/checkout?request=<id>` and `/get-quotes/success` continue to
  work unchanged.

## Privacy guardrails (unchanged from 6.0)

`buildVariableValues` strips `contact_phone`, `contact_email`,
`origin_address`, `destination_address`, and `address` before handing the
intake to Vapi. The AI caller passes scope (city/home size/date/etc.) to
businesses, not PII. Phase 8 will add an explicit opt-in callback handoff.
