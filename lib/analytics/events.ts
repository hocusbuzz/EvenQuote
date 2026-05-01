// Canonical analytics event vocabulary.
//
// Three events feed the Day-8 paid-traffic measurement loop:
//
//   • quote_request_started — fired on first form-field touch in any
//     intake form. Client-side (gtag). Top of the funnel; the
//     denominator for "of people who started, what % paid?".
//
//   • quote_request_paid — fired after Stripe checkout succeeds and
//     the customer lands on /get-quotes/success. Client-side (gtag).
//     The conversion event for paid-traffic optimization.
//
//   • quote_delivered — fired server-side from the send-reports cron
//     after the report email actually ships via Resend. Used for
//     refund-rate proxy + product-quality measurement, not paid
//     attribution.
//
// Why a single source-of-truth event vocab:
//   • Ad-platform conversion rules have to match these EXACT names.
//     A typo on the GA4 side ("quote_paid" vs "quote_request_paid")
//     means the conversion never registers.
//   • Future: Meta + Reddit pixels will fire the same event names so
//     cross-platform CAC math stays apples-to-apples.
//
// PII contract: event params NEVER include name / email / phone /
// address / Stripe payment ids. The GA4 dashboard is shared — anything
// in event params is visible to anyone with access. Allowed fields are
// vertical (moving|cleaning|handyman), value (USD numeric), currency
// ('USD'), and the request_id (an opaque uuid that's not personally
// identifying on its own). Match the type below to the dashboard
// configuration.

export const ANALYTICS_EVENTS = [
  'quote_request_started',
  'quote_request_paid',
  'quote_delivered',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/**
 * Allowed shape for event parameters. Deliberately narrow to keep PII
 * out of analytics. If you need to add a new param, add it here AND
 * make sure it isn't sensitive — the GA4 dashboard is widely-readable.
 */
export type AnalyticsEventParams = {
  /** Vertical the request belongs to. Aligns with the service_categories.slug values. */
  vertical?: 'moving' | 'cleaning' | 'handyman' | 'lawn-care' | 'junk-removal';
  /** USD value (e.g., 9.99 for the standard request fee). */
  value?: number;
  /** Currency code. Always 'USD' today; here as a reminder if we ever launch internationally. */
  currency?: 'USD';
  /** Opaque request id (uuid). Useful for de-dup across server-side + client-side fires. */
  request_id?: string;
};
