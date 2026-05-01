// Tests for the Meta Pixel client.
//
//   • metaClientEvent: maps our event vocab → Meta's standard/custom
//     names, formats params (value/currency + content_ids array),
//     dispatches via window.fbq.
//   • sendMetaServerEvent: stub today; returns the right reason
//     string without throwing.
//   • Event-name map: locked so a future change to the canonical
//     vocab forces a deliberate update on the Meta side.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  metaClientEvent,
  sendMetaServerEvent,
  __META_EVENT_MAP_INTERNAL,
} from './meta';

describe('metaClientEvent', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('returns false on the SSR pass (no window)', () => {
    expect(metaClientEvent('quote_request_started')).toBe(false);
  });

  it('returns false when fbq is not defined yet', () => {
    (globalThis as unknown as { window: { fbq?: unknown } }).window = {};
    expect(metaClientEvent('quote_request_started')).toBe(false);
  });

  it('maps quote_request_started → fbq("track", "Lead", ...)', () => {
    const fbq = vi.fn();
    (globalThis as unknown as { window: { fbq: unknown } }).window = { fbq };

    metaClientEvent('quote_request_started', { vertical: 'moving' });

    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith('track', 'Lead', {});
  });

  it('maps quote_request_paid → fbq("track", "Purchase", { value, currency, content_ids })', () => {
    const fbq = vi.fn();
    (globalThis as unknown as { window: { fbq: unknown } }).window = { fbq };

    metaClientEvent('quote_request_paid', {
      value: 9.99,
      currency: 'USD',
      request_id: 'req-abc',
      vertical: 'cleaning',
    });

    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', {
      value: 9.99,
      currency: 'USD',
      content_ids: ['req-abc'],
      content_type: 'product',
    });
  });

  it('maps quote_delivered → fbq("trackCustom", "QuoteDelivered", ...)', () => {
    const fbq = vi.fn();
    (globalThis as unknown as { window: { fbq: unknown } }).window = { fbq };

    metaClientEvent('quote_delivered', { request_id: 'req-xyz' });

    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith('trackCustom', 'QuoteDelivered', {
      content_ids: ['req-xyz'],
      content_type: 'product',
    });
  });

  it('does not include vertical in Meta params (it is not a Meta-recognized field)', () => {
    const fbq = vi.fn();
    (globalThis as unknown as { window: { fbq: unknown } }).window = { fbq };

    metaClientEvent('quote_request_started', { vertical: 'handyman' });

    const [, , params] = fbq.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(params).not.toHaveProperty('vertical');
  });
});

describe('sendMetaServerEvent', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('no-ops with capi-not-configured when token + pixel id are missing', async () => {
    delete process.env.META_CONVERSIONS_API_TOKEN;
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await sendMetaServerEvent({ name: 'quote_delivered', clientId: 'r1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capi-not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to graph.facebook.com with the right URL + payload shape', async () => {
    process.env.META_CONVERSIONS_API_TOKEN = 'EAAfakefakefakefakefake';
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '757034602429708';
    delete process.env.META_CAPI_TEST_EVENT_CODE;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await sendMetaServerEvent({
      name: 'quote_delivered',
      clientId: 'req-abc',
      params: { request_id: 'req-abc', vertical: 'cleaning' },
    });

    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://graph.facebook.com/');
    expect(url).toContain('/757034602429708/events');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      access_token: string;
      data: {
        event_name: string;
        action_source: string;
        event_id: string;
        user_data: { external_id: string };
        custom_data: Record<string, unknown>;
      }[];
      test_event_code?: string;
    };
    expect(body.access_token).toBe('EAAfakefakefakefakefake');
    expect(body.data[0].event_name).toBe('QuoteDelivered');
    expect(body.data[0].action_source).toBe('website');
    expect(body.data[0].event_id).toBe('QuoteDelivered:req-abc');
    // external_id must be SHA-256 hashed (64 hex chars), not the raw clientId.
    expect(body.data[0].user_data.external_id).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data[0].user_data.external_id).not.toBe('req-abc');
    // vertical is NOT a Meta-recognized field; must not appear.
    expect(body.data[0].custom_data).not.toHaveProperty('vertical');
    // request_id maps to content_ids array (Meta's format).
    expect(body.data[0].custom_data.content_ids).toEqual(['req-abc']);
    expect(body.data[0].custom_data.content_type).toBe('product');
    // test_event_code only appears when META_CAPI_TEST_EVENT_CODE env is set.
    expect(body.test_event_code).toBeUndefined();
  });

  it('forwards value+currency for Purchase events', async () => {
    process.env.META_CONVERSIONS_API_TOKEN = 'EAAfake';
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '757034602429708';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendMetaServerEvent({
      name: 'quote_request_paid',
      clientId: 'req-abc',
      params: { value: 9.99, currency: 'USD', request_id: 'req-abc' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      data: { event_name: string; custom_data: Record<string, unknown> }[];
    };
    expect(body.data[0].event_name).toBe('Purchase');
    expect(body.data[0].custom_data.value).toBe(9.99);
    expect(body.data[0].custom_data.currency).toBe('USD');
  });

  it('includes test_event_code when META_CAPI_TEST_EVENT_CODE is set', async () => {
    process.env.META_CONVERSIONS_API_TOKEN = 'EAAfake';
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '757034602429708';
    process.env.META_CAPI_TEST_EVENT_CODE = 'TEST12345';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendMetaServerEvent({
      name: 'quote_delivered',
      clientId: 'req-abc',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { test_event_code?: string };
    expect(body.test_event_code).toBe('TEST12345');
  });

  it('returns ok:false on non-2xx response without throwing', async () => {
    process.env.META_CONVERSIONS_API_TOKEN = 'EAAfake';
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '757034602429708';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch;

    const r = await sendMetaServerEvent({ name: 'quote_delivered', clientId: 'r1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capi-400');
  });

  it('returns ok:false when fetch itself rejects (network down)', async () => {
    process.env.META_CONVERSIONS_API_TOKEN = 'EAAfake';
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '757034602429708';
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const r = await sendMetaServerEvent({ name: 'quote_delivered', clientId: 'r1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ECONNREFUSED');
  });
});

describe('META_EVENT_MAP', () => {
  it('covers all three canonical events', () => {
    expect(__META_EVENT_MAP_INTERNAL.quote_request_started).toEqual({
      kind: 'standard',
      name: 'Lead',
    });
    expect(__META_EVENT_MAP_INTERNAL.quote_request_paid).toEqual({
      kind: 'standard',
      name: 'Purchase',
    });
    expect(__META_EVENT_MAP_INTERNAL.quote_delivered).toEqual({
      kind: 'custom',
      name: 'QuoteDelivered',
    });
  });
});
