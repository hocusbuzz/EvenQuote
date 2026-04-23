// Unit tests for the tier-fallback selector.
//
// The selector runs three queries: zip → radius → state. We stub
// `admin.from('businesses')` with a thin table-aware mock that captures
// which filter chain was used and returns a preconfigured payload.
//
// Radius tier goes through admin.rpc('businesses_within_radius', …).

import { describe, it, expect, vi } from 'vitest';
import { selectBusinessesForRequest } from './select-businesses';

type Biz = {
  id: string;
  name: string;
  phone: string;
  google_rating: number | null;
  zip_code: string;
};

// Build a minimal supabase-js-compatible admin stub. We only need the
// two calls the selector makes: businesses select (with .eq/.eq/.eq/…)
// and rpc('businesses_within_radius', …).
function buildAdminStub(opts: {
  zipRows: Biz[];
  radiusRows?: Biz[];
  stateRows?: Biz[];
  /** Optional anchor record — omit to simulate "no seed in this zip". */
  anchor?: { latitude: number; longitude: number } | null;
}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const queryLog: string[] = []; // debug hook

  return {
    rpcCalls,
    queryLog,
    from: (_table: string) => {
      let state = {
        select: '',
        filters: {} as Record<string, unknown>,
        flags: { notNullLat: false, notNullLng: false },
      };
      const api: Record<string, unknown> = {};
      api.select = (cols: string) => {
        state.select = cols;
        return api;
      };
      api.eq = (col: string, val: unknown) => {
        state.filters[col] = val;
        return api;
      };
      api.not = (col: string, op: string, val: unknown) => {
        if (col === 'latitude' && op === 'is' && val === null) state.flags.notNullLat = true;
        if (col === 'longitude' && op === 'is' && val === null) state.flags.notNullLng = true;
        return api;
      };
      api.order = () => api;
      api.limit = (_n: number) => {
        // Resolve based on which filters ran. This lets us distinguish
        // the zip-tier query from the anchor-lookup query.
        if (state.select.startsWith('latitude')) {
          // anchor lookup for radius tier
          return api; // chained .maybeSingle() returns below
        }
        // zip tier or state tier
        if ('zip_code' in state.filters) {
          return Promise.resolve({ data: opts.zipRows, error: null });
        }
        if ('state' in state.filters) {
          return Promise.resolve({ data: opts.stateRows ?? [], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      };
      api.maybeSingle = () => {
        // Only the anchor lookup calls .maybeSingle(). Return the
        // configured anchor (or null to skip radius tier).
        return Promise.resolve({ data: opts.anchor ?? null, error: null });
      };
      return api;
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: opts.radiusRows ?? [], error: null });
    },
  };
}

function fixture(id: string): Biz {
  return {
    id,
    name: `biz-${id}`,
    phone: `+1555000${id.padStart(4, '0')}`,
    google_rating: 4.5,
    zip_code: '78704',
  };
}

describe('selectBusinessesForRequest', () => {
  it('tier 1 only — zip tier fills the limit, no radius/state queries', async () => {
    const zipRows = [fixture('1'), fixture('2'), fixture('3'), fixture('4'), fixture('5')];
    const admin = buildAdminStub({ zipRows });
    const picks = await selectBusinessesForRequest(admin as never, {
      categoryId: 'cat-moving',
      zipCode: '78704',
      state: 'TX',
      limit: 5,
    });
    expect(picks).toHaveLength(5);
    expect(picks.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(admin.rpcCalls).toHaveLength(0);
  });

  it('tier 2 radius fills the gap when zip under-supplies', async () => {
    const zipRows = [fixture('1'), fixture('2')];
    const radiusRows = [fixture('3'), fixture('4'), fixture('5'), fixture('6')];
    const admin = buildAdminStub({
      zipRows,
      radiusRows,
      anchor: { latitude: 30.25, longitude: -97.75 },
    });
    const picks = await selectBusinessesForRequest(admin as never, {
      categoryId: 'cat-moving',
      zipCode: '78704',
      state: 'TX',
      limit: 5,
    });
    expect(picks).toHaveLength(5);
    expect(picks.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5']);
    // radius RPC was invoked with correct parameters
    expect(admin.rpcCalls).toHaveLength(1);
    expect(admin.rpcCalls[0].name).toBe('businesses_within_radius');
    expect((admin.rpcCalls[0].args as Record<string, unknown>).p_category_id).toBe('cat-moving');
  });

  it('tier 2 dedupes IDs already seen in tier 1', async () => {
    const zipRows = [fixture('1'), fixture('2')];
    // Radius includes '1' which should be filtered out
    const radiusRows = [fixture('1'), fixture('3'), fixture('4')];
    const admin = buildAdminStub({
      zipRows,
      radiusRows,
      anchor: { latitude: 30, longitude: -97 },
    });
    const picks = await selectBusinessesForRequest(admin as never, {
      categoryId: 'cat-moving',
      zipCode: '78704',
      state: 'TX',
      limit: 4,
    });
    expect(picks.map((p) => p.id)).toEqual(['1', '2', '3', '4']);
  });

  it('skips radius tier when no anchor in the zip', async () => {
    const zipRows: Biz[] = [];
    const stateRows = [fixture('7'), fixture('8')];
    const admin = buildAdminStub({
      zipRows,
      stateRows,
      anchor: null,
    });
    const picks = await selectBusinessesForRequest(admin as never, {
      categoryId: 'cat-moving',
      zipCode: '99999',
      state: 'TX',
      limit: 5,
    });
    // No radius RPC should have run — we went straight from zip to state.
    expect(admin.rpcCalls).toHaveLength(0);
    // Picks came from state tier.
    expect(picks.map((p) => p.id)).toEqual(['7', '8']);
  });

  it('tier 3 state backfill when zip+radius combined under-supply', async () => {
    const zipRows = [fixture('1')];
    const radiusRows = [fixture('2')];
    const stateRows = [fixture('3'), fixture('4'), fixture('5')];
    const admin = buildAdminStub({
      zipRows,
      radiusRows,
      stateRows,
      anchor: { latitude: 30, longitude: -97 },
    });
    const picks = await selectBusinessesForRequest(admin as never, {
      categoryId: 'cat-moving',
      zipCode: '78704',
      state: 'TX',
      limit: 5,
    });
    expect(picks.map((p) => p.id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('returns only what exists when total pool is smaller than limit', async () => {
    const zipRows = [fixture('1')];
    const admin = buildAdminStub({
      zipRows,
      radiusRows: [],
      stateRows: [],
      anchor: null,
    });
    const picks = await selectBusinessesForRequest(admin as never, {
      categoryId: 'cat-moving',
      zipCode: '78704',
      state: 'TX',
      limit: 10,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0].id).toBe('1');
  });
});
