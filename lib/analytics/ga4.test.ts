// Tests for the GA4 analytics module — both surfaces.
//
//   • Client-side (`gaClientEvent`): fires through window.gtag when
//     ready; queues into window.dataLayer when gtag.js hasn't loaded
//     yet; no-ops gracefully when neither is available.
//   • Server-side (`sendServerEvent`): POSTs to the Measurement
//     Protocol endpoint with the right URL params + JSON body; no-ops
//     when env vars are missing; never throws.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gaClientEvent, sendServerEvent, ANALYTICS_EVENTS } from './ga4';

// ───────── Client-side ─────────

describe('gaClientEvent', () => {
  beforeEach(() => {
    // Clean slate per test — these mutate the global.
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('returns false when window is undefined (SSR pass)', () => {
    expect(gaClientEvent('quote_request_started')).toBe(false);
  });

  it('calls window.gtag with event name + params when gtag is defined', () => {
    const gtag = vi.fn();
    // @ts-expect-error — augmenting test-side window
    globalThis.window = { gtag };

    gaClientEvent('quote_request_paid', { vertical: 'moving', value: 9.99, currency: 'USD' });

    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith('event', 'quote_request_paid', {
      vertical: 'moving',
      value: 9.99,
      currency: 'USD',
    });
  });

  it('falls back to dataLayer.push when gtag is not yet defined', () => {
    const dataLayer: unknown[] = [];
    // @ts-expect-error
    globalThis.window = { dataLayer };

    const ok = gaClientEvent('quote_request_started', { vertical: 'cleaning' });

    expect(ok).toBe(true);
    expect(dataLayer).toHaveLength(1);
    expect(dataLayer[0]).toEqual({ event: 'quote_request_started', vertical: 'cleaning' });
  });

  it('returns false when neither gtag nor dataLayer exists', () => {
    // @ts-expect-error
    globalThis.window = {};
    expect(gaClientEvent('quote_request_started')).toBe(false);
  });
});

// ───────── Server-side ─────────

describe('sendServerEvent', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('no-ops when NEXT_PUBLIC_GA4_MEASUREMENT_ID is missing', async () => {
    delete process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
    process.env.GA4_API_SECRET = 'present';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await sendServerEvent({
      name: 'quote_delivered',
      clientId: 'req-123',
      params: { vertical: 'handyman' },
    });

    expect(r).toEqual({ ok: false, reason: 'ga4-not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops when GA4_API_SECRET is missing', async () => {
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-FAKE';
    delete process.env.GA4_API_SECRET;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await sendServerEvent({ name: 'quote_delivered', clientId: 'req-123' });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to Measurement Protocol with the right URL + body when configured', async () => {
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-FAKE';
    process.env.GA4_API_SECRET = 'sekret';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await sendServerEvent({
      name: 'quote_delivered',
      clientId: 'req-abc',
      params: { vertical: 'cleaning', request_id: 'req-abc' },
    });

    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('measurement_id=G-FAKE');
    expect(url).toContain('api_secret=sekret');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      client_id: string;
      non_personalized_ads: boolean;
      events: { name: string; params: Record<string, unknown> }[];
    };
    expect(body.client_id).toBe('req-abc');
    expect(body.non_personalized_ads).toBe(true);
    expect(body.events[0].name).toBe('quote_delivered');
    expect(body.events[0].params).toEqual({
      vertical: 'cleaning',
      request_id: 'req-abc',
    });
  });

  it('returns ok:false on non-2xx response without throwing', async () => {
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-FAKE';
    process.env.GA4_API_SECRET = 'sekret';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const r = await sendServerEvent({ name: 'quote_delivered', clientId: 'req-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('mp-500');
  });

  it('returns ok:false when fetch itself rejects (network down)', async () => {
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-FAKE';
    process.env.GA4_API_SECRET = 'sekret';
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const r = await sendServerEvent({ name: 'quote_delivered', clientId: 'req-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ECONNREFUSED');
  });

  it('encodes URL params so a quote/equals in the secret stays valid', async () => {
    process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID = 'G-FAKE';
    process.env.GA4_API_SECRET = 'a=b&c=d';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendServerEvent({ name: 'quote_delivered', clientId: 'req-x' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api_secret=a%3Db%26c%3Dd');
  });
});

// ───────── Catalog ─────────

describe('ANALYTICS_EVENTS', () => {
  it('exposes exactly the three Day-8 funnel events', () => {
    expect([...ANALYTICS_EVENTS]).toEqual([
      'quote_request_started',
      'quote_request_paid',
      'quote_delivered',
    ]);
  });
});
