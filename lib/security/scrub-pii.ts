// PII scrubber for free-text fields that flow to outbound Vapi calls.
//
// Customer-provided free text (intake `additional_notes`, `special_items`
// extras descriptions, anything else a customer can type) is the most
// likely accidental-leak path: the customer might write
//   "call me back at 555-123-4567"
// or
//   "email me at john@example.com if you can do it for $300"
// and we'd otherwise hand that string verbatim to the AI assistant,
// which would then read it aloud to a stranger.
//
// We can't rely on the assistant prompt alone to suppress this — that's
// a prompt-injection surface. Strip at the source instead.
//
// Defense-in-depth pairing:
//   1. THIS FILE — server-side scrub of free-text fields BEFORE they
//      reach `assistantOverrides.variableValues`.
//   2. lib/calls/build-safe-variable-values.ts — allowlist-based field
//      filter so even if a new free-text field is added, it doesn't
//      flow to Vapi unless explicitly allowed.
//   3. Vapi assistant system prompt — hard rule: "never disclose
//      customer name/phone/email/street address."
// All three layers must hold for a leak. Any one of them holding
// independently prevents disclosure.
//
// Intentional non-goals:
//   • SSN / credit card / DOB scrubbing — we never collect these.
//   • International phone formats — US-only product today; revisit
//     when we expand.
//   • Address scrubbing in free text — too lossy, and our intake
//     captures structured `address` separately. Free-text addresses
//     in `additional_notes` like "I live behind the Walgreens on Main"
//     don't read as PII to the same risk level.

const REDACT = '[redacted]';

// ── US phone numbers ─────────────────────────────────────────────────
// Catches the common formats:
//   555-123-4567
//   555.123.4567
//   555 123 4567
//   (555) 123-4567
//   +1 555 123 4567
//   +15551234567
//   5551234567
// NOT permissive on country codes — US-only product today.
const PHONE_PATTERNS: RegExp[] = [
  // +1 with optional separators, then 3-3-4
  /\+\s?1[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
  // (xxx) xxx-xxxx (parens form, no country code)
  /\(\d{3}\)\s?\d{3}[\s.-]?\d{4}/g,
  // xxx-xxx-xxxx, xxx.xxx.xxxx, xxx xxx xxxx (with separators)
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,
  // 10 raw digits — only when standalone (\b boundaries) so we don't
  // strip dollar amounts or order numbers.
  /\b\d{10}\b/g,
];

// ── Email addresses ─────────────────────────────────────────────────
// Conservative pattern. Local-part and domain validation isn't
// rigorous because we're erring on the side of redacting maybe-emails
// rather than missing real ones.
const EMAIL_PATTERN: RegExp = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/**
 * Scrub PII from a free-text string. Idempotent — running twice
 * produces the same result as running once. Safe on null/undefined.
 *
 * Truncates to `maxLength` (default 500) AFTER scrubbing so very long
 * notes don't blow up the variableValues payload.
 */
export function scrubPii(input: string | null | undefined, maxLength = 500): string {
  if (!input) return '';
  let out = input;

  for (const pattern of PHONE_PATTERNS) {
    out = out.replace(pattern, REDACT);
  }
  out = out.replace(EMAIL_PATTERN, REDACT);

  // Collapse runs of [redacted] [redacted] (e.g. "555-1234 555-1234")
  // into a single [redacted] for readability when the AI reads it.
  out = out.replace(/(\[redacted\]\s*){2,}/g, `${REDACT} `);

  // Trim and length-cap.
  out = out.trim().slice(0, maxLength);

  return out;
}
