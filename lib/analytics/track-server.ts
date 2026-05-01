import 'server-only';

// Server-side fan-out for the analytics layer.
//
// Sibling of ./track.ts. Split into a separate file so importing
// `trackClient` from a client component doesn't pull the GA4
// Measurement Protocol secret-reading code into the browser bundle.
// `import 'server-only'` makes the boundary load-bearing — Next will
// throw at build time if a client component imports this file.
//
// Same fan-out shape as the client side. Today: GA4 Measurement
// Protocol only. Future: Meta Conversions API + Reddit Conversions
// API will fan out alongside when their secrets land.

import { sendServerEvent } from './ga4';
import { sendMetaServerEvent } from './meta';
import type { AnalyticsEventName, AnalyticsEventParams } from './events';

/**
 * Fire a semantic event from a server context (Stripe webhook, cron,
 * server action). Fans out to all enabled server-side providers and
 * resolves once every provider returns.
 *
 * Per-provider failures are swallowed — analytics MUST NOT break a
 * payment-success or report-send code path. Failures are reported in
 * the return shape so callers can structured-log if they care.
 */
export async function trackServer(args: {
  name: AnalyticsEventName;
  /**
   * Stable identifier for the user-journey this event belongs to.
   * For events tied to a quote_request, pass the quote_request.id —
   * it correlates well in GA4's user explorations and becomes the
   * (hashed) external_id on Meta CAPI's side. Opaque, not personally
   * identifying.
   */
  clientId: string;
  params?: AnalyticsEventParams;
}): Promise<{
  ga4: { ok: boolean; reason?: string };
  meta: { ok: boolean; reason?: string };
}> {
  // Run both providers in parallel — they're independent fetches with
  // ~100-300ms latency each. Sequential would double the cron's
  // analytics overhead per request.
  const [ga4, meta] = await Promise.all([
    sendServerEvent({
      name: args.name,
      clientId: args.clientId,
      params: args.params,
    }),
    sendMetaServerEvent({
      name: args.name,
      clientId: args.clientId,
      params: args.params,
    }),
  ]);
  return { ga4, meta };
}
