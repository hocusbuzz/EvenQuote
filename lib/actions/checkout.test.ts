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

// ── Round 28 observability contract ──
//
// Shared captureException spy. Pattern mirrors R19's
// post-payment.test.ts — the lib boundary captures so every caller
// (server action from client today, admin-retry button tomorrow)
// inherits observability coverage without duplicating try/catch at
// every call site. Sentry dedupes on error fingerprint — route-level
// captures in callers add route context as separate tag sets; they
// don't double-count.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) => captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

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
    captureExceptionMock.mockReset();
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
    // Locks the May 2026 fix: receipt_email MUST be set on
    // payment_intent_data so Stripe actually emails the receipt.
    // customer_email alone only prefills the form — does NOT trigger
    // a receipt. A real customer noticed receipts were never arriving.
    expect(payload.payment_intent_data?.receipt_email).toBe(
      'hello@example.com',
    );
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

  // ── Round 28 observability contract ──
  //
  // Prior to R28, `createCheckoutSession` had TWO silent failure
  // paths that returned `{ok:false}` with no Sentry visibility:
  //   1. `stripeReturnedEmptyUrl` — a non-thrown response with
  //      `session.url === undefined`. Possible causes: Stripe SDK
  //      contract break, restricted API key, account suspension.
  //      Pre-R28 user saw "Stripe did not return a URL" on every
  //      checkout attempt with zero ops signal.
  //   2. `stripeSessionCreateFailed` — any thrown error from
  //      `stripe.checkout.sessions.create`. Possible causes: Stripe
  //      API outage, network partition, expired API key.
  //      Pre-R28 the log.error fired but nothing paged ops. Checkout
  //      is the top of the payment funnel — losing observability here
  //      means losing the conversion signal entirely.
  //
  // Canonical tags now: `{ lib:'checkout', reason, requestId }`. Any
  // new reason must be added to both the CheckoutReason type in
  // checkout.ts AND to the regression-guard at the bottom of this
  // file that forbids catch-alls.

  it('captures to Sentry when Stripe throws, with canonical lib+reason tags', async () => {
    mockHeaders(`5.5.14.${Math.floor(Math.random() * 254) + 1}`);
    const reqId = '11111111-2222-3333-4444-555555555555';
    mockAdmin({
      id: reqId,
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ throwErr: new Error('Stripe internal: card_declined 4.0.2') });
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({ requestId: reqId });
    expect(res.ok).toBe(false);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    // The wrapped error hides Stripe's internal message — keeps
    // Sentry fingerprints stable and prevents PII-adjacent leaks.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('stripe.checkout.sessions.create failed');
    expect((err as Error).message).not.toContain('card_declined');
    // Tag schema lock.
    expect(ctx).toMatchObject({
      tags: {
        lib: 'checkout',
        reason: 'stripeSessionCreateFailed',
        requestId: reqId,
      },
    });
  });

  it('captures to Sentry when Stripe returns no url, with canonical tags', async () => {
    mockHeaders(`5.5.15.${Math.floor(Math.random() * 254) + 1}`);
    const reqId = '22222222-3333-4444-5555-666666666666';
    mockAdmin({
      id: reqId,
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({}); // no throwErr, no url → SDK contract break
    const { createCheckoutSession } = await import('./checkout');
    const res = await createCheckoutSession({ requestId: reqId });
    expect(res.ok).toBe(false);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/returned no url/i);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'checkout',
        reason: 'stripeReturnedEmptyUrl',
        requestId: reqId,
      },
    });
  });

  it('does NOT capture to Sentry on happy path', async () => {
    // False-positive guard. If Sentry ever sees "lib:checkout" noise
    // on a successful session, this test is the first place to check.
    mockHeaders(`5.5.16.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '33333333-4444-5555-6666-777777777777',
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ url: 'https://checkout.stripe.com/pay/cs_ok' });
    const { createCheckoutSession } = await import('./checkout');
    await createCheckoutSession({ requestId: '33333333-4444-5555-6666-777777777777' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT capture to Sentry on input-validation failures (infra noise guard)', async () => {
    // Invalid UUID / not-found / wrong-status are all user-/caller-
    // side inputs, not system failures. Capturing would flood Sentry
    // with every malformed request and drown real incidents.
    mockHeaders(`5.5.17.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin(null);
    mockStripe({ url: 'https://stripe.test/s/x' });
    const { createCheckoutSession } = await import('./checkout');

    await createCheckoutSession({ requestId: 'not-a-uuid' });
    expect(captureExceptionMock).not.toHaveBeenCalled();

    // Also wrong-status path
    vi.resetModules();
    mockHeaders(`5.5.17.${Math.floor(Math.random() * 254) + 1}`);
    mockAdmin({
      id: '44444444-5555-6666-7777-888888888888',
      status: 'failed',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ url: 'https://stripe.test/s/y' });
    const { createCheckoutSession: fresh } = await import('./checkout');
    await fresh({ requestId: '44444444-5555-6666-7777-888888888888' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT include raw stripe message / customer email as tag value (PII guard)', async () => {
    mockHeaders(`5.5.18.${Math.floor(Math.random() * 254) + 1}`);
    const reqId = '55555555-6666-7777-8888-999999999999';
    mockAdmin({
      id: reqId,
      status: 'pending_payment',
      intake_data: { contact_email: 'private@customer.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({
      throwErr: new Error('cu_xyz123 could not be charged: card_declined'),
    });
    const { createCheckoutSession } = await import('./checkout');
    await createCheckoutSession({ requestId: reqId });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toMatch(/private@customer\.com/);
    expect(serialized).not.toMatch(/cu_xyz123/);
    expect(serialized).not.toMatch(/card_declined/);
  });

  // Regression-guard: forbids catch-all reasons that would undermine
  // Sentry facet granularity. Pattern from R25/R27.
  it('never emits catch-all reason values (regression guard)', async () => {
    mockHeaders(`5.5.19.${Math.floor(Math.random() * 254) + 1}`);
    const reqId = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    mockAdmin({
      id: reqId,
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ throwErr: new Error('boom') });
    const { createCheckoutSession } = await import('./checkout');
    await createCheckoutSession({ requestId: reqId });

    const forbidden = new Set([
      'unknown',
      'error',
      'checkoutFailed',
      'stripeError',
      'sessionFailed',
      'runFailed',
    ]);
    for (const call of captureExceptionMock.mock.calls) {
      const ctx = call[1] as { tags?: { reason?: string } };
      const reason = ctx?.tags?.reason;
      expect(reason).toBeDefined();
      expect(forbidden.has(reason as string)).toBe(false);
    }
  });

  it('tag object is strictly {lib, reason, requestId} — no extra facets', async () => {
    // Tag schema lock. Prevents a future "helpful" addition of
    // email/customerId/etc that would leak PII into the tracker.
    mockHeaders(`5.5.20.${Math.floor(Math.random() * 254) + 1}`);
    const reqId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    mockAdmin({
      id: reqId,
      status: 'pending_payment',
      intake_data: { contact_email: 'a@b.com' },
      city: 'Austin',
      state: 'TX',
    });
    mockStripe({ throwErr: new Error('boom') });
    const { createCheckoutSession } = await import('./checkout');
    await createCheckoutSession({ requestId: reqId });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const tagKeys = Object.keys((ctx as { tags: Record<string, string> }).tags).sort();
    expect(tagKeys).toEqual(['lib', 'reason', 'requestId']);
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
