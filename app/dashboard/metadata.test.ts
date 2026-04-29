// Metadata lockdown for the /dashboard surface.
//
// Every page under /dashboard is signed-in, per-user, and contains
// either a quote_request_id (per-request detail) or a payment history
// keyed to user_id. None of this should end up in a public search
// index — not by accident, not by a silent middleware change, not by
// a future refactor dropping the `robots` field from the Metadata
// export.
//
// Surfaces locked here:
//
//   /dashboard                   → NOINDEX (list of user's requests)
//   /dashboard/billing           → NOINDEX (payment history)
//   /dashboard/requests/[id]     → NOINDEX (per-request detail, leaks
//                                   uuid-in-url if crawled)
//
// Complements:
//   - app/layout.metadata.test.ts   (root-level OG + formatDetection)
//   - app/get-quotes/metadata.test.ts (public intake flow — indexable
//                                       landing, noindex checkout + success)
//   - app/legal/metadata.test.ts    (noindex guard for draft legal pages)
//
// The dashboard + request-detail pages are middleware-guarded to
// `requireUser`, but a crawler that happens to hit a leaked URL is
// served the signed-in redirect chain — the `robots` meta tag is the
// belt-and-suspenders guard. It is also what matters if a future
// change opens a dashboard route to anonymous/public access.

import { describe, expect, it } from 'vitest';

import { metadata as dashboardMetadata } from './page';
import { metadata as billingMetadata } from './billing/page';
import { metadata as requestDetailMetadata } from './requests/[id]/page';

describe('/dashboard (signed-in request list)', () => {
  it('explicitly sets robots.index=false and robots.follow=false', () => {
    // The list view is per-user, surfaced behind requireUser, and
    // does not belong in Google's index. The `robots` lock is the
    // hard stop — middleware can change, but the HTML meta tag is
    // always served first.
    expect(dashboardMetadata.robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it('still has a non-empty title (tab bar for signed-in users)', () => {
    // Noindex doesn't mean untitled — the user still needs to spot
    // this tab among many. A dropped title makes the tab unreadable.
    expect(dashboardMetadata.title).toBeTruthy();
  });
});

describe('/dashboard/billing (payment history)', () => {
  it('explicitly sets robots.index=false and robots.follow=false', () => {
    // Payment history is the most sensitive surface in the app after
    // the per-request detail page. Locking noindex here stops a
    // misconfigured middleware or a rogue proxy from leaking receipt
    // contents into a search result.
    expect(billingMetadata.robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it('still has a non-empty title', () => {
    expect(billingMetadata.title).toBeTruthy();
  });
});

describe('/dashboard/requests/[id] (per-request detail)', () => {
  it('explicitly sets robots.index=false and robots.follow=false', () => {
    // The URL embeds a quote_request_id (uuid). If this ever ends up
    // in a search index, even with RLS enforcing ownership, the id
    // leaks into external search caches and the 404/redirect page
    // becomes attackable noise. Noindex is mandatory.
    expect(requestDetailMetadata.robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it('still has a non-empty title', () => {
    // Tab bar needs to distinguish multiple open detail views.
    expect(requestDetailMetadata.title).toBeTruthy();
  });
});
