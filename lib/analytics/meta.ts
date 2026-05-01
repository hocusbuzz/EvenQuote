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
// Server-side (Conversions API)
// ──────────────────────────────────────────────────────────────────

const CAPI_ENDPOINT_VERSION = 'v21.0';

// SHA-256 hash for the `external_id` user-data field. CAPI requires
// every event to carry at least one user identifier; for events
// firing from a cron with no live browser session, `external_id` is
// the path of least friction — opaque to Meta, stable across
// duplicate events for the same quote_request, never personally
// identifying. We hash it (Meta hashes external_id automatically on
// their side too, but pre-hashing avoids surprising-them failures
// across versions).
async function sha256Hex(input: string): Promise<string> {
  // Web Crypto is available in Edge runtime AND Node 16+. Importing
  // node:crypto would break the edge build path.
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fire a Meta Conversions API event from a server context.
 *
 * No-op (returns `{ ok: false, reason: 'capi-not-configured' }`) when
 * either env var is missing — production must have both, but staging
 * / preview / local without Meta should still boot. Errors are
 * swallowed and logged via the return shape — analytics MUST NOT
 * throw out of a webhook or cron path.
 *
 * `clientId` becomes `external_id` on Meta's side (after SHA-256).
 * For events tied to a quote_request, pass quote_request.id — same
 * value as the GA4 client_id, so cross-platform funnel reports
 * line up.
 *
 * Event-name mapping comes from META_EVENT_MAP (same source of truth
 * as the client-side fbq call). `quote_delivered` becomes the custom
 * event 'QuoteDelivered'.
 *
 * `event_id` lets Meta dedupe a server-side fire against a sibling
 * client-side fire with the same id. We use `<eventName>:<clientId>`
 * — for events that fire from BOTH paths (none today, but the
 * follow-up backstop for quote_request_paid would), passing the same
 * clientId from both sides yields the same event_id and Meta dedupes.
 */
export async function sendMetaServerEvent(args: {
  name: AnalyticsEventName;
  clientId: string;
  params?: AnalyticsEventParams;
}): Promise<{ ok: boolean; reason?: string }> {
  const token = process.env.META_CONVERSIONS_API_TOKEN;
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!token || !pixelId) {
    return { ok: false, reason: 'capi-not-configured' };
  }

  const spec = META_EVENT_MAP[args.name];
  if (spec.kind === 'skip') {
    return { ok: false, reason: 'meta-event-not-mapped' };
  }
  // For server-side, both standard and custom events use the same
  // event_name field — Meta differentiates by whether the name
  // matches their standard list.
  const eventName = spec.name;

  const externalIdHashed = await sha256Hex(args.clientId);

  // custom_data payload — only Meta-recognized keys flow here, same
  // shape as the client-side `metaParams` builder above. Keep this
  // narrow so PII never leaks to Meta accidentally.
  const customData: Record<string, unknown> = {};
  if (args.params?.value !== undefined) customData.value = args.params.value;
  if (args.params?.currency !== undefined) customData.currency = args.params.currency;
  if (args.params?.request_id !== undefined) {
    customData.content_ids = [args.params.request_id];
    customData.content_type = 'product';
  }

  const body = JSON.stringify({
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        // `website` is correct for events that originated from a web
        // touchpoint — including server-side fires where the original
        // user action was a web click. `system_generated` exists too
        // but Meta's docs steer you to `website` for our shape.
        action_source: 'website',
        // Stable per-(event,clientId) so a future client+server
        // double-fire of the same event dedupes on Meta's side.
        event_id: `${eventName}:${args.clientId}`,
        user_data: {
          external_id: externalIdHashed,
        },
        custom_data: customData,
      },
    ],
    // Set to 'TEST12345' (or similar) when debugging via Meta's Test
    // Events tab. Off by default in prod. Pulled from env so we don't
    // ship a constant that pollutes real metrics.
    ...(process.env.META_CAPI_TEST_EVENT_CODE
      ? { test_event_code: process.env.META_CAPI_TEST_EVENT_CODE }
      : {}),
    access_token: token,
  });

  const url =
    `https://graph.facebook.com/${CAPI_ENDPOINT_VERSION}/` +
    `${encodeURIComponent(pixelId)}/events`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      // Keepalive so a serverless function shutting down right after
      // the call doesn't drop the request mid-flight.
      keepalive: true,
    });

    if (!res.ok) {
      return { ok: false, reason: `capi-${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'fetch-failed',
    };
  }
}

// Exported for tests so the mapping can be inspected without
// re-deriving from call sites.
export const __META_EVENT_MAP_INTERNAL = META_EVENT_MAP;
