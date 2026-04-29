// Tests for the Vapi client (startOutboundCall + verifyVapiWebhook).
//
// Why the coverage is split:
//   • startOutboundCall has four meaningful modes: simulation (any env
//     missing), live call, live call with TEST_OVERRIDE_PHONE redirect,
//     and error handling on HTTP failure. Each is worth its own case.
//   • verifyVapiWebhook has to HARD-REFUSE in production when the secret
//     is unset, and must accept all three presentation styles
//     (x-vapi-secret, X-Vapi-Secret, Authorization: Bearer). That's
//     security-critical: a missing secret would otherwise turn the
//     webhook into an unauthenticated write against the admin client.
//
// Global fetch is mocked via vi.stubGlobal for the live-call cases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the admin client so vapi.ts's selector path never tries to open
// a real Supabase connection during these tests. The default rpc mock
// returns an empty pool, so the selector falls back to the env var —
// which is what the existing tests already assume.
const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ rpc: rpcMock })),
}));

// Round 20: lib-boundary observability. Mock the sentry boundary so we
// can assert captureException was called with the canonical tag shape
// on each failure mode without the stub's log.error firing.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

import { startOutboundCall, verifyVapiWebhook } from './vapi';

// TS 5 + @types/node 20+ type NODE_ENV as a readonly literal union, so
// direct and bracket-with-literal assignment both fail `tsc --noEmit`.
// Route all env writes through this writable view. Runtime identity is
// unchanged; we only broaden the static type.
const env = process.env as Record<string, string | undefined>;

// Utility — we flip env vars a lot. Keep a clean slate between tests.
// Plain string[] (not `as const`) so indexing process.env with these keys
// doesn't narrow to NODE_ENV's readonly literal type under strict TS 5.
// Supabase env keys are included so the selector doesn't reach the
// mocked RPC unless a test explicitly opts in by setting them.
const ENV_KEYS: string[] = [
  'VAPI_API_KEY',
  'VAPI_PHONE_NUMBER_ID',
  'VAPI_ASSISTANT_ID',
  'VAPI_WEBHOOK_SECRET',
  'TEST_OVERRIDE_PHONE',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NODE_ENV',
];

