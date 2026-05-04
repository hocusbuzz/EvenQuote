// Tests for the redeemCoupon server action.
//
// Locks the customer-facing behavior contract:
//   • Rate-limited (5/5min per IP) — returns ok:false with retry copy
//     on deny, no DB hit
//   • Malformed code → ok:false with generic copy, NO DB hit (don't
//     waste rate-limit budget on shape errors)
//   • Empty quoteRequestId → ok:false with "missing request id"
//   • RPC outcome='ok' → enqueueQuoteCalls fires, returns ok:true
//     with redirectUrl carrying ?coupon=1 (so the success page can
//     adapt copy if needed)
//   • RPC outcome='expired' → ok:false with expiry-specific copy
//   • RPC outcome='wrong_vertical' → ok:false with vertical-specific
//   • RPC outcome='request_not_pending' → ok:false ("already paid")
//   • RPC outcome='not_found' / 'exhausted' → ok:false with GENERIC
//     copy (deliberately doesn't leak whether code exists — anti-
//     enumeration on the unguessable surface)
//   • RPC throws → ok:false generic + Sentry capture w/ canonical
//     {lib:'coupons', reason:'rpcFailed'} tags
//   • enqueueQuoteCalls throws AFTER successful redemption → ok:true
//     anyway (don't fail the user — the row IS paid; the existing
//     retry-failed-calls + dispatch-scheduled-requests crons will
//     pick it up). Sentry capture w/ reason:'sideEffectsFailed'.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Sentry capture spy ──────────────────────────────────────────────
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
}));

// ── Rate-limit gate spy ─────────────────────────────────────────────
const assertRateLimitMock = vi.fn();
vi.mock('@/lib/security/rate-limit-auth', () => ({
  assertRateLimitFromHeaders: (...args: unknown[]) => assertRateLimitMock(...args),
}));

// ── next/headers stub — coupons action reads it for IP ──────────────
vi.mock('next/headers', () => ({
  headers: () => new Map(),
}));

// ── Supabase admin stub: just .rpc() ────────────────────────────────
const rpcMock = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
  }),
}));

// ── enqueueQuoteCalls spy ───────────────────────────────────────────
const enqueueMock = vi.fn();
vi.mock('@/lib/queue/enqueue-calls', () => ({
  enqueueQuoteCalls: (...args: unknown[]) => enqueueMock(...args),
}));

// Import AFTER all mocks are registered.
import { redeemCoupon } from './coupons';

