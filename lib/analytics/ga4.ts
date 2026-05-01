// GA4 client — both client-side (gtag) and server-side (Measurement Protocol).
//
// Provider-specific module. The neighboring `track.ts` is the
// provider-agnostic surface that fans out to all enabled providers
// (GA4 today, Meta + Reddit when their IDs land).
//
// ─── Client-side ────────────────────────────────────────────────
//
// `<GA4Script>` (./ga4-script.tsx) injects the `gtag.js` snippet into
// the root layout when NEXT_PUBLIC_GA4_MEASUREMENT_ID is set. This
// module only exposes the runtime helper that fires events through
// the global `gtag()` function the snippet creates.
//
// We deliberately do NOT eagerly read from `window.gtag` at module
// import time — Next compiles this file for both the server build
// (where `window` is undefined) and the client build (where the gtag
// script may not have loaded yet by the time imports settle). All
// access is guarded inside the helper functions.
//
// ─── Server-side ────────────────────────────────────────────────
//
// `sendServerEvent` POSTs to the GA4 Measurement Protocol endpoint
// using GA4_API_SECRET (the secret never reaches the client). Used
// for events that fire from server contexts with no live client:
//   • quote_delivered  — from the send-reports cron after Resend OK
//   • (future) quote_request_paid — backstop for the client-side fire
//     on /get-quotes/success in case the user closes the tab before
//     the page loads. Not wired today; #126 follow-up.
//
// The Measurement Protocol requires a `client_id` per event. For
// server-fired events we synthesize a stable per-request id so a
// single quote_request shows up as one user-journey rather than
// fragmented across random ids. Imperfect (a real session client_id
// would be better) but adequate for funnel counting at our volume.

import { ANALYTICS_EVENTS, type AnalyticsEventName, type AnalyticsEventParams } from './events';

// Re-exported so callers can pass the precise type without reaching
// into ./events directly. Keeps the import surface narrow.
export type { AnalyticsEventName, AnalyticsEventParams };
export { ANALYTICS_EVENTS };

// ──────────────────────────────────────────────────────────────────
// Client-side
// ──────────────────────────────────────────────────────────────────

// The gtag global is augmented by the GA4 snippet. We declare a loose
// type so TS lets us call `window.gtag('event', ...)` without an `as`.
declare global {
  interface Window {
    gtag?: (
      command: 'event' | 'config' | 'set' | 'consent',
      ...args: unknown[]
    ) => void;
    dataLayer?: unknown[];
  }
}

/**
 * Fire a GA4 event from the browser. Safe to call before gtag has
 * loaded — the snippet defines `window.dataLayer.push` first, so even
 * an early call will queue and replay once gtag.js arrives. We still
 * guard against `window === undefined` for the SSR/RSC pass.
 *
 * Returns true if a fire was attempted, false if the env wasn't ready
 * (useful for tests but ignored in production).
 */
export function gaClientEvent(
  name: AnalyticsEventName,
  params: AnalyticsEventParams = {}
): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.gtag !== 'function') {
    // gtag.js hasn't loaded yet — the snippet's dataLayer.push will
    // replay queued events when it does. Push directly to keep the
    // call from being dropped. Shape matches what gtag('event', ...)
    // would emit.
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: name, ...params });
      return true;
    }
    return false;
  }
  window.gtag('event', name, params);
  return true;
}

// ──────────────────────────────────────────────────────────────────
// Server-side (Measurement Protocol)
// ──────────────────────────────────────────────────────────────────

const MEASUREMENT_PROTOCOL_URL = 'https://www.google-analytics.com/mp/collect';

/**
 * Fire a GA4 event from a server context (Stripe webhook, cron, etc.).
 *
 * No-op when either env var is missing — production must have both,
 * but local dev / staging / test should NEVER spam the prod GA4
 * stream, and a missing-secret deploy still needs to boot. The /api/
 * health endpoint surfaces feature readiness so this isn't silent.
 *
 * `clientId` is the GA4 user-ish identifier. For events that have an
 * obvious unique handle (a quote_request_id), pass that — events with
 * the same client_id stitch into the same "user" in GA4 explorations.
 * For events without one, callers should pass crypto.randomUUID() or
 * a stable per-request hash.
 *
 * Errors are swallowed and logged. We never want analytics to break a
 * payment-success path or a report-send path. The cost of one missed
 * event is low; the cost of a thrown exception in a webhook is a 500
 * that Stripe will retry forever.
 */
export async function sendServerEvent(args: {
  name: AnalyticsEventName;
  clientId: string;
  params?: AnalyticsEventParams;
}): Promise<{ ok: boolean; reason?: string }> {
  const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  if (!measurementId || !apiSecret) {
    return { ok: false, reason: 'ga4-not-configured' };
  }

  const url = `${MEASUREMENT_PROTOCOL_URL}?measurement_id=${encodeURIComponent(
    measurementId
  )}&api_secret=${encodeURIComponent(apiSecret)}`;

  const body = JSON.stringify({
    client_id: args.clientId,
    // non_personalized_ads: true keeps these events out of Google's
    // ads-targeting graph — we don't run remarketing through GA4 (Meta
    // and Reddit do their own pixels), and this is the privacy-
    // friendliest default. Flip to false later if we add GA-driven ads.
    non_personalized_ads: true,
    events: [
      {
        name: args.name,
        params: args.params ?? {},
      },
    ],
  });

  try {
    // Measurement Protocol returns 204 No Content on success; it does
    // not respond with an error body for malformed events (use the
    // /debug/mp/collect endpoint for validation). We treat any 2xx
    // as success and log everything else without throwing.
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      // Keepalive so a serverless function shutting down right after
      // the call doesn't drop the request. Vercel functions have an
      // event-loop drain but this is belt-and-suspenders.
      keepalive: true,
    });

    if (!res.ok) {
      return { ok: false, reason: `mp-${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'fetch-failed',
    };
  }
}