describe('startOutboundCall', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: [], error: null });
    captureExceptionMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // Scrub by default.
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  const input = {
    toPhone: '+14155551234',
    businessName: 'Pat\u2019s Moving',
    variableValues: { contact_name: 'Alex' },
    metadata: { business_id: 'biz_1' },
  };

  it('simulation mode when VAPI_API_KEY is unset', async () => {
    const result = await startOutboundCall(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.simulated).toBe(true);
    if (result.simulated) {
      expect(result.vapiCallId).toMatch(/^sim_/);
      expect(result.reason).toMatch(/VAPI_/);
    }
  });

  it('simulation mode when assistant ID is missing even if API key is set', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    // VAPI_ASSISTANT_ID deliberately unset.
    const result = await startOutboundCall(input);
    expect(result.ok).toBe(true);
    if (result.ok && result.simulated) {
      expect(result.vapiCallId).toMatch(/^sim_/);
    }
  });

  it('real call path: fetches Vapi with Authorization header and returns id', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi_call_xyz' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await startOutboundCall(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.simulated).toBe(false);
      if (!result.simulated) {
        expect(result.vapiCallId).toBe('vapi_call_xyz');
      }
    }

    // Assert request shape.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.vapi.ai/call');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer vapi_test_key');
    const body = JSON.parse(init.body);
    expect(body.phoneNumberId).toBe('phone_1');
    expect(body.assistantId).toBe('assistant_1');
    expect(body.customer.number).toBe('+14155551234');
    expect(body.assistantOverrides.variableValues.business_name).toBe(
      'Pat\u2019s Moving'
    );
    expect(body.metadata.business_id).toBe('biz_1');
  });

  it('truncates overlong business names to 40 chars', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi_call_x' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const longName = 'Two Men and a Truck\u00ae - North County San Diego'; // 47 chars
    await startOutboundCall({ ...input, businessName: longName });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.customer.name.length).toBeLessThanOrEqual(40);
    // The full, untruncated name should still be in variableValues for
    // the assistant prompt to use in conversation.
    expect(body.assistantOverrides.variableValues.business_name).toBe(longName);
  });

  it('uses the pool-selected phoneNumberId when the RPC returns a row', async () => {
    // This is the new hot path: Supabase env set, pool has a matching
    // number for the destination area code. The body should carry the
    // pool's phoneNumberId, not the env var's.
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback'; // should NOT be used
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_key';

    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'phone_pool_415',
          twilio_e164: '+14155550100',
          area_code: '415',
          tier: 'area_code',
        },
      ],
      error: null,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi_call_abc' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await startOutboundCall(input);
    expect(result.ok).toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.phoneNumberId).toBe('phone_pool_415');
    // Env var was present but the pool won; confirms selector precedence.
    expect(body.phoneNumberId).not.toBe('phone_env_fallback');
  });

  it('TEST_OVERRIDE_PHONE redirects the dial number, keeps metadata', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';
    process.env.TEST_OVERRIDE_PHONE = '+15556667777';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi_call_x' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await startOutboundCall(input);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.customer.number).toBe('+15556667777');
    // Metadata is untouched — webhook still routes by business_id.
    expect(body.metadata.business_id).toBe('biz_1');
  });

  it('returns ok:false with error when Vapi returns non-2xx', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
      )
    );

    const result = await startOutboundCall(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/403/);
    }
  });

  it('returns ok:false when Vapi response body is missing id', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ not_an_id: true }), { status: 200 })
      )
    );

    const result = await startOutboundCall(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing call id/);
  });

  it('returns ok:false on fetch throw (network error)', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    );

    const result = await startOutboundCall(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ECONNRESET/);
  });

  // ── Round 20 observability contract ──
  //
  // startOutboundCall silently swallowed failures before this round —
  // non-2xx, malformed response, and network throws all returned
  // { ok: false } without reaching the error tracker. The engine
  // records per-business failure so the batch doesn't abort, but a
  // failed outbound call is a trust-destroying silent miss. Capturing
  // at the lib boundary means every caller (engine, cron, future
  // support retry) inherits first-class alerting.

  it('captures Vapi non-2xx with reason=startCallHttpFailed + httpStatus', async () => {
    // Round 24: `reason` is now per-failure-mode so Sentry alerts can
    // fire per-mode without parsing error messages. httpStatus lets the
    // dashboard split 4xx (our config/auth) from 5xx (Vapi outage).
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
      )
    );

    await startOutboundCall(input);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/403/);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'vapi',
        reason: 'startCallHttpFailed',
        businessId: 'biz_1',
        httpStatus: '403',
      },
    });
  });

  it('captures missing-id response with reason=startCallMissingId', async () => {
    // Contract violation — Vapi returned 2xx with no call id. Page on
    // first occurrence (distinct from HttpFailed).
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ not_an_id: true }), { status: 200 })
      )
    );

    await startOutboundCall(input);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/missing call id/);
    expect(ctx).toMatchObject({
      tags: { lib: 'vapi', reason: 'startCallMissingId', businessId: 'biz_1' },
    });
    // No httpStatus on this branch — we got a 2xx so status isn't the signal.
    const tags = (ctx as { tags: Record<string, string> }).tags;
    expect(tags.httpStatus).toBeUndefined();
  });

  it('captures transport-level throws with reason=startCallTransportFailed', async () => {
    // DNS / TLS / socket / timeout before Vapi responded. Distinct from
    // HttpFailed (which requires a response) and MissingId (2xx + bad body).
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    await startOutboundCall(input);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('ECONNRESET');
    expect(ctx).toMatchObject({
      tags: {
        lib: 'vapi',
        reason: 'startCallTransportFailed',
        businessId: 'biz_1',
      },
    });
    const tags = (ctx as { tags: Record<string, string> }).tags;
    expect(tags.httpStatus).toBeUndefined();
  });

  it('reason values are the three discrete modes — never the Round-20 "startCall" catch-all', async () => {
    // Regression guard: if a future refactor reintroduces a single
    // `reason: 'startCall'` for all three modes, ops loses per-mode
    // alerting. This test asserts none of the three failure modes
    // emits the old catch-all reason.
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    // Mode 1: non-2xx
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x', { status: 500 }))
    );
    await startOutboundCall(input);
    // Mode 2: 2xx missing id
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), { status: 200 })
      )
    );
    await startOutboundCall(input);
    // Mode 3: transport throw
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('x')));
    await startOutboundCall(input);

    expect(captureExceptionMock).toHaveBeenCalledTimes(3);
    const reasons = captureExceptionMock.mock.calls.map(
      (c) => (c[1] as { tags: Record<string, string> }).tags.reason
    );
    expect(reasons).toEqual([
      'startCallHttpFailed',
      'startCallMissingId',
      'startCallTransportFailed',
    ]);
    expect(reasons).not.toContain('startCall');
  });

  it('does NOT include the destination phone as a tag value (privacy)', async () => {
    // The toPhone is PII when paired with name/location. Logger
    // redaction does not reach Sentry tags — if someone adds
    // `{ toPhone: input.toPhone }` to captureTags, this test catches
    // it before the tracker indexes a real phone number.
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    await startOutboundCall({ ...input, toPhone: '+14155559999' });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('+14155559999');
    expect(serialized).not.toContain('4155559999');
  });

  it('omits businessId from tags when metadata does not carry one', async () => {
    // Some call paths (future reconciliation retry, manual dispatch)
    // may not have metadata.business_id wired yet. Tag set must still
    // be well-formed — never an empty or "undefined" literal.
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    await startOutboundCall({ ...input, metadata: {} });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toEqual({
      lib: 'vapi',
      reason: 'startCallTransportFailed',
    });
  });

  it('happy path does not capture anything', async () => {
    process.env.VAPI_API_KEY = 'vapi_test_key';
    process.env.VAPI_PHONE_NUMBER_ID = 'phone_1';
    process.env.VAPI_ASSISTANT_ID = 'assistant_1';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'vapi_ok' }), { status: 200 })
      )
    );

    const result = await startOutboundCall(input);
    expect(result.ok).toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('simulation mode does not capture (no real dispatch, no failure)', async () => {
    // VAPI_API_KEY unset → simulation. Must not fire a false-positive
    // sendFailed/startCall event to the tracker.
    await startOutboundCall(input);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe('verifyVapiWebhook', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.VAPI_WEBHOOK_SECRET = env.VAPI_WEBHOOK_SECRET;
    saved.NODE_ENV = env.NODE_ENV;
    delete env.VAPI_WEBHOOK_SECRET;
    delete env.NODE_ENV;
  });

  afterEach(() => {
    if (saved.VAPI_WEBHOOK_SECRET === undefined) delete env.VAPI_WEBHOOK_SECRET;
    else env.VAPI_WEBHOOK_SECRET = saved.VAPI_WEBHOOK_SECRET;
    if (saved.NODE_ENV === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved.NODE_ENV;
  });

  function makeReq(headers: Record<string, string> = {}): Request {
    return new Request('https://example.com/webhook', {
      method: 'POST',
      headers,
    });
  }

  it('HARD-REFUSES in production when VAPI_WEBHOOK_SECRET is unset', () => {
    env.NODE_ENV = 'production';
    const result = verifyVapiWebhook(makeReq());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/misconfigured/);
  });

  it('accepts any request in development when secret is unset (soft)', () => {
    env.NODE_ENV = 'development';
    const result = verifyVapiWebhook(makeReq());
    expect(result.ok).toBe(true);
  });

  it('accepts correct secret via x-vapi-secret header', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'shh_123';
    const result = verifyVapiWebhook(
      makeReq({ 'x-vapi-secret': 'shh_123' })
    );
    expect(result.ok).toBe(true);
  });

  it('accepts correct secret via Authorization: Bearer', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'shh_123';
    const result = verifyVapiWebhook(
      makeReq({ authorization: 'Bearer shh_123' })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects wrong secret', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'shh_123';
    const result = verifyVapiWebhook(
      makeReq({ 'x-vapi-secret': 'nope' })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects missing header when secret IS set', () => {
    process.env.VAPI_WEBHOOK_SECRET = 'shh_123';
    const result = verifyVapiWebhook(makeReq());
    expect(result.ok).toBe(false);
  });
});
