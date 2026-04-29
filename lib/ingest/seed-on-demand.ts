// On-demand business seeding (R47).
//
// Triggered the moment a Stripe webhook flips a quote_request to
// status='paid' — BEFORE the call engine selects who to dial. Hits
// Google Places v1 textSearch biased to the request's origin coords
// (~20 mi radius, US-only via the existing client), upserts the
// results into `businesses`, and stamps `businesses_seeded_at` so a
// webhook replay or a manual retry doesn't fire a second search.
//
// Why on-demand instead of a pre-ingest crawl?
//   • Coverage scales to wherever a paying customer is, with zero
//     manual zip-list maintenance.
//   • Freshness: every search re-fetches ratings + review counts +
//     phone changes for that area on the day of the call.
//   • Cost: 1 textSearch per paid request (~$0.03 with our field mask)
//     is trivial vs. the $9.99 collected.
//
// Why before the call engine, not inside it?
//   • Keeps engine.ts focused on "claim → select → dispatch". The
//     seeder is a separate, optional concern that can be skipped
//     entirely (legacy manually-ingested zips don't need it).
//   • Failure isolation: if Places is down, we still want the call
//     engine to attempt with whatever's already in the DB. The webhook
//     calls the seeder best-effort and continues regardless.
//
// Idempotency: gated on quote_requests.businesses_seeded_at. The
// underlying upsert is also idempotent on businesses.google_place_id
// — repeat calls just refresh fields. Both layers exist on purpose:
// the sentinel saves us a Places API charge on replay, and the
// place_id unique constraint is the safety net.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { textSearch } from './google-places';
import { upsertBusinesses } from './upsert-businesses';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('seedOnDemand');

// ~20 miles in meters. Mirrors the default radius the call engine's
// radius selector uses (25 mi). Slightly tighter on ingest so we
// over-collect from the immediate area before trusting fallbacks.
//
// 1 mile = 1609.34 m → 20 mi = 32,186.8 m → round to int.
const SEED_RADIUS_METERS = 32_187;

export type SeedInput = {
  quoteRequestId: string;
  /** Override the radius. Default 20mi. Tests / future tuning. */
  radiusMeters?: number;
};

export type SeedResult =
  | { ok: true; alreadySeeded: true; reason: string }
  | {
      ok: true;
      alreadySeeded: false;
      placesFetched: number;
      inserted: number;
      updated: number;
      skipped: number;
      query: string;
    }
  | { ok: false; reason: string };

/**
 * Run the on-demand seeder for a paid quote_request. Best-effort —
 * callers should not throw on failure; the call engine has its own
 * fallbacks (zip → radius → state) and works fine against an empty
 * pool, returning the right "no businesses matched" telemetry.
 */
export async function seedBusinessesForRequest(
  input: SeedInput
): Promise<SeedResult> {
  const admin = createAdminClient();
  return seedBusinessesForRequestWith(admin, input);
}

/**
 * Same as seedBusinessesForRequest but with an injectable client for
 * tests. Production callers use the no-arg overload above.
 */
