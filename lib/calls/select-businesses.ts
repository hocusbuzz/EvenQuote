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

  if (inZip.length >= limit) return inZip;

  const seen = new Set(inZip.map((b) => b.id));
  const need = limit - inZip.length;

  // Tier 2: radius search around the zip's centroid. Derive the centroid
  // from the lat/lng of a business we already know is in that zip — any
  // business is fine because zip codes are small enough that the bias
  // from picking one point is well within the 25-mile default.
  const radius = await fetchRadius(admin, {
    categoryId,
    zipCode,
    radiusMiles,
    // Overfetch so dedupe against tier 1 still leaves us with enough.
    limit: (need + seen.size) * 2,
  });
  const radiusPicks = radius.filter((b) => !seen.has(b.id)).slice(0, need);
  radiusPicks.forEach((b) => seen.add(b.id));

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
  const statePicks = inState.filter((b) => !seen.has(b.id)).slice(0, need2);

  return [...inZip, ...radiusPicks, ...statePicks];
}

// ─── helpers ────────────────────────────────────────────────────────

async function fetchRadius(
  admin: SupabaseClient,
  opts: {
    categoryId: string;
    zipCode: string;
    radiusMiles: number;
    limit: number;
  }
): Promise<SelectedBusiness[]> {
  // Pick any one business in the target zip and use its coords as the
  // search center. If the zip has no seeded businesses at all we can't
  // compute a centroid, so radius-tier just returns empty and we fall
  // through to state backfill.
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
    log.warn('radius anchor lookup failed', { err: anchorErr.message });
    return [];
  }
  if (!anchor) return [];

  const { data, error } = await admin.rpc('businesses_within_radius', {
    p_category_id: opts.categoryId,
    p_lat: anchor.latitude,
    p_lng: anchor.longitude,
    p_radius_miles: opts.radiusMiles,
    p_limit: opts.limit,
  });

  if (error) {
    log.warn('radius rpc failed', { err: error.message });
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
