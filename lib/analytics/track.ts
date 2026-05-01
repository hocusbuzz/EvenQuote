// Provider-agnostic track() — fans out a single semantic event to
// every enabled analytics provider.
//
// Today: GA4 only.
// Soon: Meta Pixel + Reddit Pixel will plug in alongside (when their
// IDs land — handoff §3 P0c). Each provider gets its own module
// (lib/analytics/ga4.ts now, lib/analytics/meta.ts + reddit.ts later)
// and this file glues them together.
//
// Why a fan-out wrapper instead of calling gaClientEvent directly:
//   • Every event would otherwise need three call sites (GA4 +
//     Meta + Reddit). Adding a provider would mean grepping the
//     codebase for every fire site. Fan-out at one layer is cheaper.
//   • Different providers have different "ready" states. Fan-out can
//     fire-and-forget per-provider — one provider's downtime doesn't
//     starve the others.
//   • Cross-platform CAC math depends on the same vocab being fired
//     to all platforms. Centralizing here keeps that lock-step.

import { gaClientEvent } from './ga4';
import { metaClientEvent } from './meta';
import type { AnalyticsEventName, AnalyticsEventParams } from './events';

/**
 * Fire a semantic event from the browser. Fans out to all enabled
 * client-side analytics providers. Synchronous — providers are
 * fire-and-forget at the gtag/dataLayer layer.
 *
 * Use from React event handlers (onClick, onChange, onSubmit) and
 * useEffect mounts. Don't use from `useEffect` cleanup — by then the
 * page may be navigating and gtag.js may already be torn down.
 */
export function trackClient(
  name: AnalyticsEventName,
  params: AnalyticsEventParams = {}
): void {
  // Fan-out: each provider's client helper no-ops gracefully when its
  // env-var/script isn't ready, so calling all of them unconditionally
  // is safe. Reddit slots in alongside when its Pixel ID lands.
  gaClientEvent(name, params);
  metaClientEvent(name, params);
}

// Server-side fan-out lives in `./track-server.ts` so importing this
// file from a client component doesn't drag the Measurement Protocol
// fetch helper (and its server-only env var read) into the bundle.
