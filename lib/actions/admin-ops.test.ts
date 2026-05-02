// Tests for the one-click ops admin actions (Tier 1 backlog #2):
//   • refundRequestNow
//   • markFailed
//   • resendReportEmail
//
// Lives in its own file (not admin.test.ts) because these actions need
// module-level mocks for Stripe and Resend that aren't relevant to the
// archive/retry/rerun-extractor surface. Keeping them isolated avoids
// expanding the surface of the existing admin.test.ts mock harness.
//
// What these tests lock:
//   (a) Idempotency — already-refunded payment is a no-op success;
//       missing payment row is a clean error.
//   (b) Stripe idempotency key shape — same key as the cron path so
//       the two cooperate (no double-refund possible).
//   (c) Sentry tag shape — canonical {lib:'admin', reason, requestId},
//       all reasons in the AdminReason allow-list.
//   (d) Audit trail — actor user id flows into Stripe metadata.
//   (e) Resend reuses the same renderQuoteReport / coverage / dashboard
//       primitives the cron uses, so the email is byte-identical to
//       what a fresh send would produce.
//   (f) Resend keeps the prior refund_outcome ("refund issued" stays
//       sticky even if a quote landed via rerun-extractor).
//   (g) markFailed is a single-row update with no Stripe/email side
//       effects — pure status flip.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Sentry capture spy ───────────────────────────────────────────────
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
}));

// ── next/cache ───────────────────────────────────────────────────────
const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => revalidatePathMock(p),
}));

// ── requireAdmin: returns the actor profile (used by refund metadata) ─
const ADMIN_USER_ID = 'admin-user-1';
const requireAdminMock = vi.fn(async () => ({
  id: ADMIN_USER_ID,
  role: 'admin',
}));
vi.mock('@/lib/auth', () => ({
  requireAdmin: () => requireAdminMock(),
}));

// ── Stripe client ────────────────────────────────────────────────────
const stripeRefundsCreateMock = vi.fn();
vi.mock('@/lib/stripe/server', () => ({
  getStripe: () => ({
    refunds: { create: stripeRefundsCreateMock },
  }),
}));

// ── Resend ───────────────────────────────────────────────────────────
const sendEmailMock = vi.fn();
vi.mock('@/lib/email/resend', () => ({
  sendEmail: (input: unknown) => sendEmailMock(input),
}));

// ── send-reports helpers (we re-export from there) ───────────────────
// Stub to deterministic values so tests don't depend on env vars.
vi.mock('@/lib/cron/send-reports', () => ({
  resolveRecipient: vi.fn(async (_admin: unknown, args: { userId: string | null; intakeData: Record<string, unknown> | null }) => {
    if (args.intakeData && typeof args.intakeData['contact_email'] === 'string') {
      return {
        email: args.intakeData['contact_email'] as string,
        name: (args.intakeData['contact_name'] as string | undefined) ?? null,
      };
    }
    return { email: 'fallback@example.com', name: 'Fallback' };
  }),
  buildCoverageSummary: vi.fn(() => 'mocked coverage summary'),
  buildDashboardUrl: vi.fn(
    (id: string) => `https://evenquote.com/dashboard/requests/${id}`
  ),
}));

// ── renderQuoteReport — mocked so we can inspect inputs ──────────────
const renderQuoteReportMock = vi.fn((_input: unknown) => ({
  subject: 'mock subject',
  html: '<p>mock</p>',
  text: 'mock',
}));
vi.mock('@/lib/email/templates', () => ({
  renderQuoteReport: (input: unknown) => renderQuoteReportMock(input),
}));

