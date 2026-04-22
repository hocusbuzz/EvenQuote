// E.164 phone normalization for the ingest pipeline.
//
// MVP scope: US/CA (NANP) numbers only. That's fine for the moving-quote
// launch — every business we're pulling from Google Places lives in a
// single country per ingest run.
//
// When we go international, swap this for `libphonenumber-js`:
//   pnpm add libphonenumber-js
//   parsePhoneNumber(raw, countryCode).number → '+...' E.164
// Until then, a hand-rolled normalizer is zero-dep and good enough.

const NANP_E164_RE = /^\+1[2-9]\d{2}[2-9]\d{2}\d{4}$/;

/**
 * Normalize a phone string to E.164. Returns null for anything we can't
 * confidently normalize — callers should treat that as "business is
 * uncallable, don't ingest".
 *
 * Accepts:
 *   '+1 415-555-0100', '(415) 555-0100', '415.555.0100', '4155550100',
 *   '1-415-555-0100', '+1-415-555-0100'
 *
 * Rejects:
 *   Empty, too-short, anything not resolving to a 10-digit NANP number.
 */
export function normalizeToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Strip everything except digits and a leading +
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) return null;

  let e164: string;

  if (hadPlus && digits.length >= 11) {
    // Caller supplied an international number. We only accept +1 for MVP.
    if (!digits.startsWith('1')) return null;
    e164 = `+${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    // '1' + 10-digit NANP
    e164 = `+${digits}`;
  } else if (digits.length === 10) {
    // Bare NANP, no country code
    e164 = `+1${digits}`;
  } else {
    return null;
  }

  return NANP_E164_RE.test(e164) ? e164 : null;
}
