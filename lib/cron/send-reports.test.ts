// Tests for sendPendingReports — the cron worker that generates and
// emails the customer's quote report once a request is in 'processing'
// with report_sent_at NULL.
//
// Surfaces covered:
//   • candidate scan query shape
//   • recipient resolution: profile.email preferred, falls back to
//     intake_data.contact_email for guest flow
//   • skip when no recipient email at all
//   • zero-quotes refund path (Stripe call, idempotency key, payments
//     status update)
//   • refund 'pending_support' fallbacks (no payment row, no PI id,
//     Stripe throw)
//   • refund 'issued' short-circuit when payments.status='refunded' already
//   • non-zero-quotes skip refund entirely (refundOutcome='not_applicable')
//   • report_generated_at + report_data stamped before send
//   • successful send: status → 'completed', report_sent_at stamped
//   • failed send: status stays 'processing' (no final stamp)
//   • final stamp failure after successful send is surfaced as failed
//
// Supabase/Stripe/email are all stubbed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Mocks ────────────────────────────────────────────────────────────

const sendEmailSpy = vi.fn();
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmailSpy(...args),
}));

const renderSpy = vi.fn();
vi.mock('@/lib/email/templates', () => ({
  renderQuoteReport: (...args: unknown[]) => renderSpy(...args),
}));

const refundsCreateSpy = vi.fn();
vi.mock('@/lib/stripe/server', () => ({
  getStripe: () => ({
    refunds: { create: (...args: unknown[]) => refundsCreateSpy(...args) },
  }),
}));

// Import under test AFTER mocks register.
import { sendPendingReports } from './send-reports';

// ─── Stub factory ─────────────────────────────────────────────────────

type RequestRow = {
  id: string;
  user_id: string | null;
  city: string;
  state: string;
  intake_data: Record<string, unknown> | null;
  total_businesses_to_call: number;
  total_calls_completed: number;
  total_quotes_collected: number;
  category: { name: string; slug: string } | { name: string; slug: string }[] | null;
};

type QuoteRow = {
  id: string;
  business_id: string;
  price_min: number | null;
  price_max: number | null;
  price_description: string | null;
  availability: string | null;
  includes: string[] | null;
  excludes: string[] | null;
  notes: string | null;
  requires_onsite_estimate: boolean;
  business: { name: string } | { name: string }[] | null;
};

type ProfileRow = { email: string | null; full_name: string | null };
type PaymentRow = {
  id: string;
  stripe_payment_intent_id: string | null;
  status: string;
};

type StubState = {
  // Scan for processing requests:
  requests: RequestRow[];
  requestsError: { message: string } | null;
  // Keyed lookups by id:
  quotesByRequestId: Record<string, QuoteRow[]>;
  profilesByUserId: Record<string, ProfileRow | null>;
  paymentsByRequestId: Record<string, PaymentRow | null>;
  // Error injection:
  quotesError: { message: string } | null;
  paymentsLookupError: { message: string } | null;
  // Captured update payloads per table:
  quoteRequestUpdates: Array<{ id: string; payload: Record<string, unknown> }>;
  paymentUpdates: Array<{ id: string; payload: Record<string, unknown> }>;
  quoteRequestUpdateErrorByField: {
    report_generated_at?: { message: string };
    report_sent_at?: { message: string };
  };
  // Capture last scan query shape:
  lastScanQuery: {
    filters: Record<string, unknown>;
    isNullCols: string[];
    orderings: Array<{ col: string; asc?: boolean }>;
    limit?: number;
  };
};