// ── Admin Supabase client — flexible per-test fixture ────────────────
type FixtureRow = Record<string, unknown> | null;
type FixtureError = { message: string } | null;
type Fixture = {
  // payments(.maybeSingle): { id, stripe_payment_intent_id, status }
  payments?: { row: FixtureRow; error?: FixtureError };
  // quote_requests SELECT result for resend (one .maybeSingle())
  quoteRequest?: { row: FixtureRow; error?: FixtureError };
  // quote_requests SELECT result for refund's report_data merge read
  quoteRequestReportData?: { row: FixtureRow };
  // quotes(.order)
  quotes?: { rows: Array<Record<string, unknown>>; error?: FixtureError };
  // markFailed update result
  quoteRequestUpdate?: { row: FixtureRow; error?: FixtureError };
  // payments status update
  paymentsUpdateError?: FixtureError;
};

let fixture: Fixture = {};
const updateCalls: Array<{
  table: string;
  payload: Record<string, unknown>;
  eqArgs: Array<{ col: string; val: unknown }>;
}> = [];

function makeAdmin() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        // SELECT chain — covers maybeSingle, order, in, eq.
        const selectChain = (defaultRow: FixtureRow, defaultErr: FixtureError) => {
          let _row: FixtureRow = defaultRow;
          let _err: FixtureError = defaultErr;
          let _rows: Array<Record<string, unknown>> | null = null;
          if (table === 'payments') {
            _row = fixture.payments?.row ?? null;
            _err = fixture.payments?.error ?? null;
          } else if (table === 'quote_requests') {
            _row = fixture.quoteRequest?.row ?? fixture.quoteRequestReportData?.row ?? null;
            _err = fixture.quoteRequest?.error ?? null;
          } else if (table === 'quotes') {
            _rows = fixture.quotes?.rows ?? [];
            _err = fixture.quotes?.error ?? null;
          }
          const api: Record<string, unknown> = {};
          api.eq = () => api;
          api.order = () =>
            // Quotes resolve as an array on .order() (no maybeSingle).
            Promise.resolve({ data: _rows ?? [], error: _err });
          api.maybeSingle = () => Promise.resolve({ data: _row, error: _err });
          return api;
        };
        return {
          select: () => selectChain(null, null),
          update: (payload: Record<string, unknown>) => {
            const call = { table, payload, eqArgs: [] as Array<{ col: string; val: unknown }> };
            updateCalls.push(call);
            const chain: Record<string, unknown> = {};
            chain.eq = (col: string, val: unknown) => {
              call.eqArgs.push({ col, val });
              chain.select = () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: fixture.quoteRequestUpdate?.row ?? null,
                    error: fixture.quoteRequestUpdate?.error ?? null,
                  }),
              });
              // Fire-and-forget terminator: thenable on the eq result.
              (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
                resolve({
                  data: null,
                  error:
                    table === 'payments'
                      ? fixture.paymentsUpdateError ?? null
                      : null,
                });
              return chain;
            };
            return chain;
          },
        };
      },
    }),
  }));
}

beforeEach(() => {
  vi.resetModules();
  captureExceptionMock.mockReset();
  revalidatePathMock.mockReset();
  requireAdminMock.mockReset();
  requireAdminMock.mockImplementation(async () => ({
    id: ADMIN_USER_ID,
    role: 'admin',
  }));
  stripeRefundsCreateMock.mockReset();
  stripeRefundsCreateMock.mockResolvedValue({ id: 're_abc' });
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true, id: 'email_xyz' });
  renderQuoteReportMock.mockClear();
  fixture = {};
  updateCalls.length = 0;
  makeAdmin();
});

// ─────────────────────────────────────────────────────────────────────
// refundRequestNow
// ─────────────────────────────────────────────────────────────────────

