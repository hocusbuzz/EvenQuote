'use client';

// Fires the `quote_request_paid` analytics event exactly once per
// request id, on first mount of the post-payment confirmation page.
//
// Why client-side and not server-side from the Stripe webhook:
//   • The user has GA4's _ga client_id cookie set in their browser
//     (it was set on first visit by gtag.js). Firing here threads
//     the conversion into the SAME GA4 user_journey as the upstream
//     `quote_request_started` event, so funnel reports stitch
//     correctly. Server-side Measurement Protocol would have to
//     synthesize a different client_id, fragmenting the journey.
//   • The Stripe webhook fires before the user even lands on this
//     page; a server-side fire wouldn't help if the customer closes
//     the tab before the redirect (no journey to attribute to).
//   • #126 follow-up: backstop with a server-side fire from the
//     webhook for the close-the-tab case. Until then, accept the
//     ~95% capture rate of client-side conversion.
//
// Idempotency: success page sometimes re-renders (meta-refresh while
// the webhook lands, polling for status). We guard with sessionStorage
// keyed on the request id so a refresh / re-render doesn't double-fire
// the conversion (which would inflate paid-traffic ROAS reports and
// burn ad-budget on a phantom signal).
//
// Renders nothing.

import { useEffect } from 'react';
import { trackClient } from '@/lib/analytics/track';
import type { AnalyticsEventParams } from '@/lib/analytics/events';

const STORAGE_PREFIX = 'evenquote:tracked-paid:';

export function TrackPaidOnMount({
  requestId,
  vertical,
  value = 9.99,
}: {
  requestId: string;
  vertical?: AnalyticsEventParams['vertical'];
  value?: number;
}) {
  useEffect(() => {
    // Guard against double-fire on re-render / refresh / polling tick.
    // sessionStorage is per-tab and clears on tab close — exactly the
    // window where double-counting matters. localStorage would
    // permanently silence the event for a returning user, which would
    // skew the cross-session conversion rate downward.
    const key = `${STORAGE_PREFIX}${requestId}`;
    try {
      if (sessionStorage.getItem(key) === '1') return;
      sessionStorage.setItem(key, '1');
    } catch {
      // sessionStorage can throw in some private-mode browsers. Worst
      // case: a refreshing user double-fires. Don't break the page.
    }

    trackClient('quote_request_paid', {
      request_id: requestId,
      vertical,
      value,
      currency: 'USD',
    });
  }, [requestId, vertical, value]);

  return null;
}