function makeAdmin(initial: Partial<StubState> = {}): {
  admin: SupabaseClient;
  state: StubState;
} {
  const state: StubState = {
    requests: [],
    requestsError: null,
    quotesByRequestId: {},
    profilesByUserId: {},
    paymentsByRequestId: {},
    quotesError: null,
    paymentsLookupError: null,
    quoteRequestUpdates: [],
    paymentUpdates: [],
    quoteRequestUpdateErrorByField: {},
    lastScanQuery: {
      filters: {},
      isNullCols: [],
      orderings: [],
    },
    ...initial,
  };

  // Track which table+operation is in flight so chained calls route correctly.
  const admin = {
    from: (table: string) => {
      if (table === 'quote_requests') return quoteRequestsBuilder();
      if (table === 'quotes') return quotesBuilder();
      if (table === 'profiles') return profilesBuilder();
      if (table === 'payments') return paymentsBuilder();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  function quoteRequestsBuilder() {
    return {
      select: (_cols: string) => {
        // Only the scan path uses select on quote_requests in this worker.
        const api: Record<string, unknown> = {};
        const query = state.lastScanQuery;
        api.eq = (col: string, val: unknown) => {
          query.filters[col] = val;
          return api;
        };
        api.is = (col: string, val: unknown) => {
          if (val === null) query.isNullCols.push(col);
          return api;
        };
        api.order = (col: string, opts?: { ascending?: boolean }) => {
          query.orderings.push({ col, asc: opts?.ascending });
          return api;
        };
        api.limit = (n: number) => {
          query.limit = n;
          return Promise.resolve({
            data: state.requestsError ? null : state.requests,
            error: state.requestsError,
          });
        };
        return api;
      },
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          // Pick which error (if any) applies based on payload shape.
          let err: { message: string } | null = null;
          if (
            payload.report_generated_at &&
            !payload.report_sent_at &&
            state.quoteRequestUpdateErrorByField.report_generated_at
          ) {
            err = state.quoteRequestUpdateErrorByField.report_generated_at;
          } else if (
            payload.report_sent_at &&
            state.quoteRequestUpdateErrorByField.report_sent_at
          ) {
            err = state.quoteRequestUpdateErrorByField.report_sent_at;
          }
          state.quoteRequestUpdates.push({ id, payload });
          return Promise.resolve({ data: null, error: err });
        },
      }),
    };
  }

  function quotesBuilder() {
    return {
      select: (_cols: string) => {
        const api: Record<string, unknown> = {};
        let capturedId: string | undefined;
        api.eq = (col: string, val: unknown) => {
          if (col === 'quote_request_id') capturedId = val as string;
          return api;
        };
        api.order = () => ({
          // The order call returns a thenable directly — the worker awaits it.
          then: (resolve: (v: unknown) => unknown) => {
            const rows = capturedId
              ? state.quotesByRequestId[capturedId] ?? []
              : [];
            return Promise.resolve({
              data: state.quotesError ? null : rows,
              error: state.quotesError,
            }).then(resolve);
          },
        });
        return api;
      },
    };
  }

  function profilesBuilder() {
    return {
      select: (_cols: string) => ({
        eq: (_col: string, userId: string) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: state.profilesByUserId[userId] ?? null,
              error: null,
            }),
        }),
      }),
    };
  }

  function paymentsBuilder() {
    return {
      select: (_cols: string) => ({
        eq: (_col: string, requestId: string) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: state.paymentsLookupError
                ? null
                : state.paymentsByRequestId[requestId] ?? null,
              error: state.paymentsLookupError,
            }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          state.paymentUpdates.push({ id, payload });
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
  }

  return { admin, state };
}

// ─── Fixtures ─────────────────────────────────────────────────────────

function baseRequest(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 'qr_1',
    user_id: null,
    city: 'Austin',
    state: 'TX',
    intake_data: { contact_name: 'Alex', contact_email: 'alex@example.com' },
    total_businesses_to_call: 10,
    total_calls_completed: 10,
    total_quotes_collected: 3,
    category: { name: 'Moving', slug: 'moving' },
    ...overrides,
  };
}