export async function seedBusinessesForRequestWith(
  admin: SupabaseClient,
  input: SeedInput
): Promise<SeedResult> {
  const { quoteRequestId } = input;
  const radiusMeters = input.radiusMeters ?? SEED_RADIUS_METERS;

  if (!quoteRequestId) {
    return { ok: false, reason: 'quoteRequestId required' };
  }

  // 1. Load the request. Need category_id + zip + (optionally) coords.
  const { data: request, error: reqErr } = await admin
    .from('quote_requests')
    .select(
      'id, category_id, city, state, zip_code, origin_lat, origin_lng, businesses_seeded_at'
    )
    .eq('id', quoteRequestId)
    .maybeSingle<{
      id: string;
      category_id: string;
      city: string;
      state: string;
      zip_code: string;
      origin_lat: number | null;
      origin_lng: number | null;
      businesses_seeded_at: string | null;
    }>();

  if (reqErr) {
    log.error('request lookup failed', { err: reqErr, quoteRequestId });
    captureException(new Error(`seedOnDemand requestLookup: ${reqErr.message}`), {
      tags: {
        lib: 'seedOnDemand',
        reason: 'requestLookupFailed',
        quoteRequestId,
      },
    });
    return { ok: false, reason: `request lookup: ${reqErr.message}` };
  }
  if (!request) {
    return { ok: false, reason: 'request not found' };
  }

  // 2. Idempotency sentinel. Replay-safe: webhook retries, manual
  //    re-trigger, dev skip-payment all converge here without re-billing
  //    Google.
  if (request.businesses_seeded_at) {
    return {
      ok: true,
      alreadySeeded: true,
      reason: `already seeded at ${request.businesses_seeded_at}`,
    };
  }

  // 3. Pull the category's Places query template — different for each
  //    vertical (e.g. "movers near {zip}" vs. "cleaners near {zip}").
  //    Without one we can't run a sensible search; bail soft so the
  //    legacy ingest path remains the source of truth for that vertical.
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('places_query_template, slug')
    .eq('id', request.category_id)
    .maybeSingle<{
      places_query_template: string | null;
      slug: string;
    }>();

  if (catErr) {
    return { ok: false, reason: `category lookup: ${catErr.message}` };
  }
  if (!category?.places_query_template) {
    log.info('category has no places_query_template, skipping seed', {
      quoteRequestId,
      categoryId: request.category_id,
    });
    return {
      ok: false,
      reason: `category ${category?.slug ?? request.category_id} has no places_query_template`,
    };
  }

  const query = category.places_query_template
    .replace('{zip}', request.zip_code)
    .replace('{city}', request.city)
    .replace('{state}', request.state);

  // 4. Build the location bias. We prefer the request's actual origin
  //    coords (captured from the Place Details pick) for accuracy. If
  //    the user typed a custom address Google couldn't resolve, we fall
  //    back to no bias and rely on the textual "near {zip}" hint —
  //    less precise but still functional.
  const locationBias =
    typeof request.origin_lat === 'number' && typeof request.origin_lng === 'number'
      ? {
          latitude: request.origin_lat,
          longitude: request.origin_lng,
          radiusMeters,
        }
      : undefined;

  // 5. Hit Google Places.
  let places;
  try {
    places = await textSearch({ query, locationBias, pageSize: 20 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('textSearch failed', { err, quoteRequestId, query });
    captureException(err instanceof Error ? err : new Error(msg), {
      tags: {
        lib: 'seedOnDemand',
        reason: 'textSearchFailed',
        quoteRequestId,
      },
    });
    return { ok: false, reason: `places textSearch: ${msg}` };
  }

  // 6. Upsert into `businesses`. The upsert helper handles dedup on
  //    google_place_id, normalizes phones, and skips rows that lack a
  //    callable number — so a 0-row Places result and a 20-row result
  //    with no phones both pass through cleanly.
  const upsert = await upsertBusinesses(admin, {
    places,
    categoryId: request.category_id,
    source: 'google_places_on_demand',
  });

  // 7. Stamp the sentinel. Best-effort: a failure here is "we
  //    re-seeded, fine, the place_id unique index made it idempotent
  //    anyway" — nothing for ops to chase. Just a warn line.
  const stampedAt = new Date().toISOString();
  const { error: stampErr } = await admin
    .from('quote_requests')
    .update({ businesses_seeded_at: stampedAt })
    .eq('id', request.id);

  if (stampErr) {
    log.warn('seed succeeded but sentinel stamp failed', {
      err: stampErr,
      quoteRequestId,
    });
  }

  log.info('seeded businesses', {
    quoteRequestId,
    query,
    placesFetched: places.length,
    inserted: upsert.inserted,
    updated: upsert.updated,
    skipped: upsert.skipped,
    biased: !!locationBias,
  });

  return {
    ok: true,
    alreadySeeded: false,
    placesFetched: places.length,
    inserted: upsert.inserted,
    updated: upsert.updated,
    skipped: upsert.skipped,
    query,
  };
}
