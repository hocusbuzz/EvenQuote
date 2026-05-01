// Handyman intake form — Zod schemas.
//
// Mirrors the shape of cleaning-intake / moving-intake so the form
// machinery (form-shell, step nav, validation hook) is parallel and
// reusable. Reusable primitives (ZipSchema, PhoneSchema, UsStateSchema,
// EmailSchema) are imported from moving-intake — they're not moving-
// specific and deserve to live in a shared module eventually, but
// importing from the first caller is fine for now.
//
// Shape mirrors the intake_form_schema JSONB seeded in
// supabase/seed/0002_multi_vertical_categories.sql for the 'handyman'
// category — if you edit the seed, update this and vice versa.
//
// Why fewer steps than cleaning (4 vs 5):
//   • Handyman doesn't have a separate "service" step — `job_type`
//     IS the service category, so we collapse home + service into a
//     single "job" step.
//   • Steps: location → job → contact → review.

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

// ─── Handyman-specific enums ──────────────────────────────────────

// Job categories — one bucket per common ask. Source-of-truth is the
// seed JSONB; keep these in sync. We deliberately keep the list short
// (10 buckets) so the contractor on the phone can quickly recognize
// "yes I do that" or "no, that's outside my wheelhouse" — long lists
// fragment the supply side.
export const JOB_TYPES = [
  'Mount / install',
  'Assemble furniture',
  'Minor electrical (fan, fixture)',
  'Minor plumbing (faucet, toilet)',
  'Drywall repair',
  'Painting (small area)',
  'Door / lock repair',
  'Hang shelves / art',
  'Yard cleanup',
  'Other',
] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);

// Rough job size — the customer's estimate, not contractor's quote.
// The contractor will refine on the phone, but a customer's "1-2 hours"
// vs "multiple days" is a strong signal for the AI to ask the right
// follow-ups (e.g., a "multiple days" job almost always needs an
// onsite visit before quoting).
export const JOB_SIZES = [
  'Under an hour',
  '1–2 hours',
  'Half day',
  'Full day',
  'Multiple days',
] as const;
export const JobSizeSchema = z.enum(JOB_SIZES);

// ─── Dates ────────────────────────────────────────────────────────

// Accepts ISO yyyy-mm-dd from <input type="date">. Must be today or
// later. Duplicated from moving-intake / cleaning-intake to keep this
// file standalone-friendly; refactor into shared primitives module if
// a fourth vertical needs the same constraint.
function isTodayOrLater(isoDate: string): boolean {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  return isoDate >= todayIso;
}

export const IdealDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date')
  .refine(isTodayOrLater, 'Ideal date must be today or in the future');

// ─── Step schemas ─────────────────────────────────────────────────

// Step 1 — where the work is.
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

// Step 2 — about the job.
//
// `job_description` is required (min 10 chars) because handyman pricing
// is wildly variable and the AI needs context beyond the bucket. A
// 10-char minimum nudges the customer past "fix it" (3 chars, useless)
// without being pedantic. Cap at 1,000 chars for sanity.
//
// `materials_needed` is a tri-state in spirit (yes / no / unsure) but
// represented as boolean optional — undefined means "didn't say,
// contractor should ask". UI maps to a Yes/No/Skip group.
export const JobSchema = z.object({
  job_type: JobTypeSchema,
  job_size: JobSizeSchema,
  job_description: z
    .string()
    .trim()
    .min(10, 'A sentence or two helps the handyman quote accurately')
    .max(1000, 'Keep description under 1,000 characters'),
  ideal_date: IdealDateSchema,
  materials_needed: z.boolean().optional(),
});

// Step 3 — contact.
// Same shape as moving + cleaning ContactSchema but redefined here so
// the handyman form is self-contained.
export const ContactSchema = z.object({
  contact_name: z.string().trim().min(2, 'Your name'),
  contact_phone: PhoneSchema,
  contact_email: EmailSchema,
});

// ─── Full intake ─────────────────────────────────────────────────

// See moving-intake.ts for the rationale on merging UTMs at the full-
// schema level rather than a step. Same shape, same persistence path.
export const HandymanIntakeSchema = LocationSchema.merge(JobSchema)
  .merge(ContactSchema)
  .merge(UtmsSchema);

export type HandymanIntakeData = z.infer<typeof HandymanIntakeSchema>;
export type HandymanIntakeDraft = Partial<HandymanIntakeData>;

// ─── Step metadata ───────────────────────────────────────────────

export const STEPS = [
  { id: 'location', title: 'Where', label: 'Step 1 of 4' },
  { id: 'job', title: 'Job', label: 'Step 2 of 4' },
  { id: 'contact', title: 'Contact', label: 'Step 3 of 4' },
  { id: 'review', title: 'Review', label: 'Step 4 of 4' },
] as const;

export type StepId = (typeof STEPS)[number]['id'];

export const STEP_SCHEMAS = {
  location: LocationSchema,
  job: JobSchema,
  contact: ContactSchema,
  review: HandymanIntakeSchema,
} as const;
