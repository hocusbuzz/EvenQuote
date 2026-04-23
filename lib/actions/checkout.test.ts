// Tests for createCheckoutSession — the server action that creates a
// Stripe Checkout Session for a quote_request.
//
// We stub:
//   - next/headers (for rate-limit IP + site-url fallback)
//   - @/lib/supabase/admin (the quote_request read)
//   - @/lib/stripe/server (the Stripe client + price config)
//
// The real rate-limit module is exercised; each test uses a unique IP so
// the bucket is scoped.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const origAppUrl = process.env.NEXT_PUBLIC_APP_URL;

function mockHeaders(ip: string) {
  vi.doMock('next/headers', () => ({
    headers: () => ({
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === 'x-forwarded-for') return ip;
        if (n === 'x-forwarded-proto') return 'https';
        if (n === 'host') return 'evenquote.com';
        return null;
      },
    }),
  }));
}

type FakeRow = {
  id: string;
  status: string;
  intake_data: Record<string, unknown> | null;
  city: string;
  state: string;
};

function mockAdmin(row: FakeRow | null, opts: { loadError?: boolean } = {}) {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table !== 'quote_requests') {
          throw new Error(`unexpected table ${table}`);
        }
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: opts.loadError ? null : row,
                  error: opts.loadError ? { message: 'db down' } : null,
                }),
            }),
          }),
        };
      },
    }),
  }));
}

type StripeMock = {
  create: ReturnType<typeof vi.fn>;
};

function mockStripe(result: { url?: string; throwErr?: Error }): StripeMock {
  const create = vi.fn(async () => {
    if (result.throwErr) throw result.throwErr;
    return { url: result.url };
  });
  vi.doMock('@/lib/stripe/server', () => ({
    getStripe: () => ({ checkout: { sessions: { create } } }),
    QUOTE_REQUEST_PRICE: {
      amountCents: 999,
      currency: 'usd',
      productName: 'EvenQuote — AI Quote Request',
      productDescription: 'desc',
    },
  }));
  return { create };
}

describe('createCheckoutSession', () => {
  beforeEach(() => {
    vi.resetModules();
    // Deterministic site URL so assertions are stable
    process.env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
  });
  afterEach(() => {
    if (origAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = origAppUrl;
  });

  it('rejects a non-UUID requestId', async () => {
    mockHeaders(`5.5.5.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin(null);
    mockStripe({ url: 'https://stripe.test/s/1' });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({ requestId: 'not-a-uuid' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.toLowerCase()).toContain('invalid request id');
  });

  it('returns not-found when the quote_request does not exist', async () => {
    mockHeaders(`5.5.6.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin(null, { loadError: true });
    mockStripe({ url: 'https://stripe.test/s/2' });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/i);
  });

  it('returns alreadyPaid when status is already paid', async () => {
    mockHeaders(`5.5.7.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'paid',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    const stripe = mockStripe({ url: 'https://stripe.test/s/3' });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(true);
    if (res.ok && 'alreadyPaid' in res) {
      expect(res.alreadyPaid).toBe(true);
      expect(res.requestId).toBe('11111111-2222-3333-4444-555555555555');
    } else {
      expect.fail('expected alreadyPaid');
    }
    // We must not have called Stripe on an already-paid request.
    expect(stripe.create).not.toHaveBeenCalled();
  });

  it('rejects when status is anything other than pending_payment/paid/calling/processing/completed', async () => {
    mockHeaders(`5.5.8.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'failed',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ url: 'https://stripe.test/s/4' });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/failed/);
  });

  it('rejects when intake is missing a contact_email', async () => {
    mockHeaders(`5.5.9.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'pending_payment',
      intake_data: {}, // no contact_email
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ url: 'https://stripe.test/s/5' });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing a contact email/i);
  });

  it('creates a session with the expected shape on a valid pending_payment request', async () => {
    mockHeaders(`5.5.10.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'pending_payment',
      intake_data: { contact_email: ' Hello@Example.COM ' },
      city: 'Austin',
      state: 'TX',
    });
    const stripe = mockStripe({ url: 'https://checkout.stripe.com/pay/cs_test_XYZ' });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(true);
    if (res.ok && 'url' in res) {
      expect(res.url).toBe('https://checkout.stripe.com/pay/cs_test_XYZ');
    } else {
      expect.fail('expected url');
    }
    expect(stripe.create).toHaveBeenCalledOnce();
    const payload = stripe.create.mock.calls[0][0];
    expect(payload.mode).toBe('payment');
    expect(payload.payment_method_types).toEqual(['card']);
    expect(payload.line_items[0].price_data.unit_amount).toBe(999);
    expect(payload.line_items[0].price_data.currency).toBe('usd');
    // Email should be lowered + trimmed
    expect(payload.customer_email).toBe('hello@example.com');
    expect(payload.client_reference_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(payload.metadata.quote_request_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(payload.metadata.destination_city).toBe('Austin');
    expect(payload.metadata.destination_state).toBe('TX');
    // URLs should be derived from NEXT_PUBLIC_APP_URL
    expect(payload.success_url).toMatch(/^https:\/\/evenquote\.com\/get-quotes\/success/);
    expect(payload.cancel_url).toMatch(/^https:\/\/evenquote\.com\/get-quotes\/checkout/);
    // expires_at within the next ~30min window
    const now = Math.floor(Date.now() / 1000);
    expect(payload.expires_at).toBeGreaterThan(now + 29 * 60);
    expect(payload.expires_at).toBeLessThan(now + 31 * 60);
  });

  it('returns an error when Stripe does not return a url', async () => {
    mockHeaders(`5.5.11.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({}); // url undefined
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/did not return/i);
  });

  it('returns a friendly error when Stripe throws', async () => {
    mockHeaders(`5.5.12.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ throwErr: new Error('API outage') });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // User-facing error should NOT echo Stripe's internal message
      expect(res.error).not.toContain('API outage');
      expect(res.error).toMatch(/Could not start checkout/i);
    }
  });

  it('rate-limits to 20/min/IP', async () => {
    const ip = `5.5.13.${Math.floor(Math.random() * 254) + 1}`;
    mockHeaders(ip);
    mockAdmin({
      id: '11111111-2222-3333-4444-555555555555',
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ url: 'https://stripe.test/s/20' });
    const { createCheckoutSession } = await import('./checkout');

    // 20 OK, 21st should fail
    for (let i = 0; i < 20; i++) {
      const r = await createCheckoutSession({
        requestId: '11111111-2222-3333-4444-555555555555',
      });
      expect(r.ok).toBe(true);
    }
    const blocked = await createCheckoutSession({
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/too many checkout attempts/i);
  });
});
