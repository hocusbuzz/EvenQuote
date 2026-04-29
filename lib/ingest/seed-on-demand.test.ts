// Unit tests for seedBusinessesForRequest.
//
// We stub the Supabase admin client + mock the textSearch + upsert
// modules so each test is hermetic. The seeder's responsibilities:
//   1. Bail when the request doesn't exist.
//   2. Bail (alreadySeeded=true) when businesses_seeded_at is set.
//   3. Bail (ok=false) when the category lacks a places_query_template.
//   4. Substitute {zip}/{city}/{state} into the template.
//   5. Bias the search by origin coords when present, omit bias when null.
//   6. Stamp businesses_seeded_at on success.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted module-level mocks — vi.mock factories can't reference
// outer-scope variables (they run before module init), so we expose
// a controllable shape on a hoisted ref.
const mocks = vi.hoisted(() => ({
  textSearch: vi.fn(),
  upsertBusinesses: vi.fn(),
}));

vi.mock('./google-places', () => ({
  textSearch: mocks.textSearch,
}));

vi.mock('./upsert-businesses', () => ({
  upsertBusinesses: mocks.upsertBusinesses,
}));

vi.mock('@/lib/observability/sentry', () => ({
  captureException: vi.fn(),
}));

// Build a tiny admin stub that records updates + returns canned data
// from .maybeSingle() based on which table is being queried.
function buildAdminStub(opts: {
  request: Record<string, unknown> | null;
  category: { places_query_template: string | null; slug: string } | null;
  requestErr?: { message: string };
  categoryErr?: { message: string };
}) {
  const updates: Array<{ table: string; values: Record<string, unknown>; eq: [string, unknown] }> = [];

  return {
    updates,
    from: (table: string) => {
      const state = {
        eq: [] as Array<[string, unknown]>,
        update: null as Record<string, unknown> | null,
      };
      const api: Record<string, unknown> = {};
      api.select = () => api;
      api.eq = (col: string, val: unknown) => {
        state.eq.push([col, val]);
        return api;
      };
      api.update = (values: Record<string, unknown>) => {
        state.update = values;
        return api;
      };
      api.maybeSingle = () => {
        if (table === 'quote_requests') {
          return Promise.resolve({
            data: opts.request,
            error: opts.requestErr ?? null,
          });
        }
        if (table === 'service_categories') {
          return Promise.resolve({
            data: opts.category,
            error: opts.categoryErr ?? null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      };
      // Update path: .from('quote_requests').update({...}).eq('id', x)
      // resolves directly. We attach .then so awaiting the chain works
      // without .maybeSingle().
      api.then = (resolve: (v: { error: null }) => unknown) => {
        if (state.update) {
          updates.push({
            table,
            values: state.update,
            eq: state.eq[0] ?? ['', null],
          });
        }
        return Promise.resolve({ error: null }).then(resolve);
      };
      return api;
    },
  };
}

beforeEach(() => {
  mocks.textSearch.mockReset();
  mocks.upsertBusinesses.mockReset();
});

describe('seedBusinessesForRequest', () => {
  it('returns ok=false when the request is missing', async () => {
    const admin = buildAdminStub({ request: null, category: null });
    const { seedBusinessesForRequestWith } = await import('./seed-on-demand');
    const res = await seedBusinessesForRequestWith(admin as any, {
      quoteRequestId: 'qr-missing',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('not found');
    expect(mocks.textSearch).not.toHaveBeenCalled();
  });

  it('short-circuits when businesses_seeded_at is already set', async () => {
    const admin = buildAdminStub({
      request: {
        id: 'qr-1',
        category_id: 'cat-1',
        city: 'Carlsbad',
        state: 'CA',
        zip_code: '92008',
        origin_lat: 33.16,
        origin_lng: -117.35,
        businesses_seeded_at: '2026-04-26T00:00:00Z',
      },
      category: null,
    });
    const { seedBusinessesForRequestWith } = await import('./seed-on-demand');
    const res = await seedBusinessesForRequestWith(admin as any, {
      quoteRequestId: 'qr-1',
    });
    expect(res.ok).toBe(true);
    if (res.ok && 'alreadySeeded' in res) {
      expect(res.alreadySeeded).toBe(true);
    }
    expect(mocks.textSearch).not.toHaveBeenCalled();
  });

  it('bails when category has no places_query_template', async () => {
    const admin = buildAdminStub({
      request: {
        id: 'qr-2',
        category_id: 'cat-2',
        city: 'Carlsbad',
        state: 'CA',
        zip_code: '92008',
        origin_lat: 33.16,
        origin_lng: -117.35,
        businesses_seeded_at: null,
      },
      category: { places_query_template: null, slug: 'handyman' },
    });
    const { seedBusinessesForRequestWith } = await import('./seed-on-demand');
    const res = await seedBusinessesForRequestWith(admin as any, {
      quoteRequestId: 'qr-2',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/places_query_template/);
    expect(mocks.textSearch).not.toHaveBeenCalled();
  });

  it('substitutes {zip}/{city}/{state} and biases by origin coords', async () => {
    const admin = buildAdminStub({
      request: {
        id: 'qr-3',
        category_id: 'cat-3',
        city: 'Carlsbad',
        state: 'CA',
        zip_code: '92008',
        origin_lat: 33.16,
        origin_lng: -117.35,
        businesses_seeded_at: null,
      },
      category: {
        places_query_template: 'movers near {zip} in {city}, {state}',
        slug: 'moving',
      },
    });
    mocks.textSearch.mockResolvedValueOnce([
      { placeId: 'p1', name: 'Acme Movers' },
    ]);
    mocks.upsertBusinesses.mockResolvedValueOnce({
      inserted: 1,
      updated: 0,
      skipped: 0,
      notes: [],
    });
    const { seedBusinessesForRequestWith } = await import('./seed-on-demand');
    const res = await seedBusinessesForRequestWith(admin as any, {
      quoteRequestId: 'qr-3',
    });
    expect(res.ok).toBe(true);
    expect(mocks.textSearch).toHaveBeenCalledTimes(1);
    const arg = mocks.textSearch.mock.calls[0][0];
    expect(arg.query).toBe('movers near 92008 in Carlsbad, CA');
    expect(arg.locationBias).toMatchObject({
      latitude: 33.16,
      longitude: -117.35,
    });
    expect(arg.locationBias.radiusMeters).toBeGreaterThan(0);

    // Sentinel was stamped.
    const stamp = admin.updates.find(
      (u) => u.table === 'quote_requests' && 'businesses_seeded_at' in u.values
    );
    expect(stamp).toBeDefined();
    expect(stamp?.eq).toEqual(['id', 'qr-3']);
  });

  it('omits locationBias when origin coords are missing', async () => {
    const admin = buildAdminStub({
      request: {
        id: 'qr-4',
        category_id: 'cat-3',
        city: 'Carlsbad',
        state: 'CA',
        zip_code: '92008',
        origin_lat: null,
        origin_lng: null,
        businesses_seeded_at: null,
      },
      category: {
        places_query_template: 'movers near {zip}',
        slug: 'moving',
      },
    });
    mocks.textSearch.mockResolvedValueOnce([]);
    mocks.upsertBusinesses.mockResolvedValueOnce({
      inserted: 0,
      updated: 0,
      skipped: 0,
      notes: [],
    });
    const { seedBusinessesForRequestWith } = await import('./seed-on-demand');
    const res = await seedBusinessesForRequestWith(admin as any, {
      quoteRequestId: 'qr-4',
    });
    expect(res.ok).toBe(true);
    const arg = mocks.textSearch.mock.calls[0][0];
    expect(arg.locationBias).toBeUndefined();
  });
});
