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
import { startOutboundCall, verifyVapiWebhook } from './vapi';

// TS 5 + @types/node 20+ type NODE_ENV as a readonly literal union, so
// direct and bracket-with-literal assignment both fail `tsc --noEmit`.
// Route all env writes through this writable view. Runtime identity is
// unchanged; we only broaden the static type.
const env = process.env as Record<string, string | undefined>;

// Utility — we flip env vars a lot. Keep a clean slate between tests.
// Plain string[] (not `as const`) so indexing process.env with these keys
// doesn't narrow to NODE_ENV's readonly literal type under strict TS 5.
const ENV_KEYS: string[] = [
  'VAPI_API_KEY',
  'VAPI_PHONE_NUMBER_ID',
  'VAPI_ASSISTANT_ID',
  'VAPI_WEBHOOK_SECRET',
  'TEST_OVERRIDE_PHONE',
  'NODE_ENV',
];

describe('startOutboundCall', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
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
