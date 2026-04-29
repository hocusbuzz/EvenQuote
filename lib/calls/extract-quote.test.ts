// Unit tests for extractQuoteFromCall and its coercion helpers.
//
// Strategy:
//   • We don't hit Anthropic — coverage focuses on the paths that don't
//     need the network: Vapi structured-data preference, no-api-key fail,
//     empty-transcript fail, and schema coercion (number/string/array).
//   • Anthropic fetch is mocked at module boundary via vi.stubGlobal.
//   • Sentry capture is mocked at module level (same pattern as
//     engine.test.ts / apply-end-of-call.test.ts) so we can lock the
//     canonical `{ lib: 'extract-quote', reason }` tag shape at every
//     non-benign failure site.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: vi.fn(),
  init: vi.fn(),
  setUser: vi.fn(),
  isEnabled: () => false,
}));

import { extractQuoteFromCall } from './extract-quote';

describe('extractQuoteFromCall', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    captureExceptionMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('prefers Vapi structured data when present (no network call)', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const res = await extractQuoteFromCall({
      transcript: 'anything',
      summary: null,
      vapiAnalysis: {
        structuredData: {
          priceMin: 800,
          priceMax: 1200,
          priceDescription: 'flat $1000-ish',
          availability: 'next Saturday',
          includes: ['2 movers', 'truck'],
          excludes: ['stairs'],
          notes: null,
          contactName: 'Lucy',
          contactPhone: '555-111-2222',
          contactEmail: null,
          requiresOnsiteEstimate: false,
          confidenceScore: 0.88,
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe('vapi-structured');
      expect(res.quote.priceMin).toBe(800);
      expect(res.quote.priceMax).toBe(1200);
      expect(res.quote.includes).toEqual(['2 movers', 'truck']);
      expect(res.quote.confidenceScore).toBeCloseTo(0.88);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts snake_case Vapi payload (defensive coercion)', async () => {
    const res = await extractQuoteFromCall({
      transcript: 'x',
      summary: null,
      vapiAnalysis: {
        structuredData: {
          price_min: 500,
          price_max: 900,
          price_description: 'hourly',
          requires_onsite_estimate: true,
          confidence_score: 0.4,
          // intentionally missing arrays — coercion should default to []
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.quote.priceMin).toBe(500);
      expect(res.quote.requiresOnsiteEstimate).toBe(true);
      expect(res.quote.includes).toEqual([]);
      expect(res.quote.excludes).toEqual([]);
    }
  });

  it('clamps confidenceScore to 0..1', async () => {
    const resHigh = await extractQuoteFromCall({
      transcript: 'x',
      summary: null,
      vapiAnalysis: {
        structuredData: { priceMin: 100, priceMax: 200, confidenceScore: 5 },
      },
    });
    expect(resHigh.ok).toBe(true);
    if (resHigh.ok) expect(resHigh.quote.confidenceScore).toBe(1);

    const resLow = await extractQuoteFromCall({
      transcript: 'x',
      summary: null,
      vapiAnalysis: {
        structuredData: { priceMin: 100, priceMax: 200, confidenceScore: -0.3 },
      },
    });
    expect(resLow.ok).toBe(true);
    if (resLow.ok) expect(resLow.quote.confidenceScore).toBe(0);
  });

  it('returns ok:false with clear reason when ANTHROPIC_API_KEY is unset', async () => {
    const res = await extractQuoteFromCall({
      transcript: 'We quoted $500-800 for Saturday.',
      summary: 'Quote given',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/ANTHROPIC_API_KEY/);
    // Benign config state — MUST NOT capture to tracker.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('returns ok:false when transcript is empty and Vapi has no data', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    const res = await extractQuoteFromCall({
      transcript: '',
      summary: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/transcript/i);
    // Empty transcript is expected (voicemail-not-left, carrier hangup) —
    // MUST NOT capture or Sentry will flood on every such call.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('successfully extracts from Claude response with tool_use', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    const mockResponse = {
      content: [
        {
          type: 'tool_use',
          name: 'record_quote',
          input: {
            priceMin: 700,
            priceMax: 1100,
            priceDescription: '$150/hr, 3hr min',
            availability: 'Sat morning',
            includes: ['2 movers', 'truck'],
            excludes: [],
            notes: 'friendly',
            contactName: null,
            contactPhone: null,
            contactEmail: null,
            requiresOnsiteEstimate: false,
            confidenceScore: 0.8,
          },
        },
      ],
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as unknown as typeof fetch;
    const res = await extractQuoteFromCall({
      transcript: 'Agent quotes 150/hr min 3 hours.',
      summary: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe('claude');
      expect(res.quote.priceMin).toBe(700);
      expect(res.quote.priceDescription).toBe('$150/hr, 3hr min');
    }
  });

  it('reports ok:false when Anthropic returns non-ok HTTP (locks extractHttpFailed tag shape)', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal err',
    }) as unknown as typeof fetch;
    const res = await extractQuoteFromCall({
      transcript: 'Something',
      summary: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/500/);
    // Tag shape lock. Dashboards alert per-mode on `reason`; don't let
    // a future refactor drop `httpStatus` or rename `reason`.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toEqual({
      tags: {
        lib: 'extract-quote',
        reason: 'extractHttpFailed',
        httpStatus: '500',
      },
    });
  });

  it('reports ok:false when Anthropic response has no tool_use (locks extractMissingToolUse tag)', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'sorry' }] }),
    }) as unknown as typeof fetch;
    const res = await extractQuoteFromCall({
      transcript: 'a',
      summary: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/tool_use/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toEqual({
      tags: { lib: 'extract-quote', reason: 'extractMissingToolUse' },
    });
  });

  it('reports ok:false + captures when tool_use input fails schema coercion', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'record_quote',
            // non-object input — fails coerceFromClaude's first guard.
            input: 'not-an-object',
          },
        ],
      }),
    }) as unknown as typeof fetch;
    const res = await extractQuoteFromCall({
      transcript: 'a',
      summary: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/schema coercion/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toEqual({
      tags: { lib: 'extract-quote', reason: 'extractSchemaCoercionFailed' },
    });
  });

  it('handles network error as a soft failure (locks extractTransportFailed tag)', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const res = await extractQuoteFromCall({
      transcript: 'a',
      summary: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/ECONNRESET/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toEqual({
      tags: { lib: 'extract-quote', reason: 'extractTransportFailed' },
    });
  });

  it('PII guard: tags never contain transcript content, phone, or email', async () => {
    // Run every captured failure mode and assert no tag value looks
    // like PII. Cheap belt-and-suspenders: if a future refactor ever
    // plumbs `transcript` / contact fields into tags, this fails.
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    const cases: Array<() => Promise<unknown>> = [
      async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'raw body',
        }) as unknown as typeof fetch;
        return extractQuoteFromCall({
          transcript: 'contact me at lucy@example.com or 555-123-4567',
          summary: null,
        });
      },
      async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: 'x' }] }),
        }) as unknown as typeof fetch;
        return extractQuoteFromCall({
          transcript: 'transcript with phone 555-987-6543',
          summary: null,
        });
      },
      async () => {
        globalThis.fetch = vi
          .fn()
          .mockRejectedValue(new Error('boom phone 555-000-1111 email a@b.co'));
        return extractQuoteFromCall({
          transcript: 'nope@nope.com 555-555-5555',
          summary: null,
        });
      },
    ];
    for (const run of cases) {
      captureExceptionMock.mockReset();
      await run();
      for (const call of captureExceptionMock.mock.calls) {
        const tags = (call[1] as { tags?: Record<string, string> })?.tags ?? {};
        for (const v of Object.values(tags)) {
          expect(v).not.toMatch(/@/);
          // 10+ digit sequences are how phone numbers slip in.
          expect(v).not.toMatch(/\d{10,}/);
          // Raw transcript content should never reach tags either.
          expect(v).not.toMatch(/transcript|contact|nope/i);
        }
      }
    }
  });

  it('regression-guard: never emits a catch-all reason tag', async () => {
    // If someone adds a new `captureException` site in this file, they
    // must pick a discrete reason. Reject catch-alls so dashboards
    // stay parseable.
    const FORBIDDEN = new Set<string>([
      'extractFailed',
      'runExtract',
      'unknown',
      'error',
    ]);
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    // HTTP-fail path (guaranteed to capture).
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'x',
    }) as unknown as typeof fetch;
    await extractQuoteFromCall({ transcript: 'a', summary: null });
    for (const call of captureExceptionMock.mock.calls) {
      const reason = (call[1] as { tags?: Record<string, string> })?.tags?.reason;
      expect(reason).toBeTruthy();
      expect(FORBIDDEN.has(String(reason))).toBe(false);
    }
  });

  it('coerces string numbers ("500") into numbers', async () => {
    const res = await extractQuoteFromCall({
      transcript: 'x',
      summary: null,
      vapiAnalysis: {
        structuredData: { priceMin: '500', priceMax: '900', confidenceScore: '0.7' },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.quote.priceMin).toBe(500);
      expect(res.quote.priceMax).toBe(900);
      expect(res.quote.confidenceScore).toBeCloseTo(0.7);
    }
  });

  it('drops non-finite numbers (NaN) back to null', async () => {
    const res = await extractQuoteFromCall({
      transcript: 'x',
      summary: null,
      vapiAnalysis: {
        structuredData: { priceMin: 'not a number', priceMax: null, confidenceScore: 0.5 },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.quote.priceMin).toBeNull();
      expect(res.quote.priceMax).toBeNull();
    }
  });
});
