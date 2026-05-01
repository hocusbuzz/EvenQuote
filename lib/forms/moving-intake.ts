// Moving intake form — Zod schemas.
//
// Source of truth for validation. Used by:
//   - Client-side step components (per-step .parse())
//   - The Zustand store (whole-form .parse() before submit)
//   - The server action that persists the quote request (re-validates
//     everything, since client input is never trusted)
//
// Shape mirrors the intake_form_schema JSONB seeded in Phase 1 for the
// 'moving' category — if you edit the seed, update this and vice versa.

import { z } from 'zod';
import { UtmsSchema } from '@/lib/marketing/utms';

// ─── Reusable primitives ──────────────────────────────────────────

// US ZIP — either 5 digits or ZIP+4 (12345-6789). Regex is strict
// because we'll feed this into business-search queries later.
export const ZipSchema = z
  .string()
  .trim()
  .regex(/^\d{5}(-\d{4})?$/, 'Must be a 5-digit ZIP (or ZIP+4)');

// Phone — store E.164-ish; accept common human formats and normalize.
// We don't call parsePhoneNumber here (would add a dep); minimal cleanup.
export const PhoneSchema = z
  .string()
  .trim()
  .min(10, 'Phone number looks too short')
  .max(20, 'Phone number looks too long')
  .regex(/^[+\d][\d\s\-().]*$/, 'Digits, spaces, and ( ) - + only');

// Email — canonical chain order: trim → toLowerCase → email. Putting
// `.email()` LAST means trim + lowercase happen before the format
// check, so "  User@Example.COM  " normalizes to "user@example.com"
// rather than getting rejected for whitespace/case. Exported as a
// shared primitive so every vertical intake, waitlist signup, and
// other email-collecting action uses the same chain. The R45(d)
// audit (`zod-shared-primitive-drift.test.ts`) locks this.
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Valid email, please');

// Env-var email — DELIBERATELY loose (no `.trim()`, no `.toLowerCase()`).
//
// Why a separate primitive? Operator-set env vars are NOT user input.
// If an operator sets `EVENQUOTE_SUPPORT_EMAIL=" Foo@Bar.com "` we
// want validation to FAIL LOUDLY at boot — silently trimming or
// lowercasing the value would mask a typo and ship to production. So
// we keep `.email(...)` for format only and skip normalization.
//
// Use this in `lib/env.ts` and any other env-var schema that takes an
// email-shaped operator input. The R45(d) audit (`zod-shared-primitive-
// drift.test.ts`) was previously allow-listing `lib/env.ts` because it
// used an inline `.email()` call; R46(b) lifts that exception by
// pointing `lib/env.ts` at this primitive.
export const EnvEmailSchema = z.string().email();

// Full list of US states + DC. Abbreviated — dropdowns want to show
// the state code next to the name, so we store the 2-letter code.
export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;
export const UsStateSchema = z.enum(US_STATES);

export const HOME_SIZES = [
  'Studio',
  '1 bedroom',
  '2 bedroom',
  '3 bedroom',
  '4 bedroom',
  '5+ bedroom',
  'Office / commercial',
] as const;
export const HomeSizeSchema = z.enum(HOME_SIZES);

export const SPECIAL_ITEMS = [
  'Piano',
  'Safe',
  'Artwork',
  'Antiques',
  'Pool table',
  'Hot tub',
  'Vehicle',
  'Gym equipment',
] as const;
export const SpecialItemSchema = z.enum(SPECIAL_ITEMS);

// Dates: ISO yyyy-mm-dd from <input type="date">. Must be today or later.
// We compare just the date portion (not time) to avoid timezone games.
function isTodayOrLater(isoDate: string): boolean {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  return isoDate >= todayIso;
}

export const MoveDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date')
  .refine(isTodayOrLater, 'Move date must be today or in the future');

// ─── Step schemas ─────────────────────────────────────────────────

// Latitude / longitude coming from a Google Place Details pick. Both
// optional on the schema — manual address entries (Google "use custom"
// fallback, PO boxes Google didn't resolve) won't have them, and the
// rest of the pipeline degrades to old behavior in that case.
const LatSchema = z
  .number()
  .min(-90)
  .max(90)
  .optional();
const LngSchema = z
  .number()
  .min(-180)
  .max(180)
  .optional();

// Step 1 — origin address
export const OriginSchema = z.object({
  origin_address: z.string().trim().min(3, 'Please enter a street address'),
  origin_city: z.string().trim().min(2, 'City required'),
  origin_state: UsStateSchema,
  origin_zip: ZipSchema,
  origin_lat: LatSchema,
  origin_lng: LngSchema,
});

// Step 2 — destination address
export const DestinationSchema = z.object({
  destination_address: z.string().trim().min(3, 'Please enter a street address'),
  destination_city: z.string().trim().min(2, 'City required'),
  destination_state: UsStateSchema,
  destination_zip: ZipSchema,
  destination_lat: LatSchema,
  destination_lng: LngSchema,
});

// Step 3 — move details
export const DetailsSchema = z.object({
  home_size: HomeSizeSchema,
  move_date: MoveDateSchema,
  flexible_dates: z.boolean().default(false),
  special_items: z.array(SpecialItemSchema).default([]),
  additional_notes: z
    .string()
    .trim()
    .max(1000, 'Keep notes under 1,000 characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

// Step 4 — contact info
export const ContactSchema = z.object({
  contact_name: z.string().trim().min(2, 'Your name'),
  contact_phone: PhoneSchema,
  contact_email: EmailSchema,
});

// ─── Full intake ─────────────────────────────────────────────────

// UTMs are merged into the full schema (not into a step) because
// they're auto-captured from the landing URL by components/get-quotes/
// utm-capture.tsx, not user-entered. All five fields are .optional().
// Direct/organic traffic legitimately has no UTMs; pre-launch rows
// have none either. Persisted into utm_* columns by the intake server
// action — see migration 0015_quote_requests_utm_columns.sql.
export const MovingIntakeSchema = OriginSchema.merge(DestinationSchema)
  .merge(DetailsSchema)
  .merge(ContactSchema)
  .merge(UtmsSchema);

export type MovingIntakeData = z.infer<typeof MovingIntakeSchema>;

// Partial version for in-progress form state (Zustand store).
// All fields optional — the step schemas do the real validation.
export type MovingIntakeDraft = Partial<MovingIntakeData>;

// Step metadata — drives the progress bar and the step loop
export const STEPS = [
  { id: 'origin', title: 'From', label: 'Step 1 of 5' },
  { id: 'destination', title: 'To', label: 'Step 2 of 5' },
  { id: 'details', title: 'Details', label: 'Step 3 of 5' },
  { id: 'contact', title: 'Contact', label: 'Step 4 of 5' },
  { id: 'review', title: 'Review', label: 'Step 5 of 5' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

// Which Zod schema validates each step (review has no fields of its
// own — it just confirms the whole form passes MovingIntakeSchema).
export const STEP_SCHEMAS = {
  origin: OriginSchema,
  destination: DestinationSchema,
  details: DetailsSchema,
  contact: ContactSchema,
  review: MovingIntakeSchema,
} as const;
