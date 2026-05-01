// UTM attribution — schema, types, and URL parser.
//
// Five standard utm_* parameters land on /get-quotes from paid campaigns
// (Google Ads, Meta, Reddit) plus partnership / referral links. They
// flow:
//
//   1. URL search params → utm-capture.tsx (client) → utms-store
//      (Zustand, persisted in localStorage so the user can refresh /
//      navigate to /get-quotes/handyman without losing them)
//   2. Form shell reads from utms-store at submit time, merges into
//      the form payload
//   3. Intake server action validates with UtmsSchema (all optional,
//      length-capped strings) and writes utm_* columns on the new
//      quote_requests row
//   4. Cohort / CAC analysis (planned: backlog #5) joins on these
//
// Why a single shared module rather than per-vertical fields:
//   • All three live verticals (moving, cleaning, handyman) need the
//     same five fields with the same shape. Duplicating into each
//     intake schema would be drift waiting to happen.
//   • Migration 0015_quote_requests_utm_columns.sql adds the columns
//     to quote_requests once, not per category.
//
// Length cap (200): real Google/Meta UTMs are ≤150 chars in practice;
// 200 leaves headroom for partnership tags ("leasing-office-saint-
// francis-courts-spring-2026") without inviting abuse / DB bloat.

import { z } from 'zod';

// Five canonical UTM keys. Listed in capture / persist / DB-column
// order so it's easy to grep across the layers and confirm parity.
export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

// Per-field validator. All optional — direct/organic traffic legitimately
// has none, and pre-launch rows have none either. Empty strings are
// coerced to undefined before validation so a stray "?utm_source="
// doesn't poison the row with a truthy-empty value.
const SingleUtmField = z
  .string()
  .trim()
  .min(1, 'utm value cannot be empty after trim')
  .max(200, 'utm value too long (max 200 chars)')
  .optional();

export const UtmsSchema = z.object({
  utm_source: SingleUtmField,
  utm_medium: SingleUtmField,
  utm_campaign: SingleUtmField,
  utm_content: SingleUtmField,
  utm_term: SingleUtmField,
});

export type Utms = z.infer<typeof UtmsSchema>;

/**
 * Pull UTM params out of a URLSearchParams (or anything iterable of
 * [key, value] pairs — `useSearchParams()` returns a ReadonlyURLSearchParams
 * which is API-compatible).
 *
 * Returns an object containing only the keys that were actually present
 * AND non-empty, so callers can do `Object.keys(parseUtms(...)).length`
 * to detect "URL had no UTMs at all" without a separate flag.
 *
 * Discards any key not in UTM_KEYS — we don't accept arbitrary marketing
 * params here. `gclid` / `fbclid` are tracked separately by the analytics
 * pixels themselves; we don't need them on the row.
 */
export function parseUtmsFromSearchParams(
  params: URLSearchParams | { get: (key: string) => string | null }
): Utms {
  const result: Utms = {};
  for (const key of UTM_KEYS) {
    const raw = params.get(key);
    if (raw == null) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 200) {
      // Don't crash — just truncate. A 1KB utm_campaign on the wire
      // is more likely a malformed URL or an attacker probe than a
      // real ad. Persisting a truncated value is more useful than
      // refusing the whole row.
      result[key] = trimmed.slice(0, 200);
    } else {
      result[key] = trimmed;
    }
  }
  return result;
}

/**
 * Are any UTMs present? Cheap helper for the capture component to
 * decide whether to overwrite the persisted store. We use last-touch
 * attribution: if the new URL has any UTMs, replace; otherwise leave
 * the existing values alone.
 */
export function hasAnyUtms(utms: Utms): boolean {
  return UTM_KEYS.some((k) => utms[k] != null);
}
