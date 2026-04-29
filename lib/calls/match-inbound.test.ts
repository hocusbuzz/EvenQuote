// Tests for matchInboundToQuoteRequest — resolves an inbound callback
// (voice via Vapi inbound assistant, or SMS via Twilio) back to the
// original outbound call so the response can be stored against the
// right quote_request.
//
// Why the coverage matters:
//   • Both callers (/api/vapi/inbound-callback, /api/twilio/sms) treat a
//     null match as "store as orphan". A bug here silently drops real
//     contractor responses — customers then see "we couldn't reach
//     anyone" on a request we actually connected to. That's the single
//     worst failure mode in the whole pipeline.
//   • Lib-boundary captureException sites (businessesLookupFailed and
//     callsLookupFailed) are load-bearing for Sentry alerting. Tag
//     shapes must stay PII-free (no caller phone in tags) and include
//     a businessId when we have one to scope alerts by customer.
//
// Phone normalization is covered separately below — it's the seam every
// other path depends on, and edge cases (leading '+1', spaces, 11-digit,
// empty) are easy to break unknowingly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Mock sentry so we can assert the canonical tag shape on each capture
// site without the stub's log.error firing.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
}));

import {
  matchInboundToQuoteRequest,
  normalizeInboundPhone,
} from './match-inbound';

// ─── Shared stub factory ──────────────────────────────────────────────
//
// match-inbound hits two tables:
//   • businesses: `.select(...).limit(20)` (awaits the limit())
//   • calls:      `.select(...).in(...).not(...).gte(...).order(...).limit(5)`
//
// Both chains are mocked by returning objects whose methods chain back
// to themselves until the terminal awaitable lands.

type BusinessRow = { id: string; name: string; phone: string };
type CallJoinRow = {
  id: string;
  business_id: string;
  quote_request_id: string;
  created_at: string;
  quote_requests:
    | {
        id: string;
        category_id: string;
        service_categories:
          | {
              slug: string;
              name: string;
              extraction_schema: Record<string, unknown> | null;
            }
          | null;
      }
    | null;
};

type StubState = {
  businesses: BusinessRow[];
  businessesError: { message: string } | null;
  calls: CallJoinRow[];
  callsError: { message: string } | null;
  // Captured side-effects so tests can assert the query was shaped right.
  callsInArg?: string[];
};

