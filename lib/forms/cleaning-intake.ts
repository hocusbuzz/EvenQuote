// Cleaning intake form — Zod schemas.
//
// Mirrors the shape of moving-intake.ts so components/get-quotes/form-shell
// can be reused across verticals. Reusable primitives (ZipSchema,
// PhoneSchema, UsStateSchema) are imported from moving-intake — they're
// not moving-specific and deserve to live in a shared module eventually,
// but importing from the first caller is fine for now.
//
// Shape mirrors the intake_form_schema JSONB seeded in
// supabase/seed/0002_multi_vertical_categories.sql for the 'cleaning'
// category — if you edit the seed, update this and vice versa.

import { z } from 'zod';
import { UtmsSchema } from '@/lib/marketing/utms';
import {
  ZipSchema,
  PhoneSchema,
  UsStateSchema,
  EmailSchema,
  HomeSizeSchema,
  HOME_SIZES,
  US_STATES,
} from './moving-intake';

export {
  ZipSchema,
  PhoneSchema,
  UsStateSchema,
  EmailSchema,
  HomeSizeSchema,
  HOME_SIZES,
  US_STATES,
};

// ─── Cleaning-specific enums ──────────────────────────────────────

export const BATHROOMS = [
  '1',
  '1.5',
  '2',
  '2.5',
  '3',
  '3.5',
  '4+',
] as const;
export const BathroomsSchema = z.enum(BATHROOMS);

export const PET_OPTIONS = [
  'None',
  'Cats',
  'Dogs',
  'Both',
  'Other',
] as const;
export const PetsSchema = z.enum(PET_OPTIONS);

export const CLEANING_TYPES = [
  'Standard',
  'Deep clean',
  'Move-in / move-out',
  'Post-construction',
] as const;
export const CleaningTypeSchema = z.enum(CLEANING_TYPES);

export const CLEANING_FREQUENCIES = [
  'One-time',
  'Weekly',
  'Every two weeks',
  'Monthly',
] as const;
export const CleaningFrequencySchema = z.enum(CLEANING_FREQUENCIES);

export const CLEANING_EXTRAS = [
  'Inside oven',
  'Inside fridge',
  'Inside windows',
  'Laundry',
  'Dishes',
  'Baseboards',
] as const;
export const CleaningExtraSchema = z.enum(CLEANING_EXTRAS);

// Square footage range — added in #114. "X bedroom" alone tells a
// cleaner almost nothing about price (a 2BR can be 800 sqft or 2,200
// sqft). We ask for a range bucket because most customers don't know
// exact sqft of rentals/condos but can pick a bucket. Surfaced to the
// AI assistant as `square_footage_range` so the contractor can quote
// more accurately on the first call.
export const SQUARE_FOOTAGE_RANGES = [
  'Under 800 sqft',
  '800–1,200 sqft',
  '1,200–1,800 sqft',
  '1,800–2,500 sqft',
  '2,500–3,500 sqft',
  '3,500+ sqft',
] as const;
export const SquareFootageRangeSchema = z.enum(SQUARE_FOOTAGE_RANGES);

// ─── Dates ────────────────────────────────────────────────────────

// Accepts ISO yyyy-mm-dd from <input type="date">. Must be today or
// later. Duplicated from moving-intake to keep this file standalone-
// friendly; refactor into shared primitives module if a third vertical
// gets this same constraint.
function isTodayOrLater(isoDate: string): boolean {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  return isoDate >= todayIso;
}

export const EarliestDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date')
  .refine(isTodayOrLater, 'Earliest date must be today or in the future');

// ─── Step schemas ─────────────────────────────────────────────────

// Step 1 — where to clean.
//
// Optional `lat` / `lng` come from a Google Place Details pick — the
// address-autocomplete component returns them via onSelectAddress.
// Both nullable on the schema because manual ("use custom") entries
// won't have them. Used downstream by the on-demand business seeder
// + the radius selector in lib/calls/select-businesses.ts.
export const LocationSchema = z.object({
  address: z.string().trim().min(3, 'Please enter a street address'),
  city: z.string().trim().min(2, 'City required'),
  state: UsStateSchema,
  zip: ZipSchema,
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

// Step 2 — about the home.
// `pets` is optional per the seed (required:false), so we accept an
// empty-string transform to undefined for the form's raw state.
// `square_footage_range` is mandatory (#114) — see SQUARE_FOOTAGE_RANGES
// above for rationale.
export const HomeSchema = z.object({
  home_size: HomeSizeSchema,
  bathrooms: BathroomsSchema,
  square_footage_range: SquareFootageRangeSchema,
  pets: PetsSchema.optional().or(z.literal('').transform(() => undefined)),
});

// Step 3 — what kind of clean.
export const ServiceSchema = z.object({
  cleaning_type: CleaningTypeSchema,
  frequency: CleaningFrequencySchema,
  earliest_date: EarliestDateSchema,
  extras: z.array(CleaningExtraSchema).default([]),
  additional_notes: z
    .string()
    .trim()
    .max(1000, 'Keep notes under 1,000 characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

// Step 4 — contact.
// Same shape as moving's ContactSchema but redefined here so the
// cleaning form is self-contained.
export const ContactSchema = z.object({
  contact_name: z.string().trim().min(2, 'Your name'),
  contact_phone: PhoneSchema,
  contact_email: EmailSchema,
});

// ─── Full intake ─────────────────────────────────────────────────

// See moving-intake.ts for the rationale on merging UTMs at the full-
// schema level rather than a step. Same shape, same persistence path.
export const CleaningIntakeSchema = LocationSchema.merge(HomeSchema)
  .merge(ServiceSchema)
  .merge(ContactSchema)
  .merge(UtmsSchema);

export type CleaningIntakeData = z.infer<typeof CleaningIntakeSchema>;
export type CleaningIntakeDraft = Partial<CleaningIntakeData>;

// ─── Step metadata ───────────────────────────────────────────────

export const STEPS = [
  { id: 'location', title: 'Where', label: 'Step 1 of 5' },
  { id: 'home', title: 'Home', label: 'Step 2 of 5' },
  { id: 'service', title: 'Service', label: 'Step 3 of 5' },
  { id: 'contact', title: 'Contact', label: 'Step 4 of 5' },
  { id: 'review', title: 'Review', label: 'Step 5 of 5' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

export const STEP_SCHEMAS = {
  location: LocationSchema,
  home: HomeSchema,
  service: ServiceSchema,
  contact: ContactSchema,
  review: CleaningIntakeSchema,
} as const;
