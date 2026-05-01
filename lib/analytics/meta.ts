// Meta Pixel client — both client-side (fbq) and server-side (Conversions API).
//
// Provider-specific module, peer of ./ga4.ts. Wired into the cross-
// provider fan-out in ./track.ts (client) and ./track-server.ts
// (server) so callers don't have to know about Meta directly.
//
// ─── Event mapping ───────────────────────────────────────────────
//
// Meta Pixel has STANDARD events with built-in optimization (Lead,
// Purchase, etc.) and CUSTOM events. Our funnel maps to standards
// where possible because Meta's ad-bidding algorithms only train on
// standards by default:
//
//   quote_request_started → Lead
//   quote_request_paid    → Purchase  (with value + currency)
//   quote_delivered       → custom 'QuoteDelivered'  (no Meta standard fits)
//
// The mapping lives in this file so the call sites stay vertical-
// aware via our own AnalyticsEventName vocab.
//
// ─── Client-side ─────────────────────────────────────────────────
//
// `<MetaPixelScript>` (./meta-script.tsx) injects the pixel snippet
// into the root layout when NEXT_PUBLIC_META_PIXEL_ID is set. This
// module exposes the runtime helper that fires events through
// `window.fbq()`.
//
// The Pixel's snippet auto-fires PageView on init, so route changes
// in the App Router get a baseline pageview without us doing
// anything. We DON'T re-fire PageView from our own track() calls.
//
// ─── Server-side ─────────────────────────────────────────────────
//
// Meta's Conversions API (CAPI) requires the META_CONVERSIONS_API_TOKEN
// access token (separate from the Pixel ID). When it's missing the
// server-side path is a no-op. Implemented as a stub today (#127
// follow-up) — for the Day-8 launch the client-side Pixel covers the
// two highest-impact events; quote_delivered is a server-only event
// which CAPI would handle but is GA4-only for now.

import type { AnalyticsEventName, AnalyticsEventParams } from './events';

// Re-exports for convenience at call sites.
export type { AnalyticsEventName, AnalyticsEventParams };

// ──────────────────────────────────────────────────────────────────
// Event-name mapping: our vocab → Meta's vocab
// ──────────────────────────────────────────────────────────────────

type MetaEventSpec =
  // Standard events: fired via fbq('track', ...). Meta's optimizer
  // recognizes these and bids accordingly.
  | { kind: 'standard'; name: 'Lead' | 'Purchase' }
  // Custom events: fired via fbq('trackCustom', ...). Meta tracks
  // them but doesn't auto-optimize toward them — fine for our
  // analytics-only event (quote_delivered).
  | { kind: 'custom'; name: string }
  // Skip: event has no useful Meta mapping (e.g. quote_delivered
  // server-side has no client gtag-equivalent). Caller no-ops.
  | { kind: 'skip' };

const META_EVENT_MAP: Record<AnalyticsEventName, MetaEventSpec> = {
  quote_request_started: { kind: 'standard', name: 'Lead' },
  quote_request_paid: { kind: 'standard', name: 'Purchase' },
  // Server-only event today — the client-side fan-out will see this
  // event name only if a future code path fires it from the browser.
  // Pre-mapped so the addition wouldn't need a follow-up edit.
  quote_delivered: { kind: 'custom', name: 'QuoteDelivered' },
};

// ──────────────────────────────────────────────────────────────────
// Client-side
// ──────────────────────────────────────────────────────────────────

// fbq global, defined by the snippet in meta-script.tsx.
declare global {
  interface Window {
    fbq?: (
      command: 'init' | 'track' | 'trackCustom' | 'consent',
      ...args: unknown[]
    ) => void;
    _fbq?: unknown;
  }
}

/**
 * Fire a Meta Pixel event from the browser. Resolves the canonical
 * event name → Meta's standard or custom name and dispatches via
 * `window.fbq`. Maps our `value` / `currency` / `request_id` params
 * into Meta's expected shape (Meta uses the same key names for
 * value+currency, plus `content_ids` array for the request id).
 *
 * Returns true if a fire was attempted, false if the env wasn't ready
 * or the event has no Meta mapping.
 */
export function metaClientEvent(
  name: AnalyticsEventName,
  params: AnalyticsEventParams = {}
): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.fbq !== 'function') return false;

  const spec = META_EVENT_MAP[name];
  if (spec.kind === 'skip') return false;

  // Meta's well-known param names. Anything not on this list is dropped
  // by Meta's matching anyway — we keep the wire small.
  const metaParams: Record<string, unknown> = {};
  if (params.value !== undefined) metaParams.value = params.value;
  if (params.currency !== undefined) metaParams.currency = params.currency;
  if (params.request_id !== undefined) {
    // Meta expects content_ids as an array. We use the request_id so a
    // Purchase event correlates with the upstream Lead via the same id.
    metaParams.content_ids = [params.request_id];
    metaParams.content_type = 'product';
  }

  if (spec.kind === 'standard') {
    window.fbq('track', spec.name, metaParams);
  } else {
    window.fbq('trackCustom', spec.name, metaParams);
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────
// Server-side stub (Conversions API)
// ──────────────────────────────────────────────────────────────────

/**
 * Fire a Meta CAPI event from a server context. STUB today.
 *
 * Returns `{ ok: false, reason: 'capi-not-wired' }` when the access
 * token isn't set OR when the CAPI path isn't implemented yet.
 *
 * Why not implemented for the Day-8 launch:
 *   • CAPI requires a payload of "user_data" identifiers (hashed
 *     email / phone / IP / user-agent + Meta cookie fbp / fbc) that
 *     we don't have on the server side without plumbing the cookies
 *     through from the request that fires the event.
 *   • The client-side Pixel covers the two ad-bidding-relevant
 *     events (Lead, Purchase). quote_delivered is an internal
 *     funnel-tracking event with no ad-platform optimization value.
 *   • Wiring CAPI properly is ~half a day of work; the Day-8 launch
 *     can ship without it. #127 tracks the follow-up.
 */
export async function sendMetaServerEvent(_args: {
  name: AnalyticsEventName;
  clientId: string;
  params?: AnalyticsEventParams;
}): Promise<{ ok: boolean; reason?: string }> {
  const token = process.env.META_CONVERSIONS_API_TOKEN;
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!token || !pixelId) {
    return { ok: false, reason: 'capi-not-configured' };
  }
  // #127 — implement Conversions API wire-up. Until then, this is a
  // no-op even when configured (loud-OK rather than loud-failure).
  return { ok: false, reason: 'capi-not-wired' };
}

// Exported for tests so the mapping can be inspected without
// re-deriving from call sites.
export const __META_EVENT_MAP_INTERNAL = META_EVENT_MAP;