function quote(overrides: Partial<QuoteRow> = {}): QuoteRow {
  return {
    id: 'q_1',
    business_id: 'biz_1',
    price_min: 800,
    price_max: 1200,
    price_description: '$800–$1,200',
    availability: 'next week',
    includes: ['2 movers', 'truck'],
    excludes: ['packing materials'],
    notes: null,
    requires_onsite_estimate: false,
    business: { name: 'Acme Movers' },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('sendPendingReports', () => {
  beforeEach(() => {
    sendEmailSpy.mockReset();
    renderSpy.mockReset();
    refundsCreateSpy.mockReset();

    // Default: render returns a minimal envelope.
    renderSpy.mockReturnValue({
      subject: 'Your EvenQuote report',
      html: '<p>report</p>',
      text: 'report',
    });
    // Default: send succeeds.
    sendEmailSpy.mockResolvedValue({
      ok: true,
      simulated: false,
      id: 'email_abc',
    });
    // Default: stripe refund resolves.
    refundsCreateSpy.mockResolvedValue({ id: 're_1', status: 'succeeded' });
  });

  it('returns zeros when no requests are processing', async () => {
    const { admin } = makeAdmin({ requests: [] });
    const result = await sendPendingReports(admin);
    expect(result).toMatchObject({
      ok: true,
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it('applies the correct scan query: status=processing, report_sent_at null, created_at asc, limit 25', async () => {
    const { admin, state } = makeAdmin({ requests: [] });
    await sendPendingReports(admin);
    expect(state.lastScanQuery.filters).toMatchObject({ status: 'processing' });
    expect(state.lastScanQuery.isNullCols).toContain('report_sent_at');
    expect(state.lastScanQuery.orderings[0]).toMatchObject({
      col: 'created_at',
      asc: true,
    });
    expect(state.lastScanQuery.limit).toBe(25);
  });

  it('throws when the scan query fails — the cron route handler converts to 500', async () => {
    const { admin } = makeAdmin({
      requestsError: { message: 'timeout' },
    });
    await expect(sendPendingReports(admin)).rejects.toThrow(/quote_requests scan/);
  });

  it('happy path: sends email, stamps report_generated_at then report_sent_at, flips status to completed', async () => {
    const req = baseRequest({ id: 'qr_happy' });
    const { admin, state } = makeAdmin({
      requests: [req],
      quotesByRequestId: { qr_happy: [quote(), quote({ id: 'q_2' })] },
    });

    const result = await sendPendingReports(admin);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.details[0]).toMatchObject({
      request_id: 'qr_happy',
      status: 'sent',
      email_id: 'email_abc',
    });

    // Two updates to quote_requests: first stamps generated_at+report_data,
    // second stamps report_sent_at+status=completed.
    const reqUpdates = state.quoteRequestUpdates.filter(
      (u) => u.id === 'qr_happy'
    );
    expect(reqUpdates).toHaveLength(2);
    expect(reqUpdates[0].payload).toMatchObject({
      report_generated_at: expect.any(String),
      report_data: expect.objectContaining({
        quote_count: 2,
        refund_outcome: 'not_applicable',
      }),
    });
    expect(reqUpdates[1].payload).toMatchObject({
      report_sent_at: expect.any(String),
      status: 'completed',
    });

    // sendEmail got the rendered envelope.
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const sent = sendEmailSpy.mock.calls[0][0];
    expect(sent.to).toBe('alex@example.com');
    expect(sent.subject).toBe('Your EvenQuote report');
    expect(sent.tag).toBe('quote-report');

    // No refund should have fired — we had quotes.
    expect(refundsCreateSpy).not.toHaveBeenCalled();
  });

  it('prefers profile.email over intake.contact_email when user_id is set', async () => {
    const req = baseRequest({
      id: 'qr_authed',
      user_id: 'user_1',
      intake_data: { contact_email: 'guest@example.com' },
    });
    const { admin } = makeAdmin({
      requests: [req],
      profilesByUserId: {
        user_1: { email: 'user@example.com', full_name: 'Real User' },
      },
      quotesByRequestId: { qr_authed: [quote()] },
    });

    await sendPendingReports(admin);

    expect(sendEmailSpy.mock.calls[0][0].to).toBe('user@example.com');
  });

  it('falls back to intake.contact_email when user_id is set but profile email is empty', async () => {
    const req = baseRequest({
      id: 'qr_fallback',
      user_id: 'user_2',
      intake_data: { contact_email: 'guest@example.com' },
    });
    const { admin } = makeAdmin({
      requests: [req],
      profilesByUserId: { user_2: { email: null, full_name: null } },
      quotesByRequestId: { qr_fallback: [quote()] },
    });

    await sendPendingReports(admin);

    expect(sendEmailSpy.mock.calls[0][0].to).toBe('guest@example.com');
  });

  it('skips when no recipient email can be resolved', async () => {
    const req = baseRequest({
      id: 'qr_noemail',
      user_id: null,
      intake_data: {},
    });
    const { admin, state } = makeAdmin({
      requests: [req],
      quotesByRequestId: { qr_noemail: [quote()] },
    });

    const result = await sendPendingReports(admin);

    expect(result.skipped).toBe(1);
    expect(result.details[0]).toMatchObject({
      request_id: 'qr_noemail',
      status: 'skipped',
      reason: 'no recipient email',
    });
    // No email was sent, no updates stamped.
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(state.quoteRequestUpdates).toHaveLength(0);
  });

  describe('zero-quotes refund path', () => {
    it("calls Stripe with idempotency key, marks payments.status='refunded', reports 'issued'", async () => {
      const req = baseRequest({
        id: 'qr_zero',
        total_quotes_collected: 0,
      });
      const { admin, state } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_zero: [] }, // zero quotes
        paymentsByRequestId: {
          qr_zero: {
            id: 'pay_1',
            stripe_payment_intent_id: 'pi_123',
            status: 'paid',
          },
        },
      });

      await sendPendingReports(admin);

      expect(refundsCreateSpy).toHaveBeenCalledTimes(1);
      const [refundArgs, refundOpts] = refundsCreateSpy.mock.calls[0];
      expect(refundArgs).toMatchObject({
        payment_intent: 'pi_123',
        reason: 'requested_by_customer',
        metadata: expect.objectContaining({
          quote_request_id: 'qr_zero',
          payment_row_id: 'pay_1',
          source: 'cron/send-reports/zero-quotes',
        }),
      });
      // Idempotency key derived from the payment row id — cron retry
      // returns the same refund instead of creating a second.
      expect(refundOpts).toEqual({
        idempotencyKey: 'refund-zero-quotes-pay_1',
      });

      // payments.status flipped to 'refunded'.
      expect(state.paymentUpdates).toEqual([
        { id: 'pay_1', payload: { status: 'refunded' } },
      ]);

      // Template saw refund_outcome='issued'.
      const renderedInput = renderSpy.mock.calls[0][0];
      expect(renderedInput.refundOutcome).toBe('issued');

      // The report_data snapshot also captures the outcome.
      const firstUpdate = state.quoteRequestUpdates.find(
        (u) => u.id === 'qr_zero' && 'report_generated_at' in u.payload
      );
      expect(firstUpdate?.payload.report_data).toMatchObject({
        refund_outcome: 'issued',
      });
    });

    it("short-circuits to 'issued' without calling Stripe when payments.status='refunded' already", async () => {
      const req = baseRequest({ id: 'qr_already', total_quotes_collected: 0 });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_already: [] },
        paymentsByRequestId: {
          qr_already: {
            id: 'pay_2',
            stripe_payment_intent_id: 'pi_456',
            status: 'refunded',
          },
        },
      });

      await sendPendingReports(admin);

      expect(refundsCreateSpy).not.toHaveBeenCalled();
      const renderedInput = renderSpy.mock.calls[0][0];
      expect(renderedInput.refundOutcome).toBe('issued');
    });

    it("returns 'pending_support' when the payments row is missing", async () => {
      const req = baseRequest({ id: 'qr_nopay', total_quotes_collected: 0 });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_nopay: [] },
        paymentsByRequestId: { qr_nopay: null },
      });

      await sendPendingReports(admin);

      expect(refundsCreateSpy).not.toHaveBeenCalled();
      expect(renderSpy.mock.calls[0][0].refundOutcome).toBe('pending_support');
    });

    it("returns 'pending_support' when payment_intent_id is null", async () => {
      const req = baseRequest({ id: 'qr_nopi', total_quotes_collected: 0 });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_nopi: [] },
        paymentsByRequestId: {
          qr_nopi: {
            id: 'pay_3',
            stripe_payment_intent_id: null,
            status: 'paid',
          },
        },
      });

      await sendPendingReports(admin);

      expect(refundsCreateSpy).not.toHaveBeenCalled();
      expect(renderSpy.mock.calls[0][0].refundOutcome).toBe('pending_support');
    });

    it("returns 'pending_support' when stripe.refunds.create throws", async () => {
      refundsCreateSpy.mockRejectedValue(new Error('Stripe API down'));
      const req = baseRequest({ id: 'qr_stripeerr', total_quotes_collected: 0 });
      const { admin, state } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_stripeerr: [] },
        paymentsByRequestId: {
          qr_stripeerr: {
            id: 'pay_4',
            stripe_payment_intent_id: 'pi_789',
            status: 'paid',
          },
        },
      });

      const result = await sendPendingReports(admin);

      expect(result.sent).toBe(1); // email still goes out
      expect(renderSpy.mock.calls[0][0].refundOutcome).toBe('pending_support');
      // payments.status was NOT flipped — refund actually failed.
      expect(state.paymentUpdates).toHaveLength(0);
    });

    it("returns 'pending_support' when payments lookup errors", async () => {
      const req = baseRequest({ id: 'qr_paylookuperr', total_quotes_collected: 0 });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_paylookuperr: [] },
        paymentsLookupError: { message: 'db conn' },
      });

      await sendPendingReports(admin);

      expect(refundsCreateSpy).not.toHaveBeenCalled();
      expect(renderSpy.mock.calls[0][0].refundOutcome).toBe('pending_support');
    });
  });

  describe('failure modes that leave status=processing for next-run retry', () => {
    it("failed email send: status stays 'processing', no final stamp, counts as failed", async () => {
      sendEmailSpy.mockResolvedValue({
        ok: false,
        simulated: false,
        error: 'SMTP 451',
      });
      const req = baseRequest({ id: 'qr_sendfail' });
      const { admin, state } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_sendfail: [quote()] },
      });

      const result = await sendPendingReports(admin);

      expect(result.failed).toBe(1);
      expect(result.details[0].reason).toMatch(/SMTP 451/);
      // Only the generated_at stamp went through — no completion stamp.
      const completionUpdates = state.quoteRequestUpdates.filter(
        (u) => u.payload.status === 'completed'
      );
      expect(completionUpdates).toHaveLength(0);
    });

    it('stamp-generated failure short-circuits before send', async () => {
      const req = baseRequest({ id: 'qr_stampfail' });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_stampfail: [quote()] },
        quoteRequestUpdateErrorByField: {
          report_generated_at: { message: 'column constraint' },
        },
      });

      const result = await sendPendingReports(admin);

      expect(result.failed).toBe(1);
      expect(result.details[0].reason).toMatch(/stamp generated/);
      // No send attempted after generated-stamp failure.
      expect(sendEmailSpy).not.toHaveBeenCalled();
    });

    it('final-stamp failure AFTER a successful send: failed outcome, loud note (would re-send next run)', async () => {
      const req = baseRequest({ id: 'qr_finalfail' });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_finalfail: [quote()] },
        quoteRequestUpdateErrorByField: {
          report_sent_at: { message: 'RLS denied' },
        },
      });

      const result = await sendPendingReports(admin);

      expect(result.failed).toBe(1);
      expect(result.details[0].reason).toMatch(/final stamp/);
      // Email was sent.
      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    });

    it('quotes load failure is counted as failed with reason', async () => {
      const req = baseRequest({ id: 'qr_qloaderr' });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: {},
        quotesError: { message: 'bad join' },
      });

      const result = await sendPendingReports(admin);

      expect(result.failed).toBe(1);
      expect(result.details[0].reason).toMatch(/quotes load/);
      expect(sendEmailSpy).not.toHaveBeenCalled();
    });
  });

  it('renders coverage summary correctly', async () => {
    const req = baseRequest({
      id: 'qr_cov',
      total_businesses_to_call: 10,
      total_calls_completed: 7,
      total_quotes_collected: 3,
    });
    const { admin } = makeAdmin({
      requests: [req],
      quotesByRequestId: { qr_cov: [quote()] },
    });

    await sendPendingReports(admin);

    const renderedInput = renderSpy.mock.calls[0][0];
    expect(renderedInput.coverageSummary).toBe(
      'We reached 7 of 10 local pros and collected 3 quotes.'
    );
    expect(renderedInput.city).toBe('Austin');
    expect(renderedInput.state).toBe('TX');
    expect(renderedInput.categoryName).toBe('Moving');
  });

  it('builds dashboard URL using NEXT_PUBLIC_APP_URL when set, with fallback', async () => {
    const saved = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    try {
      const req = baseRequest({ id: 'qr_url' });
      const { admin } = makeAdmin({
        requests: [req],
        quotesByRequestId: { qr_url: [quote()] },
      });

      await sendPendingReports(admin);

      const renderedInput = renderSpy.mock.calls[0][0];
      expect(renderedInput.dashboardUrl).toBe(
        'https://staging.evenquote.com/dashboard/requests/qr_url'
      );
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
  });

  it('handles array-shaped category join (supabase-js cardinality variance)', async () => {
    const req = baseRequest({
      id: 'qr_arrcat',
      category: [{ name: 'Cleaning', slug: 'cleaning' }],
    });
    const { admin } = makeAdmin({
      requests: [req],
      quotesByRequestId: { qr_arrcat: [quote()] },
    });

    await sendPendingReports(admin);

    const renderedInput = renderSpy.mock.calls[0][0];
    expect(renderedInput.categoryName).toBe('Cleaning');
  });

  it('processes multiple requests in one run, preserving per-row counters', async () => {
    sendEmailSpy
      .mockResolvedValueOnce({ ok: true, simulated: false, id: 'e1' })
      .mockResolvedValueOnce({ ok: false, simulated: false, error: 'boom' })
      .mockResolvedValueOnce({ ok: true, simulated: false, id: 'e3' });

    const { admin } = makeAdmin({
      requests: [
        baseRequest({ id: 'a' }),
        baseRequest({ id: 'b' }),
        baseRequest({ id: 'c', user_id: null, intake_data: {} }), // skipped
      ],
      quotesByRequestId: {
        a: [quote()],
        b: [quote()],
        c: [quote()],
      },
    });

    const result = await sendPendingReports(admin);

    expect(result.scanned).toBe(3);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