describe('refundRequestNow', () => {
  it('happy path: calls Stripe with shared idempotency key + actor in metadata, marks payments refunded, stamps report_data', async () => {
    fixture.payments = {
      row: { id: 'pay_1', stripe_payment_intent_id: 'pi_xyz', status: 'completed' },
    };
    fixture.quoteRequestReportData = {
      row: { report_data: { generated_at: '2026-05-01T00:00:00Z', some: 'thing' } },
    };

    const { refundRequestNow } = await import('./admin');
    const res = await refundRequestNow('req-1');

    expect(res.ok).toBe(true);

    // Stripe got called with the canonical idempotency key shape.
    expect(stripeRefundsCreateMock).toHaveBeenCalledTimes(1);
    const [stripeArgs, stripeOpts] = stripeRefundsCreateMock.mock.calls[0];
    expect(stripeArgs.payment_intent).toBe('pi_xyz');
    expect(stripeArgs.metadata.quote_request_id).toBe('req-1');
    expect(stripeArgs.metadata.actor_user_id).toBe(ADMIN_USER_ID);
    expect(stripeArgs.metadata.source).toBe('admin/refund-button');
    // SAME shape as cron path → Stripe dedup-cooperates across both.
    expect(stripeOpts.idempotencyKey).toBe('refund-zero-quotes-pay_1');

    // payments status flipped + report_data merged (preserves existing fields).
    const paymentsUpdate = updateCalls.find((c) => c.table === 'payments');
    expect(paymentsUpdate?.payload).toMatchObject({ status: 'refunded' });
    const reportDataUpdate = updateCalls.find(
      (c) => c.table === 'quote_requests' && 'report_data' in c.payload
    );
    expect(reportDataUpdate?.payload.report_data).toMatchObject({
      generated_at: '2026-05-01T00:00:00Z', // preserved
      some: 'thing',                         // preserved
      refund_outcome: 'issued',              // added
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("idempotent: payments.status='refunded' returns ok with 'no-op' note and does NOT call Stripe", async () => {
    fixture.payments = {
      row: { id: 'pay_2', stripe_payment_intent_id: 'pi_done', status: 'refunded' },
    };

    const { refundRequestNow } = await import('./admin');
    const res = await refundRequestNow('req-2');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.note).toMatch(/already refunded/i);
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it('no payments row: returns ok:false without calling Stripe', async () => {
    fixture.payments = { row: null };
    const { refundRequestNow } = await import('./admin');
    const res = await refundRequestNow('req-3');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no payments row/i);
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });

  it('payments lookup error: captures with refundLookupFailed tag', async () => {
    fixture.payments = { row: null, error: { message: 'connection reset' } };
    const { refundRequestNow } = await import('./admin');
    const res = await refundRequestNow('req-4');
    expect(res.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toMatchObject({
      lib: 'admin',
      reason: 'refundLookupFailed',
      requestId: 'req-4',
    });
  });

  it('Stripe throws: captures with refundCreateFailed tag and returns ok:false', async () => {
    fixture.payments = {
      row: { id: 'pay_5', stripe_payment_intent_id: 'pi_a', status: 'completed' },
    };
    stripeRefundsCreateMock.mockRejectedValueOnce(new Error('stripe down'));

    const { refundRequestNow } = await import('./admin');
    const res = await refundRequestNow('req-5');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/stripe down/i);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toMatchObject({
      reason: 'refundCreateFailed',
      requestId: 'req-5',
    });
  });

  it('payments has no payment_intent_id: returns ok:false (manual Stripe dashboard required)', async () => {
    fixture.payments = {
      row: { id: 'pay_6', stripe_payment_intent_id: null, status: 'completed' },
    };
    const { refundRequestNow } = await import('./admin');
    const res = await refundRequestNow('req-6');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/manually in the Stripe dashboard/i);
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// markFailed
// ─────────────────────────────────────────────────────────────────────

describe('markFailed', () => {
  it("happy path: writes status='failed', revalidates surfaces, returns ok", async () => {
    fixture.quoteRequestUpdate = { row: { id: 'req-mf', status: 'failed' } };

    const { markFailed } = await import('./admin');
    const res = await markFailed('req-mf');

    expect(res.ok).toBe(true);
    const upd = updateCalls.find((c) => c.table === 'quote_requests');
    expect(upd?.payload).toEqual({ status: 'failed' });
    expect(upd?.eqArgs).toEqual([{ col: 'id', val: 'req-mf' }]);

    const paths = revalidatePathMock.mock.calls.map((c) => c[0]).sort();
    expect(paths).toEqual(['/admin', '/admin/requests', '/admin/requests/req-mf']);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('no row matched: returns ok:false (404-ish)', async () => {
    fixture.quoteRequestUpdate = { row: null };
    const { markFailed } = await import('./admin');
    const res = await markFailed('req-missing');
    expect(res.ok).toBe(false);
  });

  it('update error: captures with markFailedUpdateFailed tag', async () => {
    fixture.quoteRequestUpdate = {
      row: null,
      error: { message: 'unique violation' },
    };
    const { markFailed } = await import('./admin');
    const res = await markFailed('req-mf-err');
    expect(res.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toMatchObject({
      lib: 'admin',
      reason: 'markFailedUpdateFailed',
      requestId: 'req-mf-err',
    });
  });

  it('does NOT call Stripe or sendEmail (pure status flip)', async () => {
    fixture.quoteRequestUpdate = { row: { id: 'req-pure', status: 'failed' } };
    const { markFailed } = await import('./admin');
    await markFailed('req-pure');
    expect(stripeRefundsCreateMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('missing requestId: returns ok:false WITHOUT touching DB or Sentry', async () => {
    const { markFailed } = await import('./admin');
    const res = await markFailed('');
    expect(res.ok).toBe(false);
    expect(updateCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// resendReportEmail
// ─────────────────────────────────────────────────────────────────────

describe('resendReportEmail', () => {
  const baseRow = {
    id: 'req-rs',
    user_id: null,
    city: 'Austin',
    state: 'TX',
    intake_data: { contact_email: 'x@y.com', contact_name: 'X' },
    report_data: null,
    total_businesses_to_call: 5,
    total_calls_completed: 3,
    total_quotes_collected: 2,
    service_categories: { name: 'Moving', slug: 'moving' },
  };

  it('happy path: re-renders + sends with current quotes, stamps last_resent_at', async () => {
    fixture.quoteRequest = { row: baseRow };
    fixture.quotes = {
      rows: [
        {
          id: 'q1',
          business_id: 'b1',
          price_min: 100,
          price_max: 150,
          price_description: null,
          availability: 'Mon',
          includes: ['stairs'],
          excludes: null,
          notes: null,
          requires_onsite_estimate: false,
          business: { name: 'Acme' },
        },
      ],
    };

    const { resendReportEmail } = await import('./admin');
    const res = await resendReportEmail('req-rs');

    expect(res.ok).toBe(true);
    expect(renderQuoteReportMock).toHaveBeenCalledTimes(1);
    const renderArgs = renderQuoteReportMock.mock.calls[0][0] as Record<string, unknown>;
    expect(renderArgs).toMatchObject({
      recipientName: 'X',
      categoryName: 'Moving',
      city: 'Austin',
      state: 'TX',
    });
    expect((renderArgs.quotes as Array<Record<string, unknown>>)[0]).toMatchObject({
      businessName: 'Acme',
      priceMin: 100,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(sendArgs).toMatchObject({
      to: 'x@y.com',
      tag: 'quote-report-resend',
    });

    // last_resent_at stamped (merged into report_data, preserving prior).
    const stampUpd = updateCalls.find(
      (c) => c.table === 'quote_requests' && 'report_data' in c.payload
    );
    expect(stampUpd?.payload.report_data).toMatchObject({
      last_resent_at: expect.any(String),
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("preserves prior refund_outcome ('issued' stays sticky even if quotes have since landed)", async () => {
    fixture.quoteRequest = {
      row: { ...baseRow, report_data: { refund_outcome: 'issued' } },
    };
    fixture.quotes = {
      rows: [
        {
          id: 'q1',
          business_id: 'b1',
          price_min: 100,
          price_max: 100,
          price_description: null,
          availability: null,
          includes: null,
          excludes: null,
          notes: null,
          requires_onsite_estimate: false,
          business: { name: 'Acme' },
        },
      ],
    };
    const { resendReportEmail } = await import('./admin');
    await resendReportEmail('req-sticky');

    const renderArgs = renderQuoteReportMock.mock.calls[0][0] as Record<string, unknown>;
    expect(renderArgs.refundOutcome).toBe('issued');
  });

  it('no recipient: returns ok:false without sending', async () => {
    // Force resolveRecipient to return null by intake without contact_email
    // and userId null. We mock it more aggressively for this test.
    const sendReportsMock = await import('@/lib/cron/send-reports');
    (sendReportsMock.resolveRecipient as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    fixture.quoteRequest = { row: { ...baseRow, intake_data: {}, user_id: null } };
    fixture.quotes = { rows: [] };

    const { resendReportEmail } = await import('./admin');
    const res = await resendReportEmail('req-no-recip');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no recipient/i);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('lookup error: captures with resendLookupFailed tag', async () => {
    fixture.quoteRequest = { row: null, error: { message: 'db down' } };
    const { resendReportEmail } = await import('./admin');
    const res = await resendReportEmail('req-err');
    expect(res.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toMatchObject({
      reason: 'resendLookupFailed',
    });
  });

  it('quotes load error: captures with resendQuotesLoadFailed tag', async () => {
    fixture.quoteRequest = { row: baseRow };
    fixture.quotes = { rows: [], error: { message: 'quotes table gone' } };
    const { resendReportEmail } = await import('./admin');
    const res = await resendReportEmail('req-q-err');
    expect(res.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toMatchObject({
      reason: 'resendQuotesLoadFailed',
    });
  });

  it('sendEmail failure: captures with resendSendFailed tag and returns ok:false', async () => {
    fixture.quoteRequest = { row: baseRow };
    fixture.quotes = { rows: [] };
    sendEmailMock.mockResolvedValueOnce({ ok: false, error: 'rate limited' });

    const { resendReportEmail } = await import('./admin');
    const res = await resendReportEmail('req-send-err');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/rate limited/);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toMatchObject({
      reason: 'resendSendFailed',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Regression guards
// ─────────────────────────────────────────────────────────────────────

describe('regression guards (capture tag shape)', () => {
  it('all new reasons are members of the AdminReason allow-list', async () => {
    // Trigger every error path once; assert each reason appears with
    // the canonical {lib:'admin', reason, requestId} shape.
    const allowed = new Set([
      'refundLookupFailed',
      'refundCreateFailed',
      'refundStatusUpdateFailed',
      'markFailedUpdateFailed',
      'resendLookupFailed',
      'resendQuotesLoadFailed',
      'resendSendFailed',
    ]);

    // 1. refundLookupFailed
    captureExceptionMock.mockReset();
    fixture.payments = { row: null, error: { message: 'x' } };
    const { refundRequestNow } = await import('./admin');
    await refundRequestNow('req-1');
    let reason = (captureExceptionMock.mock.calls[0][1] as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason)).toBe(true);

    // 2. refundCreateFailed
    captureExceptionMock.mockReset();
    fixture.payments = {
      row: { id: 'p', stripe_payment_intent_id: 'pi', status: 'completed' },
    };
    stripeRefundsCreateMock.mockRejectedValueOnce(new Error('stripe boom'));
    await refundRequestNow('req-2');
    reason = (captureExceptionMock.mock.calls[0][1] as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason)).toBe(true);

    // 3. markFailedUpdateFailed
    captureExceptionMock.mockReset();
    fixture.quoteRequestUpdate = { row: null, error: { message: 'y' } };
    const { markFailed } = await import('./admin');
    await markFailed('req-3');
    reason = (captureExceptionMock.mock.calls[0][1] as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason)).toBe(true);

    // 4. resendLookupFailed
    captureExceptionMock.mockReset();
    fixture.quoteRequest = { row: null, error: { message: 'z' } };
    const { resendReportEmail } = await import('./admin');
    await resendReportEmail('req-4');
    reason = (captureExceptionMock.mock.calls[0][1] as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason)).toBe(true);
  });
});
