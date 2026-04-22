// Turn PlaceResult[] into upserted `businesses` rows.
//
// Dedup key: google_place_id (unique in schema). Repeat ingests of the
// same place update the rating / review count / last-seen fields but
// leave the row stable. This is intentional — we want stable business
// IDs so historical calls keep pointing at the same row.
//
// Rows with a missing or un-normalizable phone are skipped. Without a
// callable number, we can't use the business, so don't pollute the
// table with noise.

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeToE164 } from './phone';
import type { PlaceResult } from './google-places';

export type UpsertResult = {
  inserted: number;
  updated: number;
  skipped: number;
  /** Human-readable reasons, for CLI output. */
  notes: string[];
};

export type UpsertInput = {
  places: PlaceResult[];
  /** service_categories.id this batch should be tagged with. */
  categoryId: string;
  /** Source tag, e.g. 'google_places'. Stored on each row. */
  source: string;
};

export async function upsertBusinesses(
  admin: SupabaseClient,
  input: UpsertInput
): Promise<UpsertResult> {
  const { places, categoryId, source } = input;
  const result: UpsertResult = { inserted: 0, updated: 0, skipped: 0, notes: [] };

  for (const p of places) {
    const phone = normalizeToE164(p.phoneInternational ?? p.phoneNational);
    if (!phone) {
      result.skipped += 1;
      result.notes.push(`skip ${p.name}: no valid phone (${p.placeId})`);
      continue;
    }

    if (!p.city || !p.state || !p.zipCode) {
      result.skipped += 1;
      result.notes.push(`skip ${p.name}: missing city/state/zip`);
      continue;
    }

    // Check if the row exists already so we can distinguish inserts
    // from updates for the CLI report. The unique index on
    // google_place_id means `upsert` works either way, but we want
    // accurate counts.
    const { data: existing, error: lookupErr } = await admin
      .from('businesses')
      .select('id')
      .eq('google_place_id', p.placeId)
      .maybeSingle();

    if (lookupErr) {
      result.skipped += 1;
      result.notes.push(`skip ${p.name}: lookup error ${lookupErr.message}`);
      continue;
    }

    const row = {
      name: p.name,
      phone,
      website: p.website,
      category_id: categoryId,
      city: p.city,
      state: p.state,
      zip_code: p.zipCode,
      latitude: p.latitude,
      longitude: p.longitude,
      google_rating: p.rating,
      google_review_count: p.userRatingCount,
      google_place_id: p.placeId,
      source,
      ingested_at: new Date().toISOString(),
      is_active: true,
    };

    if (existing) {
      const { error: updateErr } = await admin
        .from('businesses')
        .update(row)
        .eq('id', existing.id);

      if (updateErr) {
        result.skipped += 1;
        result.notes.push(`skip ${p.name}: update error ${updateErr.message}`);
      } else {
        result.updated += 1;
      }
    } else {
      const { error: insertErr } = await admin.from('businesses').insert(row);

      if (insertErr) {
        result.skipped += 1;
        result.notes.push(`skip ${p.name}: insert error ${insertErr.message}`);
      } else {
        result.inserted += 1;
      }
    }
  }

  return result;
}
