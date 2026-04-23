// Tests for the Stripe server singleton.
//
// Contract:
//   - getStripe() throws a clear error when STRIPE_SECRET_KEY is unset
//     (we'd rather fail at call-time than silently construct a broken
//     client and pay with a confusing Stripe-side error later).
//   - Pinned API version is applied (deliberately — see the comment in
//     server.ts about not using "latest").
//   - Second call returns the same instance (caching).
//   - QUOTE_REQUEST_PRICE has the 999¢ / USD shape the checkout route
//     depends on.
//
// We mock the stripe package so we don't instantiate a real client (no
// real API calls, no package-shape coupling).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Capture the constructor call so we can assert on config.
const stripeCtor = vi.fn();

vi.mock('stripe', () => {
  class FakeStripe {
    config: unknown;
    constructor(key: string, opts: unknown) {
      stripeCtor(key, opts);
      this.config = opts;
    }
  }
  return { default: FakeStripe };
});

// lib/stripe/server.ts uses 'server-only' which throws when imported
// from a client component. In Vitest (Node), that module-side effect
// is a no-op in our resolver — but mock it defensively.
vi.mock('server-only', () => ({}));

describe('getStripe()', () => {
  const originalKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    stripeCtor.mockClear();
    // Reset module cache between tests so the `_stripe` singleton
    // doesn't leak across test cases.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
  });

  it('throws a clear error when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { getStripe } = await import('./server');
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY is not set/);
  });

  it('constructs with a pinned API version and appInfo', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const { getStripe } = await import('./server');
    getStripe();
    expect(stripeCtor).toHaveBeenCalledTimes(1);
    const [keyArg, optsArg] = stripeCtor.mock.calls[0];
    expect(keyArg).toBe('sk_test_fake');
    expect(optsArg).toMatchObject({
      apiVersion: '2025-02-24.acacia',
      appInfo: { name: 'EvenQuote' },
    });
  });

  it('caches the singleton across calls', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const { getStripe } = await import('./server');
    const a = getStripe();
    const b = getStripe();
    expect(a).toBe(b);
    expect(stripeCtor).toHaveBeenCalledTimes(1);
  });
});

describe('QUOTE_REQUEST_PRICE', () => {
  it('is $9.99 USD with a descriptive product name', async () => {
    const { QUOTE_REQUEST_PRICE } = await import('./server');
    expect(QUOTE_REQUEST_PRICE.amountCents).toBe(999);
    expect(QUOTE_REQUEST_PRICE.currency).toBe('usd');
    expect(QUOTE_REQUEST_PRICE.productName).toContain('EvenQuote');
    expect(QUOTE_REQUEST_PRICE.productDescription.length).toBeGreaterThan(0);
  });
});
