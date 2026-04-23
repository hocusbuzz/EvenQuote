// Tests for upsertBusinesses — the ingest batcher that turns
// PlaceResult[] into inserts/updates on the businesses table.
//
// We pass in a hand-rolled admin-client stub (matching the SupabaseClient
// surface the function actually touches) so we can assert inserts,
// updates, and skip reasons independently.

import { describe, it, expect, vi } from 'vitest';
import { upsertBusinesses } from './upsert-businesses';
import type { PlaceResult } from './google-places';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

function makeAdmin(opts: {
  existingByPlaceId?: Record<string, { id: string }>;
  lookupErrorFor?: Set<string>;
  updateErrorFor?: Set<string>;
  insertErrorFor?: Set<string>;
} = {}) {
  const inserts: Row[] = [];
  const updates: { id: string; row: Row }[] = [];
  const lookups: string[] = [];

  const client = {
    from: (table: string) => {
      if (table !== 'businesses') throw new Error(`unexpected ${table}`);
      return {
        select: (_cols: string) => ({
          eq: (_col: string, placeId: string) => ({
            maybeSingle: () => {
              lookups.push(placeId);
              if (opts.lookupErrorFor?.has(placeId)) {
                return Promise.resolve({
                  data: null,
                  error: { message: 'lookup broke' },
                });
              }
              const existing = opts.existingByPlaceId?.[placeId];
              return Promise.resolve({ data: existing ?? null, error: null });
            },
          }),
        }),
        insert: (row: Row) => {
          const placeId = row.google_place_id as string;
          if (opts.insertErrorFor?.has(placeId)) {
            return Promise.resolve({ error: { message: 'dup key' } });
          }
          inserts.push(row);
          return Promise.resolve({ error: null });
        },
        update: (row: Row) => ({
          eq: (_col: string, id: string) => {
            if (opts.updateErrorFor?.has(id)) {
              return Promise.resolve({ error: { message: 'update fail' } });
            }
            updates.push({ id, row });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };

  return { client: client as unknown as SupabaseClient, inserts, updates, lookups };
}

function mkPlace(partial: Partial<PlaceResult>): PlaceResult {
  return {
    placeId: 'P1',
    name: 'Example Co',
    phoneInternational: '+14155550100',
    phoneNational: '(415) 555-0100',
    website: 'https://example.com',
    city: 'San Francisco',
    state: 'CA',
    zipCode: '94102',
    latitude: 37.77,
    longitude: -122.42,
    rating: 4.5,
    userRatingCount: 100,
    ...partial,
  } as PlaceResult;
}

describe('upsertBusinesses', () => {
  it('inserts a new row when the place has not been seen', async () => {
    const { client, inserts, updates, lookups } = makeAdmin();
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-NEW', name: 'New Co' })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(lookups).toEqual(['P-NEW']);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    expect(row.google_place_id).toBe('P-NEW');
    expect(row.category_id).toBe('cat-1');
    expect(row.source).toBe('google_places');
    expect(row.is_active).toBe(true);
    expect(row.phone).toBe('+14155550100');
  });

  it('updates when the place already exists (same google_place_id)', async () => {
    const { client, inserts, updates } = makeAdmin({
      existingByPlaceId: { 'P-EXIST': { id: 'biz-999' } },
    });
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-EXIST', rating: 4.9, userRatingCount: 222 })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('biz-999');
    expect(updates[0].row.google_rating).toBe(4.9);
    expect(updates[0].row.google_review_count).toBe(222);
  });

  it('skips a place with an un-normalizable phone', async () => {
    const { client, inserts } = makeAdmin();
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-BADPHONE', phoneInternational: '555', phoneNational: null })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(result.notes[0]).toMatch(/no valid phone/);
  });

  it('falls back to phoneNational when phoneInternational is missing', async () => {
    const { client, inserts } = makeAdmin();
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-NATONLY', phoneInternational: null, phoneNational: '4155550100' })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.inserted).toBe(1);
    expect(inserts[0].phone).toBe('+14155550100');
  });

  it('skips when city/state/zip are missing', async () => {
    const { client, inserts } = makeAdmin();
    const result = await upsertBusinesses(client, {
      places: [
        mkPlace({ placeId: 'P-NOCITY', city: null }),
        mkPlace({ placeId: 'P-NOSTATE', state: null }),
        mkPlace({ placeId: 'P-NOZIP', zipCode: null }),
      ],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.skipped).toBe(3);
    expect(result.inserted).toBe(0);
    expect(inserts).toHaveLength(0);
    result.notes.forEach((n) => expect(n).toMatch(/missing city\/state\/zip/));
  });

  it('handles lookup errors by skipping, not crashing', async () => {
    const { client, inserts, updates } = makeAdmin({
      lookupErrorFor: new Set(['P-BROKE']),
    });
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-BROKE' }), mkPlace({ placeId: 'P-OK' })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.notes[0]).toMatch(/lookup error/);
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('handles insert errors by skipping without increments', async () => {
    const { client, inserts } = makeAdmin({
      insertErrorFor: new Set(['P-DUP']),
    });
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-DUP' })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
    expect(result.notes[0]).toMatch(/insert error/);
  });

  it('handles update errors by skipping without increments', async () => {
    const { client } = makeAdmin({
      existingByPlaceId: { 'P-UE': { id: 'biz-ue' } },
      updateErrorFor: new Set(['biz-ue']),
    });
    const result = await upsertBusinesses(client, {
      places: [mkPlace({ placeId: 'P-UE' })],
      categoryId: 'cat-1',
      source: 'google_places',
    });
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.notes[0]).toMatch(/update error/);
  });

  it('processes a mixed batch and returns accurate tallies', async () => {
    const { client, inserts, updates } = makeAdmin({
      existingByPlaceId: { 'P-EXISTING': { id: 'biz-e' } },
    });
    const result = await upsertBusinesses(client, {
      places: [
        mkPlace({ placeId: 'P-NEW1' }),
        mkPlace({ placeId: 'P-NEW2' }),
        mkPlace({ placeId: 'P-EXISTING' }),
        mkPlace({ placeId: 'P-BAD', phoneInternational: null, phoneNational: null }),
      ],
      categoryId: 'cat-mixed',
      source: 'google_places',
    });
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(2);
    expect(updates).toHaveLength(1);
  });
});