function makeAdmin(initial: Partial<StubState> = {}): {
  admin: SupabaseClient;
  state: StubState;
} {
  const state: StubState = {
    businesses: [],
    businessesError: null,
    calls: [],
    callsError: null,
    ...initial,
  };

  const admin = {
    from: (table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            limit: () =>
              Promise.resolve({
                data: state.businesses,
                error: state.businessesError,
              }),
          }),
        };
      }
      if (table === 'calls') {
        // Calls chain is self-referential: .in().not().gte().order().limit()
        // All intermediate steps return the same chain object; .limit()
        // resolves the promise.
        const chain: {
          in: (...args: unknown[]) => typeof chain;
          not: (...args: unknown[]) => typeof chain;
          gte: (...args: unknown[]) => typeof chain;
          order: (...args: unknown[]) => typeof chain;
          limit: () => Promise<{ data: CallJoinRow[]; error: { message: string } | null }>;
        } = {
          in: (_col: unknown, vals: unknown) => {
            state.callsInArg = vals as string[];
            return chain;
          },
          not: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({ data: state.calls, error: state.callsError }),
        };
        return {
          select: () => chain,
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { admin, state };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function biz(id: string, phone: string, name = `Biz ${id}`): BusinessRow {
  return { id, name, phone };
}

function callRow(
  overrides: Partial<CallJoinRow> = {}
): CallJoinRow {
  return {
    id: 'call_outbound_1',
    business_id: 'biz_1',
    quote_request_id: 'qr_1',
    created_at: '2026-04-20T12:00:00Z',
    quote_requests: {
      id: 'qr_1',
      category_id: 'cat_1',
      service_categories: {
        slug: 'moving',
        name: 'Moving',
        extraction_schema: { fields: ['priceMin', 'priceMax'] },
      },
    },
    ...overrides,
  };
}

// ─── normalizeInboundPhone ────────────────────────────────────────────

describe('normalizeInboundPhone', () => {
  it('strips non-digits from formatted numbers', () => {
    expect(normalizeInboundPhone('(415) 555-1234')).toBe('4155551234');
    expect(normalizeInboundPhone('415.555.1234')).toBe('4155551234');
    expect(normalizeInboundPhone('415 555 1234')).toBe('4155551234');
  });

  it('drops a leading 1 on 11-digit US numbers', () => {
    // E.164 form + the "1-" prefixed form both collapse to 10 digits.
    expect(normalizeInboundPhone('+14155551234')).toBe('4155551234');
    expect(normalizeInboundPhone('14155551234')).toBe('4155551234');
    expect(normalizeInboundPhone('1-415-555-1234')).toBe('4155551234');
  });

  it('returns empty string for empty / null / undefined', () => {
    // Callers short-circuit on '' — this guard lives right above a
    // cross-table lookup. If it returned `null` instead, the caller's
    // `if (!normalized)` check would still work but ergonomics would
    // force every caller to handle two empty-ish values.
    expect(normalizeInboundPhone('')).toBe('');
    expect(normalizeInboundPhone(null)).toBe('');
    expect(normalizeInboundPhone(undefined)).toBe('');
  });

  it('returns the digits as-is for non-11-digit inputs', () => {
    // Short numbers (extension, partial) pass through — we don't
    // want to silently mangle them. Downstream matching will just
    // not find anything.
    expect(normalizeInboundPhone('5551234')).toBe('5551234');
    // 12 digits starting with 1 is NOT US E.164; pass through.
    expect(normalizeInboundPhone('+1415555123456')).toBe('1415555123456');
  });
});

// ─── matchInboundToQuoteRequest ──────────────────────────────────────

describe('matchInboundToQuoteRequest', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  it('returns null on empty caller phone — no DB round-trips', async () => {
    const { admin, state } = makeAdmin({
      businesses: [biz('biz_1', '+14155551234')],
    });
    const result = await matchInboundToQuoteRequest(admin, '');
    expect(result).toBeNull();
    // No businesses fetch either — we bailed before hitting the DB.
    expect(state.callsInArg).toBeUndefined();
  });

  it('returns null when no business matches the normalized phone', async () => {
    // DB has businesses but none match the caller's number. Happy null-match
    // path — callers will stash this response as an orphan.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+19995550000'), biz('biz_2', '(888) 555-0000')],
      calls: [],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result).toBeNull();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('matches on the normalized form — formatting differences do not break lookup', async () => {
    // Caller phone comes in as E.164; DB has the same number in
    // "(415) 555-1234" form. Must still match.
    const { admin, state } = makeAdmin({
      businesses: [biz('biz_1', '(415) 555-1234'), biz('biz_2', '+19995550000')],
      calls: [callRow({ business_id: 'biz_1' })],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result).not.toBeNull();
    expect(result?.businessId).toBe('biz_1');
    // Candidates were filtered client-side, then the calls lookup
    // constrained to only the matching business_ids.
    expect(state.callsInArg).toEqual(['biz_1']);
  });

  it('returns the most recent call when multiple businesses share a phone', async () => {
    // Chain dupes / seed data dupes: two business rows with the same
    // phone. We sort by call recency (the .order('created_at', desc)
    // in the calls query) and pick the top row — the stub returns
    // them in that order, so calls[0] wins.
    const { admin, state } = makeAdmin({
      businesses: [
        biz('biz_chain_a', '+14155551234', 'Chain Loc A'),
        biz('biz_chain_b', '+14155551234', 'Chain Loc B'),
      ],
      calls: [
        callRow({
          id: 'call_outbound_newest',
          business_id: 'biz_chain_b',
          quote_request_id: 'qr_newest',
          created_at: '2026-04-22T12:00:00Z',
        }),
        callRow({
          id: 'call_outbound_older',
          business_id: 'biz_chain_a',
          quote_request_id: 'qr_older',
          created_at: '2026-04-20T12:00:00Z',
        }),
      ],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result?.outboundCallId).toBe('call_outbound_newest');
    expect(result?.quoteRequestId).toBe('qr_newest');
    expect(result?.businessId).toBe('biz_chain_b');
    // Both candidate IDs passed to .in(...).
    expect(state.callsInArg).toEqual(
      expect.arrayContaining(['biz_chain_a', 'biz_chain_b'])
    );
  });

  it('returns null when candidate exists but no recent call found', async () => {
    // Phone matches but no call row came back (outside 14-day window or
    // counters_applied_at IS NULL). Callers will orphan the response.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+14155551234')],
      calls: [],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result).toBeNull();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('hydrates extraction schema from the joined service_categories', async () => {
    // The inbound callback uses this to run the same per-vertical
    // extraction as the outbound webhook. If the join projection shape
    // drifts, the callback extractor would silently fall back to a
    // generic prompt and accuracy would drop.
    const schema = { fields: ['priceMin', 'priceMax', 'availability'] };
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+14155551234')],
      calls: [
        callRow({
          quote_requests: {
            id: 'qr_1',
            category_id: 'cat_moving',
            service_categories: {
              slug: 'moving',
              name: 'Moving',
              extraction_schema: schema,
            },
          },
        }),
      ],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result?.categorySlug).toBe('moving');
    expect(result?.categoryName).toBe('Moving');
    expect(result?.extractionSchema).toEqual(schema);
  });

  it('falls back to null category fields when the join is missing', async () => {
    // Older rows / schema drift edge case. The caller still needs a
    // non-null match (so the response is recorded against the quote
    // request) — category metadata just falls back to null and the
    // caller uses the generic extraction prompt.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+14155551234')],
      calls: [callRow({ quote_requests: null })],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result).not.toBeNull();
    expect(result?.categorySlug).toBeNull();
    expect(result?.categoryName).toBeNull();
    expect(result?.extractionSchema).toBeNull();
  });

  it("returns '(unknown)' business name when the top call's business_id isn't in the candidate list", async () => {
    // Defensive: this shouldn't normally happen — the calls query is
    // constrained to candidate IDs — but the fallback keeps the
    // return type non-null-safe. Locking it prevents a crash if a
    // future refactor removes the filter.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+14155551234', 'Real Biz')],
      calls: [callRow({ business_id: 'biz_ghost' })],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result?.businessName).toBe('(unknown)');
  });

  // ── Lib-boundary capture sites ───────────────────────────────────
  //
  // Both capture sites (businessesLookupFailed and callsLookupFailed)
  // emit a canonical PII-free tag shape to Sentry. Tests lock both
  // the error surface (throw, so caller route-level captureException
  // also fires — Sentry dedupes on stack-trace fingerprint but the
  // lib tag facet is what ops alert on) AND the tag shape.

  it('captures businesses lookup failure with canonical PII-free tag shape', async () => {
    const { admin } = makeAdmin({
      businessesError: { message: 'permission denied for table businesses' },
    });
    await expect(
      matchInboundToQuoteRequest(admin, '+14155551234')
    ).rejects.toThrow(/businesses/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/permission denied/);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'match-inbound',
        reason: 'businessesLookupFailed',
      },
    });
    // Strict key-set: no caller phone, no candidate businessId yet
    // (we haven't matched anything), no quoteRequestId. If one
    // sneaks in a PII-adjacent tag, this catches it.
    const tags = (ctx as { tags: Record<string, string> }).tags;
    expect(Object.keys(tags).sort()).toEqual(['lib', 'reason']);
  });

  it('captures calls lookup failure with canonical tag shape INCLUDING businessId', async () => {
    // Once we've resolved to a candidate business, its ID is scope-safe
    // to include (opaque UUID, not PII). The caller phone still must
    // NOT land in tags — the redaction in logger.ts does not reach
    // Sentry tag output.
    const { admin } = makeAdmin({
      businesses: [
        biz('biz_real_abc123', '+14155551234'),
        biz('biz_dupe_xyz456', '+14155551234'),
      ],
      callsError: { message: 'calls: connection reset' },
    });
    await expect(
      matchInboundToQuoteRequest(admin, '+14155551234')
    ).rejects.toThrow(/calls/);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/connection reset/);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'match-inbound',
        reason: 'callsLookupFailed',
        // First candidate businessId is what we surface — stable across
        // runs because candidates preserve DB order.
        businessId: 'biz_real_abc123',
      },
    });
  });

  it('capture sites do NOT include the caller phone anywhere in the tag payload (privacy)', async () => {
    // Guards against a future refactor adding `{ callerPhone: ... }`
    // to the tag set. Logger redaction doesn't reach Sentry tags.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+14155559999')],
      callsError: { message: 'boom' },
    });
    await expect(
      matchInboundToQuoteRequest(admin, '+14155559999')
    ).rejects.toThrow();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('+14155559999');
    expect(serialized).not.toContain('4155559999');
  });

  it('happy path does NOT capture anything', async () => {
    // Belt-and-suspenders no-capture check. If a future change turns
    // the null-match path into a capture (it shouldn't — null-match
    // is expected), this test catches it.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+14155551234')],
      calls: [callRow()],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result).not.toBeNull();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('null-match path does NOT capture anything (expected orphan outcome)', async () => {
    // Null match is the documented "store as orphan" path — callers
    // handle it explicitly. This MUST NOT emit to Sentry or the
    // dashboard floods every time a random wrong-number caller dials us.
    const { admin } = makeAdmin({
      businesses: [biz('biz_1', '+19995550000')],
      calls: [],
    });
    const result = await matchInboundToQuoteRequest(admin, '+14155551234');
    expect(result).toBeNull();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
