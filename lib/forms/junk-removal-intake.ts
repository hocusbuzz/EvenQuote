// Junk-removal intake form — Zod schemas.
//
// Tier 0b — top new pick per docs/IMPROVEMENT_BACKLOG.md §B1. Massive
// price variance, zero transparent online pricing, AI-friendly schema
// (volume bucket + heavy-item Y/N → ballpark in 4 questions).
//
// Mirrors the shape of lawn-care-intake.ts (4 steps: location → load
// → contact → review). Reusable primitives imported from moving-intake
// per the R45(d) shared-primitive drift audit.
//
// Shape mirrors the intake_form_schema JSONB seeded in
// supabase/migrations/0016_junk_removal_category.sql for the
// 'junk-removal' category — if you edit the seed, update this and
// vice versa.
//
// NOTE: the slug is hyphenated 'junk-removal'. Use `useJunkRemovalStore`
// (camelCase) — keeps the symbol search-friendly and matches the URL.

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

// ─── Junk-removal-specific enums ────────────────────────────────

// Volume buckets — matches the seed JSONB. Pricing tier driver.
export const VOLUME_BUCKETS = [
  'Single couch / armchair',
  'Pickup-truck load',
  'Half a truck',
  'Full truck',
  'Multiple loads',
] as const;
export const VolumeBucketSchema = z.enum(VOLUME_BUCKETS);

// Heavy / specialty items — multiselect. Each surcharges separately
// in junk-removal pricing; the AI prompt asks the contractor to
// quote each item identified here.
export const HEAVY_ITEMS = [
  'Piano',
  'Hot tub',
  'Appliances (fridge / washer)',
  'Construction debris',
  'Yard waste',
  'Mattress / box spring',
  'Electronics / TVs',
] as const;
export const HeavyItemSchema = z.enum(HEAVY_ITEMS);

// Where the load is — drives interior-access labor surcharge.
export const PICKUP_LOCATIONS = [
  'Curb / driveway',
  'Garage',
  'Inside the home — ground floor',
  'Inside the home — upstairs',
] as const;
export const PickupLocationSchema = z.enum(PICKUP_LOCATIONS);

// ─── Dates ────────────────────────────────────────────────────────

function isTodayOrLater(isoDate: string): boolean {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  return isoDate >= todayIso;
}

export const PreferredDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date')
  .refine(isTodayOrLater, 'Preferred date must be today or in the future');

// ─── Step schemas ─────────────────────────────────────────────────

// Step 1 — where the pickup is.
export const LocationSchema = z.object({
  address: z.string().trim().min(3, 'Please enter a street address'),
  city: z.string().trim().min(2, 'City required'),
  state: UsStateSchema,
  zip: ZipSchema,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

// Step 2 — about the load.
//
// `heavy_items` is OPTIONAL (an empty array is valid — most jobs are
// just generic furniture / household stuff). When non-empty, the AI
// asks for each surcharge separately on the call.
//
// `same_day_needed` is a tri-state in spirit (yes / no / unsure) but
// represented as `boolean | undefined` — UI maps to a Yes/No/Skip
// group, mirroring the handyman `materials_needed` pattern.
export const LoadSchema = z.object({
  volume_bucket: VolumeBucketSchema,
  heavy_items: z.array(HeavyItemSchema).default([]),
  pickup_location: PickupLocationSchema,
  same_day_needed: z.boolean().optional(),
  preferred_date: PreferredDateSchema,
  additional_notes: z
    .string()
    .trim()
    .max(1000, 'Keep notes under 1,000 characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

// Step 3 — contact. Same shape as the other verticals.
export const ContactSchema = z.object({
  contact_name: z.string().trim().min(2, 'Your name'),
  contact_phone: PhoneSchema,
  contact_email: EmailSchema,
});

// ─── Full intake ─────────────────────────────────────────────────

// See moving-intake.ts for the rationale on merging UTMs at the full-
// schema level rather than a step. Same shape, same persistence path.
export const JunkRemovalIntakeSchema = LocationSchema.merge(LoadSchema)
  .merge(ContactSchema)
  .merge(UtmsSchema);

export type JunkRemovalIntakeData = z.infer<typeof JunkRemovalIntakeSchema>;
export type JunkRemovalIntakeDraft = Partial<JunkRemovalIntakeData>;

// ─── Step metadata ───────────────────────────────────────────────

export const STEPS = [
  { id: 'location', title: 'Where', label: 'Step 1 of 4' },
  { id: 'load', title: 'Load', label: 'Step 2 of 4' },
  { id: 'contact', title: 'Contact', label: 'Step 3 of 4' },
  { id: 'review', title: 'Review', label: 'Step 4 of 4' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

export const STEP_SCHEMAS = {
  location: LocationSchema,
  load: LoadSchema,
  contact: ContactSchema,
  review: JunkRemovalIntakeSchema,
} as const;
