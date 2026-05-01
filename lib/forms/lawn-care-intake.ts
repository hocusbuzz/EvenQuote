// Lawn-care intake form — Zod schemas.
//
// Mirrors the shape of cleaning-intake / handyman-intake so the form
// machinery (form-shell, step nav, validation hook) is parallel and
// reusable. Reusable primitives (ZipSchema, PhoneSchema, UsStateSchema,
// EmailSchema) are imported from moving-intake — locked by the R45(d)
// shared-primitive drift audit.
//
// Shape mirrors the intake_form_schema JSONB seeded in
// supabase/seed/0002_multi_vertical_categories.sql for the 'lawn-care'
// category — if you edit the seed, update this and vice versa.
//
// Steps: location → yard → contact → review (4 total, same as handyman).
// We deliberately don't have a separate "service" step — lawn care
// pricing is dominated by lot_size + frequency, with the chosen
// services as a refinement, all of which fit into one step.
//
// NOTE: the slug is hyphenated 'lawn-care' (NOT 'lawn_care' or 'lawn').
// Use `useLawnCareStore`, NOT `useLawnStore` — keeps the symbol search-
// friendly and matches the URL path.

import { z } from 'zod';
import { UtmsSchema } from '@/lib/marketing/utms';
import {
  ZipSchema,
  PhoneSchema,
  UsStateSchema,
  EmailSchema,
  US_STATES,
} from './moving-intake';

export {
  ZipSchema,
  PhoneSchema,
  UsStateSchema,
  EmailSchema,
  US_STATES,
};

// ─── Lawn-care-specific enums ────────────────────────────────────

// Lot-size buckets — matches the seed JSONB. Tracks customer's rough
// estimate (most renters / new homeowners can't quote exact sqft but
// can pick a bucket). Source-of-truth is the seed; keep in sync.
export const LOT_SIZES = [
  'Under 1/8 acre',
  '1/8 – 1/4 acre',
  '1/4 – 1/2 acre',
  '1/2 – 1 acre',
  '1 – 2 acres',
  '2+ acres',
] as const;
export const LotSizeSchema = z.enum(LOT_SIZES);

// Service mix — multiselect, customer ticks all that apply. The AI
// prompt iterates over these and asks the contractor to quote each.
// Order in the UI is "common first" (mowing/edging/blowing) → less
// common (treatments) → seasonal cleanups.
export const SERVICE_TYPES = [
  'Mowing',
  'Edging',
  'Blowing / cleanup',
  'Hedge trimming',
  'Fertilizer / treatment',
  'Leaf removal',
  'Spring cleanup',
  'Fall cleanup',
] as const;
export const ServiceTypeSchema = z.enum(SERVICE_TYPES);

// Cadence — drives whether the contractor quotes per-visit or a
// seasonal contract. The seed prompt explicitly captures BOTH numbers
// when a seasonal contract is offered, but the customer's selection
// here is what we lead with.
export const FREQUENCIES = [
  'One-time',
  'Weekly',
  'Every two weeks',
  'Monthly',
  'Seasonal contract',
] as const;
export const FrequencySchema = z.enum(FREQUENCIES);

// ─── Dates ────────────────────────────────────────────────────────

// Accepts ISO yyyy-mm-dd from <input type="date">. Must be today or
// later. Duplicated across vertical schemas to keep them standalone-
// friendly; refactor into shared primitives if a fifth vertical needs
// the same constraint.
function isTodayOrLater(isoDate: string): boolean {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  return isoDate >= todayIso;
}

export const StartDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date')
  .refine(isTodayOrLater, 'Start date must be today or in the future');

// ─── Step schemas ─────────────────────────────────────────────────

// Step 1 — where the yard is.
//
// Optional `lat` / `lng` come from a Google Place Details pick. Used
// downstream by the on-demand business seeder + radius selector.
// Manual entries lack them and the pipeline degrades gracefully.
export const LocationSchema = z.object({
  address: z.string().trim().min(3, 'Please enter a street address'),
  city: z.string().trim().min(2, 'City required'),
  state: UsStateSchema,
  zip: ZipSchema,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

// Step 2 — about the yard.
//
// `service_type` is a NON-EMPTY array — the customer must tick at
// least one service or there's nothing to quote. UI enforces this on
// next-click; this is the server-side belt.
//
// `additional_notes` is free text capped at 1000 chars. Note that
// notes content does NOT reach the AI assistant (lib/calls/build-safe-
// variable-values.ts is an allowlist); it stays in intake_data for
// the support team's reference only.
export const YardSchema = z.object({
  lot_size: LotSizeSchema,
  service_type: z
    .array(ServiceTypeSchema)
    .min(1, 'Pick at least one service'),
  frequency: FrequencySchema,
  start_date: StartDateSchema,
  additional_notes: z
    .string()
    .trim()
    .max(1000, 'Keep notes under 1,000 characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

// Step 3 — contact.
// Same shape as moving + cleaning + handyman ContactSchema but
// redefined here so the lawn-care form is self-contained.
export const ContactSchema = z.object({
  contact_name: z.string().trim().min(2, 'Your name'),
  contact_phone: PhoneSchema,
  contact_email: EmailSchema,
});

// ─── Full intake ─────────────────────────────────────────────────

// See moving-intake.ts for the rationale on merging UTMs at the full-
// schema level rather than a step. Same shape, same persistence path.
export const LawnCareIntakeSchema = LocationSchema.merge(YardSchema)
  .merge(ContactSchema)
  .merge(UtmsSchema);

export type LawnCareIntakeData = z.infer<typeof LawnCareIntakeSchema>;
export type LawnCareIntakeDraft = Partial<LawnCareIntakeData>;

// ─── Step metadata ───────────────────────────────────────────────

export const STEPS = [
  { id: 'location', title: 'Where', label: 'Step 1 of 4' },
  { id: 'yard', title: 'Yard', label: 'Step 2 of 4' },
  { id: 'contact', title: 'Contact', label: 'Step 3 of 4' },
  { id: 'review', title: 'Review', label: 'Step 4 of 4' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

export const STEP_SCHEMAS = {
  location: LocationSchema,
  yard: YardSchema,
  contact: ContactSchema,
  review: LawnCareIntakeSchema,
} as const;