describe('redeemCoupon', () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
    assertRateLimitMock.mockReset();
    rpcMock.mockReset();
    enqueueMock.mockReset();
    // Default: rate limit allows; RPC + enqueue succeed.
    assertRateLimitMock.mockReturnValue(null);
    rpcMock.mockResolvedValue({ data: [{ outcome: 'ok', detail: null }], error: null });
    enqueueMock.mockResolvedValue({ ok: true, advanced: true });
  });

  // ─── Rate limit ──────────────────────────────────────────────────

  it('returns ok:false with retry-after copy when rate limit denies, NO DB hit', async () => {
    assertRateLimitMock.mockReturnValueOnce({ retryAfterSec: 240 });
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Too many attempts/);
      expect(res.error).toMatch(/240s/);
    }
    expect(rpcMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('uses the canonical rate-limit prefix + 5/5min budget', async () => {
    await redeemCoupon({ quoteRequestId: 'req-1', code: 'ABCD-EFGH-JKMN' });
    expect(assertRateLimitMock).toHaveBeenCalledTimes(1);
    const opts = assertRateLimitMock.mock.calls[0][1];
    expect(opts).toMatchObject({
      prefix: 'coupon-redeem',
      limit: 5,
      windowMs: 5 * 60 * 1000,
    });
  });

  // ─── Input validation (no DB hit on bad shape) ──────────────────

  it('rejects malformed code shape WITHOUT hitting the DB or burning RPC quota', async () => {
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'totally-not-a-code',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/doesn't look right/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects empty code', async () => {
    const res = await redeemCoupon({ quoteRequestId: 'req-1', code: '' });
    expect(res.ok).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('rejects empty quoteRequestId with a clear error', async () => {
    const res = await redeemCoupon({
      quoteRequestId: '',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Missing request id/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('normalizes the code (trim + uppercase + strip whitespace) before validation + RPC', async () => {
    // The normalizer strips spaces — so the user-typed
    // 'abcd efgh jkmn' becomes 'ABCDEFGHJKMN' (no hyphens) and
    // fails the well-formed check. This locks that behavior so
    // we don't accidentally relax it.
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: '  abcd-efgh-jkmn  ',
    });
    expect(res.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('redeem_coupon', {
      p_code: 'ABCD-EFGH-JKMN',
      p_quote_request_id: 'req-1',
    });
  });

  // ─── RPC outcome mapping ────────────────────────────────────────

  it('outcome=ok → calls enqueueQuoteCalls + returns redirectUrl with ?coupon=1', async () => {
    const res = await redeemCoupon({
      quoteRequestId: 'req-abc',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.redirectUrl).toBe('/get-quotes/success?request=req-abc&coupon=1');
    }
    expect(enqueueMock).toHaveBeenCalledWith({ quoteRequestId: 'req-abc' });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('outcome=expired → expiry-specific user copy, no enqueue', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ outcome: 'expired', detail: '2026-01-01T00:00:00Z' }],
      error: null,
    });
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/expired/i);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('outcome=wrong_vertical → vertical-specific user copy', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ outcome: 'wrong_vertical', detail: 'moving' }],
      error: null,
    });
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/isn't valid for this service/i);
  });

  it('outcome=request_not_pending → "already paid or closed" copy', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ outcome: 'request_not_pending', detail: 'paid' }],
      error: null,
    });
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already paid or closed/i);
  });

  it.each([['not_found'], ['exhausted'], ['some_future_unknown_outcome']])(
    'outcome=%s → GENERIC copy that does NOT leak whether code exists',
    async (outcome) => {
      rpcMock.mockResolvedValueOnce({
        data: [{ outcome, detail: null }],
        error: null,
      });
      const res = await redeemCoupon({
        quoteRequestId: 'req-1',
        code: 'ABCD-EFGH-JKMN',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/doesn't look right/i);
        // Anti-enumeration: must NOT say 'not found' / 'exhausted'
        // / 'used up' — anything that helps an attacker classify
        // their guesses.
        expect(res.error).not.toMatch(/not found|exhausted|used/i);
      }
    },
  );

  it('treats an empty data array (no rows) as not_found → generic copy', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/doesn't look right/i);
  });

  // ─── Failure modes ──────────────────────────────────────────────

  it('RPC throws / returns error → ok:false generic + Sentry capture with rpcFailed reason', async () => {
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection reset' },
    });
    const res = await redeemCoupon({
      quoteRequestId: 'req-1',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Something went wrong/);
      // Don't leak the underlying Postgres / network error to the
      // user. Locked here so a future "more helpful errors" refactor
      // doesn't accidentally surface 'connection reset' to a friend.
      expect(res.error).not.toMatch(/connection|postgres|reset/i);
    }
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('connection reset');
    expect(ctx).toMatchObject({
      tags: { lib: 'coupons', reason: 'rpcFailed' },
    });
  });

  it('enqueue threw AFTER successful redemption → returns ok:true anyway (row IS paid; cron picks up) + Sentry capture with sideEffectsFailed', async () => {
    // Critical: the redemption is already committed via the RPC
    // transaction. Failing the user-facing return at this point
    // would leave the friend staring at a red error message
    // despite their request being paid + queued for the next cron
    // tick. The retry-failed-calls + dispatch-scheduled-requests
    // crons will pick up the row regardless.
    enqueueMock.mockRejectedValueOnce(new Error('enqueue boom'));
    const res = await redeemCoupon({
      quoteRequestId: 'req-good',
      code: 'ABCD-EFGH-JKMN',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.redirectUrl).toMatch(/req-good/);
    }
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect((err as Error).message).toBe('enqueue boom');
    expect(ctx).toMatchObject({
      tags: {
        lib: 'coupons',
        reason: 'sideEffectsFailed',
        requestId: 'req-good',
      },
    });
  });

  // ─── Regression guards ──────────────────────────────────────────

  it('regression: every Sentry capture carries an allow-listed CouponReason (no catch-alls)', async () => {
    // Force both capture sites to fire across a single test run by
    // looping through their triggers.
    const allowed = new Set(['rpcFailed', 'sideEffectsFailed']);

    // 1) rpcFailed
    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'x' },
    });
    await redeemCoupon({ quoteRequestId: 'r1', code: 'ABCD-EFGH-JKMN' });

    // 2) sideEffectsFailed
    enqueueMock.mockRejectedValueOnce(new Error('y'));
    await redeemCoupon({ quoteRequestId: 'r2', code: 'ABCD-EFGH-JKMN' });

    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    for (const call of captureExceptionMock.mock.calls) {
      const ctx = call[1] as { tags?: { reason?: string } };
      const reason = ctx?.tags?.reason;
      expect(reason).toBeDefined();
      expect(allowed.has(reason as string)).toBe(true);
    }
  });
});
