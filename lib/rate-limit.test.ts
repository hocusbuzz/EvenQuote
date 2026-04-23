import { describe, it, expect } from 'vitest';
import { rateLimit, clientKey, clientKeyFromHeaders } from './rate-limit';

describe('rateLimit', () => {
  it('allows the first N requests and blocks the N+1', () => {
    const key = `t:${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit(key, { limit: 3, windowMs: 5000 }).ok).toBe(true);
    }
    const blocked = rateLimit(key, { limit: 3, windowMs: 5000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('returns remaining count accurately', () => {
    const key = `t:${Math.random()}`;
    const first = rateLimit(key, { limit: 5, windowMs: 5000 });
    expect(first.remaining).toBe(4);
    const second = rateLimit(key, { limit: 5, windowMs: 5000 });
    expect(second.remaining).toBe(3);
  });

  it('isolates keys from each other', () => {
    const a = `t:a:${Math.random()}`;
    const b = `t:b:${Math.random()}`;
    for (let i = 0; i < 3; i++) rateLimit(a, { limit: 3, windowMs: 5000 });
    // a is now saturated. b should still be fresh.
    expect(rateLimit(a, { limit: 3, windowMs: 5000 }).ok).toBe(false);
    expect(rateLimit(b, { limit: 3, windowMs: 5000 }).ok).toBe(true);
  });
});

describe('clientKey', () => {
  it('prefers x-forwarded-for first entry', () => {
    const req = new Request('https://e.com', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    });
    expect(clientKey(req, 'route')).toBe('route:1.2.3.4');
  });

  it('falls back to x-real-ip when XFF is absent', () => {
    const req = new Request('https://e.com', {
      headers: { 'x-real-ip': '9.9.9.9' },
    });
    expect(clientKey(req, 'route')).toBe('route:9.9.9.9');
  });

  it('uses "unknown" when both headers are missing', () => {
    const req = new Request('https://e.com');
    expect(clientKey(req, 'route')).toBe('route:unknown');
  });
});

describe('clientKeyFromHeaders', () => {
  function h(entries: Record<string, string>) {
    return {
      get: (name: string) => entries[name.toLowerCase()] ?? null,
    };
  }

  it('prefers first x-forwarded-for entry', () => {
    expect(
      clientKeyFromHeaders(h({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), 'action')
    ).toBe('action:1.2.3.4');
  });

  it('falls back to x-real-ip when XFF is missing', () => {
    expect(
      clientKeyFromHeaders(h({ 'x-real-ip': '9.9.9.9' }), 'action')
    ).toBe('action:9.9.9.9');
  });

  it('uses unknown when headers are missing', () => {
    expect(clientKeyFromHeaders(h({}), 'action')).toBe('action:unknown');
  });
});
