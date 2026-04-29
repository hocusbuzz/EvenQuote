// Pick K businesses to call for a given quote_request.
//
// Fallback cascade (Phase 7):
//   1. Exact zip match.
//   2. Radius search — 25 miles around the zip's centroid, derived from
//      lat/lng of any business already in that zip. This covers cases
//      like "customer in a rural zip with only 1-2 movers but the next
//      zip over has plenty".
//   3. State-level backfill — last resort when radius has nothing or
//      the zip has no seeded businesses at all.
//
// Inside every tier, ranking blends:
//   • call_success_rate (recently-updated rolling score; high = good)
//   • google_rating (static; ties break on this)
//   • last_called_at (older = higher — spreads load across the pool)
//
// Active only. Must have a phone.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';

const log = createLogger('selectBusinesses');

export type SelectedBusiness = {
  id: string;
  name: string;
  phone: string;
  google_rating: number | null;
  zip_code: string;
};

export type SelectInput = {
  categoryId: string;
  zipCode: string;
  state: string;
  limit: number;
  /** Default 25 miles; override for dense metros or rural fallbacks. */
  radiusMiles?: number;
  /**
   * Optional request origin coordinates. When present, the radius tier
   * anchors on these instead of the "pick any business in the same zip"
   * centroid trick — more accurate, and works for cold-start zips where
   * no businesses have been seeded yet. NULL on legacy / manual-entry
   * rows; selector falls back to the in-zip anchor in that case.
   */
  originLat?: number | null;
  originLng?: number | null;
};

const DEFAULT_RADIUS_MILES = 25;

