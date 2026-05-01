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
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('no-ops with capi-not-configured when token + pixel id are missing', async () => {
    delete process.env.META_CONVERSIONS_API_TOKEN;
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    const r = await sendMetaServerEvent({ name: 'quote_delivered', clientId: 'r1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capi-not-configured');
  });

  it('returns capi-not-wired when configured (stub awaiting #127)', async () => {
    process.env.META_CONVERSIONS_API_TOKEN = 'EAAjsomelongtokenstring';
    process.env.NEXT_PUBLIC_META_PIXEL_ID = '757034602429708';
    const r = await sendMetaServerEvent({ name: 'quote_delivered', clientId: 'r1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('capi-not-wired');
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
