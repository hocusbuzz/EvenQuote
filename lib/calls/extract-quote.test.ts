// Unit tests for extractQuoteFromCall and its coercion helpers.
//
// Strategy:
//   • We don't hit Anthropic — coverage focuses on the paths that don't
//     need the network: Vapi structured-data preference, no-api-key fail,
//     empty-transcript fail, and schema coercion (number/string/array).
//   • Anthropic fetch is mocked at module boundary via vi.stubGlobal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractQuoteFromCall } from './extract-quote';

describe('extractQuoteFromCall', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
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
  });

  it('returns ok:false when transcript is empty and Vapi has no data', async () => {
    process.env.ANTHROPIC_API_KEY = 'anth-test';
    const res = await extractQuoteFromCall({
      transcript: '',
      summary: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/transcript/i);
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

  it('reports ok:false when Anthropic returns non-ok HTTP', async () => {
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
  });

  it('reports ok:false when Anthropic response has no tool_use', async () => {
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
  });

  it('handles network error as a soft failure (no throw)', async () => {
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
