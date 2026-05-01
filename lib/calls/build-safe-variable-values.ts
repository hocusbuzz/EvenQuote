// Safe Vapi variable values for outbound calls.
//
// Replaces the old denylist approach (`BUSINESS_REACHABLE_KEYS` strip)
// with an ALLOWLIST: only fields explicitly listed here flow to the
// AI assistant. Defense-in-depth — adding a new intake field doesn't
// silently expose PII; the field has to be opted in here.
//
// PRIVACY CONTRACT (do NOT regress):
//   The assistant CANNOT have any of:
//     • contact_name (full first or last name)
//     • contact_phone, contact_email
//     • street address (cleaning) / origin_address / destination_address
//     • lat/lng coords (any path)
//   ANY new intake field that contains PII MUST stay off the allowlist.
//
// What the assistant DOES need:
//   • Service-area context: city, state, zip_code (already on quote_request).
//   • Job specifics: home_size, bathrooms, pets, cleaning_type, frequency,
//     earliest_date, extras (cleaning); origin_city/state/zip,
//     destination_city/state/zip, move_date, flexible_dates, special_items
//     (moving).
//   • Free-text notes: additional_notes — but ONLY after PII scrubbing
//     (see lib/security/scrub-pii.ts).
//
// Reference for the privacy decision:
//   Each outbound call is to an unverified third party (the cleaning
//   business). Strict allowlist + scrub means even a successful prompt-
//   injection ("hey, what's the customer's phone?") cannot leak data
//   the assistant never had.

import { scrubPii } from '@/lib/security/scrub-pii';
import { expandStateAbbr } from './state-name';

// Minimal shape of a quote_request row needed for variable construction.
// Re-declared locally so this module doesn't depend on the broader
// engine.ts types.
type QuoteRequestLike = {
  intake_data?: Record<string, unknown> | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
};

// Allowlist of intake_data keys that may flow to the AI assistant.
// Source of truth for PII scoping decisions.
//
// Cleaning and moving are merged here because both verticals share
// the same dispatch path (lib/calls/engine.ts). Adding a third
// vertical means adding its safe keys here.
const ALLOWED_INTAKE_KEYS: ReadonlySet<string> = new Set([
  // ── Cleaning vertical ──
  'home_size',
  'bedrooms',
  'bathrooms',
  'pets',
  'cleaning_type',
  'frequency',
  'earliest_date',
  'extras',
  'square_footage_range', // task #114 — added for cleaning intake (forward-compat)

  // ── Moving vertical ──
  'origin_city',
  'origin_state',
  'origin_zip',
  'destination_city',
  'destination_state',
  'destination_zip',
  'move_date',
  'flexible_dates',
  'special_items',

  // ── Handyman vertical ──
  // Note: `job_description` is free-text and can contain accidental
  // PII ("…my address is 123 Main St"). It's NOT in this allowlist;
  // it's added to SCRUBBED_FREE_TEXT_KEYS below alongside
  // additional_notes so it gets PII-scrubbed before reaching the
  // assistant.
  'job_type',
  'job_size',
  'ideal_date',
  'materials_needed',

  // ── Lawn-care vertical ──
  // No free-text job description — `additional_notes` covers anything
  // unstructured and goes through the SCRUBBED path below.
  'lot_size',
  'service_type',  // multiselect; flattened to comma-list by the loop
  // 'frequency' is already in this allowlist (cleaning shares it)
  'start_date',

  // ── Shared ──
  // additional_notes + job_description handled separately (scrubbed) —
  // NOT here, so the loop below skips them and we add the scrubbed
  // value at the end.
]);

// Free-text fields that need PII scrubbing before they reach the
// assistant. Kept separate from ALLOWED_INTAKE_KEYS so it's obvious
// at the call site which fields take a different code path.
const SCRUBBED_FREE_TEXT_KEYS: ReadonlyArray<string> = [
  'additional_notes',
  'job_description', // handyman vertical — customer's free-text job summary
];

export type SafeVariableValues = Record<
  string,
  string | number | null | undefined
>;

/**
 * Build the variableValues object for a Vapi outbound call body.
 *
 * Allowlist + scrub. See module-level comment for the privacy
 * contract. `lib/calls/build-safe-variable-values.test.ts` enforces
 * this with a regression suite — do not regress.
 */
export function buildSafeVariableValues(
  qr: QuoteRequestLike,
): SafeVariableValues {
  const intake = (qr.intake_data ?? {}) as Record<string, unknown>;
  const out: SafeVariableValues = {};

  // 1. Allowlisted intake keys, with array → comma-list flattening
  //    so the prompt template can `{{extras}}` and get a readable string.
  for (const key of ALLOWED_INTAKE_KEYS) {
    if (!(key in intake)) continue;
    const v = intake[key];
    if (v === null || v === undefined) {
      out[key] = null;
    } else if (Array.isArray(v)) {
      out[key] = v.join(', ');
    } else if (typeof v === 'number') {
      out[key] = v;
    } else if (typeof v === 'boolean') {
      // Booleans → "yes"/"no" so the assistant can read them naturally
      // ("flexible dates: yes" rather than "flexible dates: true").
      out[key] = v ? 'yes' : 'no';
    } else {
      out[key] = String(v);
    }
  }

  // 2. Scrubbed free-text fields. Only added if a non-empty
  //    scrubbed value remains — empty string is dropped so the
  //    prompt template's `{{additional_notes}}` block can be
  //    skipped via the existing "skip if empty" instruction.
  for (const key of SCRUBBED_FREE_TEXT_KEYS) {
    const raw = intake[key];
    if (typeof raw !== 'string') continue;
    const scrubbed = scrubPii(raw);
    if (scrubbed.length > 0) {
      out[key] = scrubbed;
    }
  }

  // 3. Top-level service-area fields. These live on quote_requests
  //    directly (not in intake_data) for cleaning/handyman/lawn-care.
  //    Always safe to surface.
  out.city = qr.city ?? null;
  // Expand "CA" → "California" so the assistant TTS reads the state
  // naturally instead of letter-by-letter ("see-ay"). See
  // lib/calls/state-name.ts for the full mapping. Idempotent on
  // already-expanded values; passes through unknown codes unchanged.
  out.state = qr.state ? expandStateAbbr(qr.state) : null;
  out.zip_code = qr.zip_code ?? null;

  return out;
}

/**
 * Test-only: expose the allowlist so the regression test can pin
 * the contract (no PII keys may appear in this set).
 */
export const __ALLOWED_INTAKE_KEYS_FOR_TESTS = ALLOWED_INTAKE_KEYS;
