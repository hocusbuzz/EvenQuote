// Metadata lockdown for the /admin surface.
//
// Every page under /admin is operator-only, requires the
// profiles.role='admin' gate (requireAdmin), and exposes internal
// operational data: businesses, failed calls, raw call records, and
// per-request detail views keyed by quote_request_id.
//
// None of this should ever end up in a public search index — not by
// accident, not by a silent middleware change, not by a future
// refactor dropping the `robots` field from the Metadata export.
//
// Surfaces locked here:
//
//   /admin                   → NOINDEX (operator overview dashboard)
//   /admin/businesses        → NOINDEX (full ingested business list)
//   /admin/calls             → NOINDEX (raw call records, includes phone)
//   /admin/failed-calls      → NOINDEX (DLQ; actionable ops surface)
//   /admin/requests          → NOINDEX (quote_request list)
//   /admin/requests/[id]     → NOINDEX (per-request detail, uuid-in-URL)
//
// Complements:
//   - app/layout.metadata.test.ts     (root-level OG + formatDetection)
//   - app/dashboard/metadata.test.ts  (signed-in user surfaces)
//   - app/legal/metadata.test.ts      (noindex guard for draft legal)
//   - app/get-quotes/metadata.test.ts (public intake flow)
//
// Admin pages are also middleware-guarded to `requireAdmin`, but the
// `robots` meta tag is belt-and-suspenders: middleware can change,
// ordering can shift, but the HTML meta tag is served first. It is
// what matters if a future change ever opens an /admin route to
// anonymous/public access by mistake.

import { describe, expect, it } from 'vitest';

import { metadata as adminOverview } from './page';
import { metadata as adminBusinesses } from './businesses/page';
import { metadata as adminCalls } from './calls/page';
import { metadata as adminFailedCalls } from './failed-calls/page';
import { metadata as adminRequests } from './requests/page';
import { metadata as adminRequestDetail } from './requests/[id]/page';

const SURFACES: ReadonlyArray<readonly [string, { robots?: unknown; title?: unknown }]> = [
  ['/admin', adminOverview],
  ['/admin/businesses', adminBusinesses],
  ['/admin/calls', adminCalls],
  ['/admin/failed-calls', adminFailedCalls],
  ['/admin/requests', adminRequests],
  ['/admin/requests/[id]', adminRequestDetail],
];

describe('/admin surface metadata lockdown', () => {
  it.each(SURFACES)('%s explicitly sets robots.index=false and follow=false', (_name, meta) => {
    // Every admin surface must emit the noindex/nofollow pair. A
    // missing `robots` field (or one set to only `index: false`)
    // would let a crawler follow an out-link and build a graph of
    // the admin surface even if individual pages stay out of the
    // index itself.
    expect(meta.robots).toEqual({
      index: false,
      follow: false,
    });
  });

  it.each(SURFACES)('%s still has a non-empty title (tab disambiguation)', (_name, meta) => {
    // Noindex doesn't mean untitled. Operators routinely have
    // multiple /admin tabs open at once; a dropped title makes the
    // tab unreadable. Guards against a refactor that strips the
    // title and leaves the robots block intact.
    expect(meta.title).toBeTruthy();
  });
});