export async function selectBusinessesForRequest(
  admin: SupabaseClient,
  input: SelectInput
): Promise<SelectedBusiness[]> {
  const { categoryId, zipCode, state, limit } = input;
  const radiusMiles = input.radiusMiles ?? DEFAULT_RADIUS_MILES;

  // Tier 1: exact zip. Ordering blends success rate (Phase 7) then
  // rating then freshness. nullsFirst=false on call_success_rate pushes
  // unproven businesses below proven ones, but they still surface via
  // the google_rating + last_called_at tiebreakers.
  const { data: zipData, error: zipErr } = await admin
    .from('businesses')
    .select('id, name, phone, google_rating, zip_code')
    .eq('category_id', categoryId)
    .eq('is_active', true)
    .eq('zip_code', zipCode)
    .order('call_success_rate', { ascending: false, nullsFirst: false })
    .order('google_rating', { ascending: false, nullsFirst: false })
    .order('last_called_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (zipErr) throw new Error(`selectBusinesses zip: ${zipErr.message}`);
  const inZip = (zipData ?? []) as SelectedBusiness[];

  if (inZip.length >= limit) return dedupeByPhone(inZip);

  // Tracks IDs AND normalized phone numbers we've already committed to
  // dialing in this batch. Without the phone dedup, two seeded rows for
  // the same chain (different franchises, multiple listings of the same
  // pro, re-ingested duplicates) could both be dialed — burning a
  // second call for zero new information. Phone dedup is our safety
  // net on top of the DB-level ID dedup.
  const seen = new Set(inZip.map((b) => b.id));
  const seenPhones = new Set(inZip.map((b) => normalizePhone(b.phone)));
  const need = limit - inZip.length;

  // Tier 2: radius search.
  //
  // Anchor preference:
  //   1. The request's origin coords (captured from the Place Details
  //      pick when the form was submitted). Most accurate, and works
  //      for brand-new zips that have zero businesses yet — which is
  //      the common case post-R47 when on-demand seeding is the
  //      primary intake path.
  //   2. Fallback: the lat/lng of any business already in that zip.
  //      Zip codes are small enough that picking one is well within
  //      the 25-mile default's noise floor.
  //   3. Final fallback (no origin coords AND no in-zip business):
  //      tier 2 returns empty and the cascade drops to state backfill.
  const radius = await fetchRadius(admin, {
    categoryId,
    zipCode,
    radiusMiles,
    originLat: input.originLat ?? null,
    originLng: input.originLng ?? null,
    // Overfetch so dedupe against tier 1 still leaves us with enough.
    limit: (need + seen.size) * 2,
  });
  const radiusPicks = radius
    .filter((b) => {
      if (seen.has(b.id)) return false;
      const np = normalizePhone(b.phone);
      if (seenPhones.has(np)) return false;
      return true;
    })
    .slice(0, need);
  radiusPicks.forEach((b) => {
    seen.add(b.id);
    seenPhones.add(normalizePhone(b.phone));
  });

  if (inZip.length + radiusPicks.length >= limit) {
    return [...inZip, ...radiusPicks];
  }

  // Tier 3: state backfill. Same ordering as tier 1.
  const need2 = limit - inZip.length - radiusPicks.length;
  const { data: stateData, error: stateErr } = await admin
    .from('businesses')
    .select('id, name, phone, google_rating, zip_code')
    .eq('category_id', categoryId)
    .eq('is_active', true)
    .eq('state', state)
    .order('call_success_rate', { ascending: false, nullsFirst: false })
    .order('google_rating', { ascending: false, nullsFirst: false })
    .order('last_called_at', { ascending: true, nullsFirst: true })
    .limit((need2 + seen.size) * 2);
  if (stateErr) throw new Error(`selectBusinesses state: ${stateErr.message}`);
  const inState = (stateData ?? []) as SelectedBusiness[];
  const statePicks = inState
    .filter((b) => {
      if (seen.has(b.id)) return false;
      const np = normalizePhone(b.phone);
      if (seenPhones.has(np)) return false;
      return true;
    })
    .slice(0, need2);

  return [...inZip, ...radiusPicks, ...statePicks];
}

/**
 * Normalize a phone number for duplicate detection. Strips every
 * non-digit character and drops a leading US country code, so
 * "+1 (760) 555-0123", "1-760-555-0123" and "7605550123" all collapse
 * to the same key. Returns an empty string for missing input — which
 * is treated as its own bucket so empty-phone rows (shouldn't happen
 * post-ingest validation, but defensive) aren't deduped against each
 * other in a lossy way.
 */
function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * Dedup an already-selected list by phone. Used for the tier-1-only
 * early-return path, where tier 1 can itself contain dupes if the
 * upstream businesses table has them for the same zip.
 */
function dedupeByPhone(rows: SelectedBusiness[]): SelectedBusiness[] {
  const seen = new Set<string>();
  const out: SelectedBusiness[] = [];
  for (const b of rows) {
    const np = normalizePhone(b.phone);
    if (np && seen.has(np)) continue;
    if (np) seen.add(np);
    out.push(b);
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────

async function fetchRadius(
  admin: SupabaseClient,
  opts: {
    categoryId: string;
    zipCode: string;
    radiusMiles: number;
    limit: number;
    originLat: number | null;
    originLng: number | null;
  }
): Promise<SelectedBusiness[]> {
  // Resolve the radius anchor.
  //   1. Prefer the request's origin coords — captured from Google
  //      Place Details when the user picked a prediction. Works even
  //      when the zip has zero seeded businesses (cold-start case).
  //   2. Fall back to "pick any business in this zip and use its
  //      coords" — covers legacy/manual address entries with no coords
  //      AND zips that already have at least one business.
  //   3. If neither anchor is available, give up on the radius tier;
  //      the cascade drops to state backfill.
  let anchorLat: number | null = opts.originLat;
  let anchorLng: number | null = opts.originLng;

  if (anchorLat == null || anchorLng == null) {
    const { data: anchor, error: anchorErr } = await admin
      .from('businesses')
      .select('latitude, longitude')
      .eq('category_id', opts.categoryId)
      .eq('zip_code', opts.zipCode)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .limit(1)
      .maybeSingle();

    if (anchorErr) {
      // Soft-fail the radius tier — don't take down the whole selector
      // over a radius lookup issue.
      log.warn('radius anchor lookup failed', { err: anchorErr });
      return [];
    }
    if (!anchor) return [];
    anchorLat = anchor.latitude;
    anchorLng = anchor.longitude;
  }

  const { data, error } = await admin.rpc('businesses_within_radius', {
    p_category_id: opts.categoryId,
    p_lat: anchorLat,
    p_lng: anchorLng,
    p_radius_miles: opts.radiusMiles,
    p_limit: opts.limit,
  });

  if (error) {
    log.warn('radius rpc failed', { err: error });
    return [];
  }

  return (data ?? []).map((r: {
    id: string;
    name: string;
    phone: string;
    google_rating: number | null;
    zip_code: string;
  }) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    google_rating: r.google_rating,
    zip_code: r.zip_code,
  }));
}
