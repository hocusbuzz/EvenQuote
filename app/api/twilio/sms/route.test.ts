// Security-focused tests for the Twilio inbound-SMS webhook.
//
// This route is an untrusted-origin write surface — anyone who can POST
// to it can (if the signature check is broken) inject fake contractor
// quotes into a customer's quote request. Round 24 is adding focused
// signature-verification coverage before we go live on a real Twilio
// number. The happy-path extraction + DB-insert paths are exercised
// through match-inbound.test.ts and extract-quote.test.ts — what's
// tested HERE is the perimeter:
//
//   1. Prod with no TWILIO_AUTH_TOKEN → 500 "misconfigured"
//   2. Dev with no token → accepted (soft)
//   3. Prod with invalid signature → 401
//   4. Prod with valid signature → 200 + TwiML reply
//   5. Missing From or Body → 400
//
// We DO NOT execute the full handler against a real DB here — the admin
// client is stubbed to make match-inbound return null (unmatched phone),
// which short-circuits the handler before it writes anything. That's
// sufficient to prove the signature gate actually gates: a bad signature
// returns 401 before match-inbound is ever called.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

// Stub the admin client so the handler doesn't try to open a real
// Supabase connection. match-inbound returns null on an empty
// businesses list, which short-circuits handleInboundSms cleanly.
const matchInboundMock = vi.fn();
vi.mock('@/lib/calls/match-inbound', () => ({
  matchInboundToQuoteRequest: (...args: unknown[]) => matchInboundMock(...args),
}));

// Admin client is still called to construct the mock Supabase surface;
// the functions on it are irrelevant for signature-gate tests because
// matchInboundMock short-circuits. Happy-path tests in the lower block
// swap `adminClientImpl` to a concrete stub that records inserts/RPCs.
let adminClientImpl: {
  from: (t: string) => unknown;
  rpc: (name: string, args: unknown) => Promise<unknown>;
} = { from: () => ({}), rpc: () => Promise.resolve({}) };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminClientImpl,
}));

// Extractor mock — signature-gate tests never reach it (match-inbound
// short-circuits first). Happy-path tests rewire `extractorImpl` per
// test to return deterministic ok:true / ok:false results.
let extractorImpl: (...args: unknown[]) => Promise<unknown> = () =>
  Promise.resolve({ ok: false, reason: 'default stub' });
vi.mock('@/lib/calls/extract-quote', () => ({
  extractQuoteFromCall: (...args: unknown[]) => extractorImpl(...args),
}));

const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
}));

import { POST } from './route';

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS: string[] = ['TWILIO_AUTH_TOKEN', 'NODE_ENV'];

function computeTwilioSignature(url: string, params: URLSearchParams, token: string): string {
  // Mirror the algorithm in route.ts reconstructTwilioUrl+HMAC logic.
  // Twilio spec: HMAC-SHA1(token, url + sortedKeys.map(k => k + v).join(''))
  const sortedKeys = [...params.keys()].sort();
  const concat = sortedKeys.map((k) => k + (params.get(k) ?? '')).join('');
  return crypto.createHmac('sha1', token).update(url + concat).digest('base64');
}

function makeRequest(opts: {
  body: URLSearchParams;
  url?: string;
  signature?: string;
  headers?: Record<string, string>;
}): Request {
  const url = opts.url ?? 'https://example.com/api/twilio/sms';
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...opts.headers,
  };
  if (opts.signature !== undefined) {
    headers['x-twilio-signature'] = opts.signature;
  }
  return new Request(url, {
    method: 'POST',
    headers,
    body: opts.body.toString(),
  });
}

describe('POST /api/twilio/sms — signature gate', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    matchInboundMock.mockReset();
    captureExceptionMock.mockReset();
    // Default: no match. Handler short-circuits cleanly without DB work.
    matchInboundMock.mockResolvedValue(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('HARD-REFUSES with 500 in production when TWILIO_AUTH_TOKEN is unset', async () => {
    env.NODE_ENV = 'production';
    const body = new URLSearchParams({ From: '+14155551234', Body: 'test' });
    const res = await POST(makeRequest({ body }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/misconfigured/);
    // Must NOT reach match-inbound when misconfigured — otherwise a
    // prod deploy without the token would still process inbound SMS.
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('accepts without signature in development (soft) — allows local testing', async () => {
    env.NODE_ENV = 'development';
    const body = new URLSearchParams({ From: '+14155551234', Body: 'test' });
    const res = await POST(makeRequest({ body }));
    // 200 TwiML empty response (no-match path).
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/xml/);
    // match-inbound WAS called — the handler proceeded.
    expect(matchInboundMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when signature header is wrong (prod)', async () => {
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    const body = new URLSearchParams({ From: '+14155551234', Body: 'test' });
    const res = await POST(
      makeRequest({ body, signature: 'obviously-not-a-valid-sig' })
    );
    expect(res.status).toBe(401);
    // Signature gate must fire BEFORE match-inbound. A bug here would
    // let unauthenticated inbound SMS land in the quotes table.
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when signature header is missing (prod)', async () => {
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    const body = new URLSearchParams({ From: '+14155551234', Body: 'test' });
    const res = await POST(makeRequest({ body })); // no signature
    expect(res.status).toBe(401);
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('accepts with valid signature and returns TwiML reply (prod)', async () => {
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';

    const url = 'https://example.com/api/twilio/sms';
    const body = new URLSearchParams({
      From: '+14155551234',
      Body: 'Yep — $800 flat, available next week.',
    });
    const signature = computeTwilioSignature(url, body, 'token_abc');

    const res = await POST(makeRequest({ body, url, signature }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/xml/);
    // No-match path returns an empty TwiML Response (no <Message>), so
    // the contractor doesn't get a misleading "Got it" reply when we
    // can't find their call.
    const xml = await res.text();
    expect(xml).toMatch(/<Response/);
    expect(matchInboundMock).toHaveBeenCalledTimes(1);
  });

  it('prefers X-Forwarded-Proto/Host when reconstructing the signed URL', async () => {
    // Behind an edge that preserves the original URL via forwarded
    // headers (Vercel + cloudflared both do this in practice), the
    // signature Twilio computed is against the PUBLIC URL, not the
    // internal one. Verifier must reconstruct with the forwarded
    // headers or valid requests will 401.
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';

    const publicUrl = 'https://public.example.com/api/twilio/sms';
    const internalUrl = 'https://internal.vercel.app/api/twilio/sms';
    const body = new URLSearchParams({ From: '+14155551234', Body: 'hi' });
    // Twilio signed against the PUBLIC url.
    const signature = computeTwilioSignature(publicUrl, body, 'token_abc');

    const res = await POST(
      makeRequest({
        body,
        url: internalUrl,
        signature,
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'public.example.com',
        },
      })
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 on missing From after signature passes', async () => {
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    const url = 'https://example.com/api/twilio/sms';
    const body = new URLSearchParams({ Body: 'hi' }); // no From
    const signature = computeTwilioSignature(url, body, 'token_abc');
    const res = await POST(makeRequest({ body, url, signature }));
    expect(res.status).toBe(400);
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('returns 400 on missing Body after signature passes', async () => {
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    const url = 'https://example.com/api/twilio/sms';
    const body = new URLSearchParams({ From: '+14155551234' }); // no Body
    const signature = computeTwilioSignature(url, body, 'token_abc');
    const res = await POST(makeRequest({ body, url, signature }));
    expect(res.status).toBe(400);
  });

  it('does NOT crash when providedSig is length-mismatched vs expected', async () => {
    // crypto.timingSafeEqual throws on length mismatch. The route
    // guards this with `providedSig.length === expected.length`. If
    // that guard is removed, the handler would 500 instead of 401 on
    // a wrong-length signature — which is a less-clean response to a
    // stuffing attack and also hides the real reason from ops.
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    const body = new URLSearchParams({ From: '+14155551234', Body: 'x' });
    const res = await POST(makeRequest({ body, signature: 'short' }));
    expect(res.status).toBe(401);
    expect(matchInboundMock).not.toHaveBeenCalled();
  });
});

// ── Full-path happy-case coverage (Round 25) ────────────────────────
//
// R24 locked the signature gate but no test exercised the full
// match → calls-insert → extract → quotes-insert → bump-counter chain
// inside the route. This block provides drift detection on:
//   • the `calls` row shape (columns the route writes)
//   • the `increment_quotes_collected` RPC name + parameter name
//   • the synthetic vapi_call_id prefix ('sms_') used for dedupe
//   • idempotency: a replayed SMS (same From+Body+request) must
//     NOT insert a second call or quote (dedupe by vapi_call_id)
//
// We stub the extractor at the module boundary — the extractor has
// its own Claude-call tests; we just need a deterministic ok:true /
// ok:false response here to drive the route's downstream logic.

describe('POST /api/twilio/sms — full-path happy case', () => {
  const realEnv: Record<string, string | undefined> = {};

  // Small helper to build an admin client with a recorded log of
  // every `from(table).<op>` call. Each test can assert against the
  // recorded operations.
  type OpLog = {
    callsInserts: Record<string, unknown>[];
    quotesInserts: Record<string, unknown>[];
    rpcCalls: { name: string; args: unknown }[];
    // What the dedupe lookup should return (null = new, object =
    // already recorded — triggers the idempotent skip path).
    dedupeExisting: { id: string } | null;
    // What the calls-insert should resolve with.
    callsInsertResult: { data: { id: string } | null; error: unknown };
    // What the quotes-insert should resolve with.
    quotesInsertResult: { error: unknown };
    // What the bump-counter RPC should resolve with.
    rpcResult: { error: unknown };
  };

  function makeAdminStub(opts: Partial<OpLog> = {}): {
    client: { from: (t: string) => unknown; rpc: (n: string, a: unknown) => Promise<unknown> };
    log: OpLog;
  } {
    const log: OpLog = {
      callsInserts: [],
      quotesInserts: [],
      rpcCalls: [],
      dedupeExisting: null,
      callsInsertResult: { data: { id: 'call-new-0' }, error: null },
      quotesInsertResult: { error: null },
      rpcResult: { error: null },
      ...opts,
    };
    const client = {
      from: (table: string) => {
        if (table === 'calls') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: log.dedupeExisting, error: null }),
              }),
            }),
            insert: (row: Record<string, unknown>) => {
              log.callsInserts.push(row);
              return {
                select: () => ({
                  single: () => Promise.resolve(log.callsInsertResult),
                }),
              };
            },
          };
        }
        if (table === 'quotes') {
          return {
            insert: (row: Record<string, unknown>) => {
              log.quotesInserts.push(row);
              return Promise.resolve(log.quotesInsertResult);
            },
          };
        }
        throw new Error(`unexpected admin.from(${table})`);
      },
      rpc: (name: string, args: unknown) => {
        log.rpcCalls.push({ name, args });
        return Promise.resolve(log.rpcResult);
      },
    };
    return { client, log };
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) realEnv[k] = env[k];
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    matchInboundMock.mockReset();
    captureExceptionMock.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) env[k] = realEnv[k];
    // Reset shared mock state back to the harmless defaults so the
    // next test (or a re-run of signature-gate tests) sees a clean
    // admin stub.
    adminClientImpl = { from: () => ({}), rpc: () => Promise.resolve({}) };
    extractorImpl = () =>
      Promise.resolve({ ok: false, reason: 'default stub' });
  });

  async function postSmsHappy(opts: {
    match: {
      businessId: string;
      businessName: string;
      quoteRequestId: string;
      outboundCallId: string;
      categorySlug: string | null;
      categoryName: string | null;
      extractionSchema: Record<string, unknown> | null;
    };
    extractionResult: unknown;
    adminOverrides?: Partial<OpLog>;
    from?: string;
    body?: string;
  }): Promise<{ res: Response; log: OpLog }> {
    matchInboundMock.mockResolvedValue(opts.match);

    // Rewire the shared extractor impl to return the per-test result.
    extractorImpl = () => Promise.resolve(opts.extractionResult);

    const { client, log } = makeAdminStub(opts.adminOverrides);
    adminClientImpl = client;

    const from = opts.from ?? '+14155550199';
    const body = opts.body ?? '$800 flat, available Friday afternoon';
    const form = new URLSearchParams({ From: from, Body: body });
    const url = 'https://example.com/api/twilio/sms';
    const signature = computeTwilioSignature(
      url,
      form,
      env.TWILIO_AUTH_TOKEN as string
    );
    const res = await POST(makeRequest({ body: form, url, signature }));
    return { res, log };
  }

  it('inserts calls row + quotes row + fires RPC on a matched SMS with extracted quote', async () => {
    const { res, log } = await postSmsHappy({
      match: {
        businessId: 'biz-1',
        businessName: 'Acme Movers',
        quoteRequestId: 'qr-1',
        outboundCallId: 'call-outbound-1',
        categorySlug: 'moving',
        categoryName: 'Moving',
        extractionSchema: { price_anchors: 'usually $500–$1500' },
      },
      extractionResult: {
        ok: true,
        quote: {
          priceMin: 800,
          priceMax: 800,
          priceDescription: '$800 flat',
          availability: 'Friday afternoon',
          includes: ['loading', 'driving'],
          excludes: [],
          notes: null,
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          requiresOnsiteEstimate: false,
          confidenceScore: 0.85,
        },
      },
    });

    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toMatch(/<Response>/);
    expect(xml).toMatch(/Got it, thanks/);

    // Exactly one calls insert with the canonical column set.
    expect(log.callsInserts).toHaveLength(1);
    const call = log.callsInserts[0];
    expect(call.quote_request_id).toBe('qr-1');
    expect(call.business_id).toBe('biz-1');
    expect(call.status).toBe('completed');
    expect(typeof call.vapi_call_id).toBe('string');
    expect((call.vapi_call_id as string).startsWith('sms_')).toBe(true);
    // Transcript stand-in is the raw SMS body.
    expect(call.transcript).toBe('$800 flat, available Friday afternoon');
    // Duration always 0 for SMS (we have no call metrics here).
    expect(call.duration_seconds).toBe(0);
    expect(call.cost).toBe(0);

    // Exactly one quotes insert with extractor fields flattened.
    expect(log.quotesInserts).toHaveLength(1);
    const q = log.quotesInserts[0];
    expect(q.call_id).toBe('call-new-0');
    expect(q.quote_request_id).toBe('qr-1');
    expect(q.business_id).toBe('biz-1');
    expect(q.price_min).toBe(800);
    expect(q.price_max).toBe(800);
    expect(q.price_description).toBe('$800 flat');
    expect(q.availability).toBe('Friday afternoon');
    expect(q.includes).toEqual(['loading', 'driving']);
    expect(q.requires_onsite_estimate).toBe(false);
    expect(q.confidence_score).toBe(0.85);

    // Counter bump fired with the canonical RPC name + param shape.
    expect(log.rpcCalls).toHaveLength(1);
    expect(log.rpcCalls[0].name).toBe('increment_quotes_collected');
    expect(log.rpcCalls[0].args).toEqual({ p_request_id: 'qr-1' });

    // Happy path must not page Sentry.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('idempotently skips when the dedupe lookup finds the synthetic id already recorded', async () => {
    // Replay scenario — Twilio retries an SMS delivery and the hash
    // already exists. We must NOT insert a second calls row, NOT
    // insert a second quote, and NOT double-bump the counter. We
    // still respond 200 + TwiML so Twilio stops retrying.
    const { res, log } = await postSmsHappy({
      match: {
        businessId: 'biz-1',
        businessName: 'Acme',
        quoteRequestId: 'qr-1',
        outboundCallId: 'call-outbound-1',
        categorySlug: null,
        categoryName: null,
        extractionSchema: null,
      },
      extractionResult: { ok: false, reason: 'unused in dedupe path' },
      adminOverrides: {
        dedupeExisting: { id: 'call-previously-recorded' },
      },
    });

    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(0);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('persists the calls audit row but skips quotes insert when extraction returns ok:false', async () => {
    // Ops invariant: even when we can't extract structured data, the
    // SMS still gets an audit trail in `calls` (so we see the reply
    // landed). Quotes insert + RPC bump MUST NOT fire — a bogus
    // quote with confidence_score=0 is worse than no quote.
    const { res, log } = await postSmsHappy({
      match: {
        businessId: 'biz-1',
        businessName: 'Acme',
        quoteRequestId: 'qr-1',
        outboundCallId: 'call-outbound-1',
        categorySlug: 'moving',
        categoryName: 'Moving',
        extractionSchema: null,
      },
      extractionResult: { ok: false, reason: 'no price in body' },
    });

    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(1);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('tolerates a 23505 (unique violation) on calls insert as race-idempotency', async () => {
    // Two Twilio retries racing through the dedupe lookup at the same
    // time would both see dedupeExisting=null and both attempt the
    // insert. The UNIQUE constraint on vapi_call_id means one succeeds
    // and the other gets a 23505. The route's behavior: return
    // silently, do NOT throw, do NOT proceed to quotes insert or RPC.
    const { res, log } = await postSmsHappy({
      match: {
        businessId: 'biz-1',
        businessName: 'Acme',
        quoteRequestId: 'qr-1',
        outboundCallId: 'call-outbound-1',
        categorySlug: null,
        categoryName: null,
        extractionSchema: null,
      },
      extractionResult: {
        ok: true,
        quote: {
          priceMin: 500,
          priceMax: 500,
          priceDescription: '$500',
          availability: null,
          includes: [],
          excludes: [],
          notes: null,
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          requiresOnsiteEstimate: false,
          confidenceScore: 0.9,
        },
      },
      adminOverrides: {
        callsInsertResult: {
          data: null,
          error: { code: '23505', message: 'duplicate key value' },
        },
      },
    });

    expect(res.status).toBe(200);
    // Insert was ATTEMPTED but returned 23505 — quotes + RPC must not run.
    expect(log.callsInserts).toHaveLength(1);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures non-23505 calls-insert errors at the route boundary', async () => {
    // Non-duplicate DB errors should throw → caught by the route's
    // try/catch → captureException + 200 TwiML (empty) so Twilio
    // doesn't storm us with retries. The key invariant: Sentry
    // sees it, the caller sees a clean ack, and no quote lands.
    const { res, log } = await postSmsHappy({
      match: {
        businessId: 'biz-1',
        businessName: 'Acme',
        quoteRequestId: 'qr-1',
        outboundCallId: 'call-outbound-1',
        categorySlug: null,
        categoryName: null,
        extractionSchema: null,
      },
      extractionResult: {
        ok: true,
        quote: {
          priceMin: 500,
          priceMax: 500,
          priceDescription: '$500',
          availability: null,
          includes: [],
          excludes: [],
          notes: null,
          contactName: null,
          contactPhone: null,
          contactEmail: null,
          requiresOnsiteEstimate: false,
          confidenceScore: 0.9,
        },
      },
      adminOverrides: {
        callsInsertResult: {
          data: null,
          error: { code: '42P01', message: 'relation "calls" does not exist' },
        },
      },
    });

    expect(res.status).toBe(200); // Twilio retry-storm guard
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toEqual({ tags: { route: 'twilio/sms' } });
  });
});

// ── Idempotency-column drift (R32) — locks at-most-once column names ─
//
// Sibling of R31's vapi/webhook drift suite. The Twilio SMS route has
// its own at-most-once defense that rides on the SAME `calls.vapi_call_id`
// UNIQUE constraint as the voice flow — using a synthetic `sms_<hash>`
// prefix so voice and SMS can't collide. The column names are load-bearing:
//
//   LOOKUP layer — dedupe select keys on `vapi_call_id`. Rename to
//                  `external_id` / `provider_msg_id` / `twilio_sid` and
//                  every retry becomes a fresh insert → duplicate `calls`
//                  rows + duplicate quotes + double counter bumps.
//
//   SYNTHETIC-ID prefix — the inserted row's vapi_call_id starts with
//                  `sms_`. A drift to `twilio_` or `sms:` silently breaks
//                  reports/filters that use the prefix to distinguish
//                  SMS-sourced quotes from voice-sourced ones. Also load-
//                  bearing for the hash-based dedupe behavior: the
//                  generation AND the lookup must use the same prefix.
//
//   INSERT shape — the `calls` row carries an exact column set. A
//                  migration that dropped `transcript` (the SMS body
//                  stand-in) or renamed `started_at`/`ended_at` would
//                  silently blank those columns for every SMS reply.
//
//   UNIQUE backstop — `quotes.call_id` is UNIQUE; a 23505 on quotes
//                  insert is swallowed. The R25 23505 test locks the
//                  BEHAVIOR; this block locks the anchor COLUMN NAME so
//                  a "simplify the join" refactor can't silently break
//                  the parallel-retry dedupe.
//
// Methodology mirrors R30/R31: extended stub records the column NAME
// passed to `.eq(…)` / `.insert(…)` / `.rpc(…)` (not just values).

describe('POST /api/twilio/sms — idempotency-column drift (R32)', () => {
  const realEnv: Record<string, string | undefined> = {};

  type DriftEq = { table: string; column: string; value: unknown };
  type DriftInsert = { table: string; row: Record<string, unknown> };
  type DriftRpc = { name: string; args: Record<string, unknown> };
  type DriftTracker = {
    eqCalls: DriftEq[];
    inserts: DriftInsert[];
    rpcCalls: DriftRpc[];
  };

  function buildDriftCapturingAdminStub(opts: {
    tracker: DriftTracker;
    dedupeExisting?: { id: string } | null;
    callsInsertResult?: { data: { id: string } | null; error: unknown };
    quotesInsertResult?: { error: unknown };
    rpcResult?: { error: unknown };
  }) {
    const dedupe = opts.dedupeExisting ?? null;
    const callIns = opts.callsInsertResult ?? { data: { id: 'drift-call-id' }, error: null };
    const quoteIns = opts.quotesInsertResult ?? { error: null };
    const rpcRes = opts.rpcResult ?? { error: null };
    return {
      from: (table: string) => {
        if (table === 'calls') {
          return {
            select: () => ({
              eq: (column: string, value: unknown) => {
                opts.tracker.eqCalls.push({ table, column, value });
                return {
                  maybeSingle: () =>
                    Promise.resolve({ data: dedupe, error: null }),
                };
              },
            }),
            insert: (row: Record<string, unknown>) => {
              opts.tracker.inserts.push({ table, row });
              return {
                select: () => ({
                  single: () => Promise.resolve(callIns),
                }),
              };
            },
          };
        }
        if (table === 'quotes') {
          return {
            insert: (row: Record<string, unknown>) => {
              opts.tracker.inserts.push({ table, row });
              return Promise.resolve(quoteIns);
            },
          };
        }
        throw new Error(`unexpected admin.from(${table})`);
      },
      rpc: (name: string, args: unknown) => {
        // The shared `adminClientImpl` typing uses `args: unknown`;
        // match it here and cast into the tracker's stricter shape.
        opts.tracker.rpcCalls.push({ name, args: args as Record<string, unknown> });
        return Promise.resolve(rpcRes);
      },
    };
  }

  const DRIFT_HAPPY_QUOTE = {
    priceMin: 500,
    priceMax: 500,
    priceDescription: '$500',
    availability: null,
    includes: [],
    excludes: [],
    notes: null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    requiresOnsiteEstimate: false,
    confidenceScore: 0.9,
  };

  beforeEach(() => {
    for (const k of ENV_KEYS) realEnv[k] = env[k];
    env.NODE_ENV = 'production';
    env.TWILIO_AUTH_TOKEN = 'token_abc';
    matchInboundMock.mockReset();
    captureExceptionMock.mockReset();
    matchInboundMock.mockResolvedValue({
      businessId: 'biz-drift',
      businessName: 'Acme',
      quoteRequestId: 'req-drift',
      outboundCallId: 'call-outbound-drift',
      categorySlug: null,
      categoryName: null,
      extractionSchema: null,
    });
    extractorImpl = () =>
      Promise.resolve({ ok: true, quote: DRIFT_HAPPY_QUOTE });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) env[k] = realEnv[k];
    adminClientImpl = { from: () => ({}), rpc: () => Promise.resolve({}) };
    extractorImpl = () =>
      Promise.resolve({ ok: false, reason: 'default stub' });
  });

  async function postWithSignedBody(
    from: string = '+14155550199',
    body: string = '$500 flat',
  ): Promise<void> {
    const form = new URLSearchParams({ From: from, Body: body });
    const url = 'https://example.com/api/twilio/sms';
    const signature = computeTwilioSignature(url, form, 'token_abc');
    await POST(makeRequest({ body: form, url, signature }));
  }

  it('LOOKUP layer — dedupe select keys on `vapi_call_id` (not drifted names)', async () => {
    // If this column name drifts, the lookup always returns null → every
    // Twilio retry inserts a NEW calls row → UNIQUE constraint would
    // still catch the second insert, but then we'd be relying solely on
    // the 23505 swallow for idempotency (one layer instead of two).
    // Lock the LOOKUP column explicitly.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker });

    await postWithSignedBody();

    // First (and only) eq on calls is the dedupe lookup.
    const callsEqs = tracker.eqCalls.filter((c) => c.table === 'calls');
    const lookupEq = callsEqs[0];
    expect(lookupEq, 'calls dedupe lookup must fire').toBeDefined();
    expect(lookupEq.column).toBe('vapi_call_id');
    // Value is the synthetic sms_* id — prefix locked in the next test.
    expect(typeof lookupEq.value).toBe('string');
    expect((lookupEq.value as string).startsWith('sms_')).toBe(true);

    // Negative assertions: common drift candidates.
    const DRIFTED_LOOKUP_NAMES = [
      'external_id',
      'provider_msg_id',
      'twilio_sid',
      'message_sid',
      'sms_id',
      'sid',
    ];
    for (const drifted of DRIFTED_LOOKUP_NAMES) {
      expect(
        lookupEq.column,
        `dedupe lookup must NOT key on '${drifted}' (drifted column)`
      ).not.toBe(drifted);
    }
  });

  it('SYNTHETIC-ID prefix — both lookup AND insert use `sms_` prefix (locked)', async () => {
    // The prefix is load-bearing twice over:
    //   1. It keeps SMS + voice IDs from colliding on the UNIQUE index.
    //   2. Ops reports use the prefix to partition SMS vs voice metrics.
    // A drift to `twilio_` or `msg_` silently breaks ops filters AND
    // creates a potential ID collision with future voice providers.
    // Also: the GENERATION (at insert time) and the LOOKUP must use the
    // SAME prefix — otherwise the first insert generates `twilio_xxx`
    // while the retry's lookup goes to `sms_xxx` (or vice versa) and
    // dedupe silently doesn't work.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker });

    await postWithSignedBody();

    const callsInsert = tracker.inserts.find((i) => i.table === 'calls');
    expect(callsInsert, 'calls insert must fire on a matched SMS').toBeDefined();
    const insertedId = callsInsert!.row.vapi_call_id as string;
    const lookupValue = tracker.eqCalls
      .filter((c) => c.table === 'calls' && c.column === 'vapi_call_id')[0]
      .value as string;

    // Both sides use the SAME `sms_` prefix.
    expect(insertedId.startsWith('sms_')).toBe(true);
    expect(lookupValue.startsWith('sms_')).toBe(true);
    // And they're the SAME value — dedupe would silently fail otherwise.
    expect(insertedId).toBe(lookupValue);

    // Negative assertions: drift prefixes that would defeat dedupe or
    // collide with voice's bare Vapi IDs.
    const DRIFTED_PREFIXES = ['twilio_', 'msg_', 'sms:', 'tw_', 'SMS_'];
    for (const drifted of DRIFTED_PREFIXES) {
      expect(
        insertedId.startsWith(drifted),
        `synthetic id must NOT use drifted prefix '${drifted}'`
      ).toBe(false);
      expect(
        lookupValue.startsWith(drifted),
        `lookup value must NOT use drifted prefix '${drifted}'`
      ).toBe(false);
    }
  });

  it('SYNTHETIC-ID stability — same (requestId, from, body) triple hashes to same id', async () => {
    // Idempotency depends on the hash being deterministic: the same SMS
    // retried by Twilio must produce the SAME synthetic id. A drift to
    // a non-deterministic generator (timestamp, random suffix) would
    // silently break dedupe under retry storms.
    const tracker1: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker: tracker1 });
    await postWithSignedBody('+14155550199', '$500 flat');
    const firstId = tracker1.eqCalls.filter(
      (c) => c.table === 'calls' && c.column === 'vapi_call_id'
    )[0].value as string;

    const tracker2: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker: tracker2 });
    await postWithSignedBody('+14155550199', '$500 flat');
    const secondId = tracker2.eqCalls.filter(
      (c) => c.table === 'calls' && c.column === 'vapi_call_id'
    )[0].value as string;

    expect(secondId).toBe(firstId);
  });

  it('SYNTHETIC-ID — distinct body produces distinct id (no hash collision on trivial inputs)', async () => {
    // Negative control — the hash must actually partition on the body,
    // not collapse everything into a single `sms_<constant>` bucket.
    const tracker1: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker: tracker1 });
    await postWithSignedBody('+14155550199', 'A');

    const tracker2: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker: tracker2 });
    await postWithSignedBody('+14155550199', 'B');

    const idA = tracker1.eqCalls.filter(
      (c) => c.table === 'calls' && c.column === 'vapi_call_id'
    )[0].value as string;
    const idB = tracker2.eqCalls.filter(
      (c) => c.table === 'calls' && c.column === 'vapi_call_id'
    )[0].value as string;
    expect(idA).not.toBe(idB);
  });

  it('INSERT shape — calls row writes the exact 10-column set (not drifted)', async () => {
    // A migration that dropped `transcript` (the SMS body stand-in) or
    // renamed `ended_at` → `completed_at` would silently blank the
    // column for every SMS reply. Lock the shape.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker });

    await postWithSignedBody();

    const callsInsert = tracker.inserts.find((i) => i.table === 'calls');
    expect(callsInsert, 'calls insert must fire').toBeDefined();
    expect(new Set(Object.keys(callsInsert!.row))).toEqual(
      new Set([
        'quote_request_id',
        'business_id',
        'vapi_call_id',
        'status',
        'started_at',
        'ended_at',
        'duration_seconds',
        'transcript',
        'summary',
        'cost',
      ])
    );

    // Drift candidates.
    const DRIFTED_INSERT_KEYS = [
      'completed_at', // rename of ended_at
      'finished_at', // alt rename
      'duration', // missing _seconds
      'transcript_text', // suffix drift
      'sms_body', // rename of transcript
      'call_summary', // prefix drift
      'total_cost', // prefix drift
      'provider_call_id', // rename of vapi_call_id
      'external_id', // alt rename of vapi_call_id
    ];
    for (const drifted of DRIFTED_INSERT_KEYS) {
      expect(
        Object.keys(callsInsert!.row),
        `calls insert must NOT carry drifted key '${drifted}'`
      ).not.toContain(drifted);
    }

    // Status literal is 'completed' (SMS is a terminal event — no
    // in-progress state). A rename to `finished`/`done` would break
    // any status-based filter. Lock it explicitly.
    expect(callsInsert!.row.status).toBe('completed');
  });

  it('UNIQUE backstop — quotes insert targets `call_id` as the UNIQUE anchor (not drifted)', async () => {
    // Identical semantic to R31 vapi-webhook UNIQUE backstop test —
    // quotes.call_id is UNIQUE across BOTH voice and SMS sources. If
    // someone joins quotes directly to vapi_call_id on the SMS path
    // (which is tempting because the synthetic id is unique and
    // already in scope), parallel Twilio retries could insert two
    // quotes for the same SMS before either hits the UNIQUE index.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker });

    await postWithSignedBody();

    const quotesInsert = tracker.inserts.find((i) => i.table === 'quotes');
    expect(quotesInsert, 'quotes insert must fire').toBeDefined();
    // The UNIQUE-backed anchor MUST be the internal calls row id (the
    // value our insert returned from `.select('id').single()`), NOT
    // the synthetic vapi_call_id.
    expect(quotesInsert!.row.call_id).toBe('drift-call-id');

    const DRIFTED_BACKSTOP_KEYS = [
      'calls_id',
      'vapi_call_id', // tempting simplification — explicitly forbidden
      'provider_call_id',
      'sms_id',
      'message_sid',
      'call_ref',
      'id',
    ];
    for (const drifted of DRIFTED_BACKSTOP_KEYS) {
      expect(
        quotesInsert!.row,
        `quotes insert must NOT carry drifted anchor '${drifted}'`
      ).not.toHaveProperty(drifted);
    }
  });

  it('UNIQUE backstop — 23505 on quotes insert is swallowed (anchor in place)', async () => {
    // Behavior lock — complements the anchor-name lock above. If the
    // 23505 swallow regressed to throwing, a parallel Twilio retry
    // would 5xx and Twilio would retry again, flooding.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({
      tracker,
      quotesInsertResult: { error: { code: '23505', message: 'duplicate key' } },
    });

    await postWithSignedBody();

    // 23505 swallow: no capture, no 5xx.
    expect(captureExceptionMock).not.toHaveBeenCalled();
    // The quotes insert was ATTEMPTED before getting 23505.
    expect(tracker.inserts.some((i) => i.table === 'quotes')).toBe(true);
  });

  it('RPC contract — counter bump fires `increment_quotes_collected` with `p_request_id` (not drifted)', async () => {
    // R25 already locked this, but the drift suite audits ALL the
    // load-bearing names on this route in one place. A rename of the
    // RPC or its arg means the counter silently stops advancing and
    // the send-reports cron never picks up completed requests.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({ tracker });

    await postWithSignedBody();

    expect(tracker.rpcCalls).toHaveLength(1);
    expect(tracker.rpcCalls[0].name).toBe('increment_quotes_collected');
    expect(Object.keys(tracker.rpcCalls[0].args)).toEqual(['p_request_id']);
    expect(tracker.rpcCalls[0].args.p_request_id).toBe('req-drift');

    // Drift candidates.
    const DRIFTED_RPC_NAMES = [
      'bump_quotes_collected',
      'increment_quote_count',
      'apply_sms_quote',
      'increment_quotes',
    ];
    for (const drifted of DRIFTED_RPC_NAMES) {
      expect(tracker.rpcCalls[0].name).not.toBe(drifted);
    }
    const DRIFTED_RPC_ARGS = ['request_id', 'p_quote_request_id', 'quote_request_id', 'p_id'];
    for (const drifted of DRIFTED_RPC_ARGS) {
      expect(Object.keys(tracker.rpcCalls[0].args)).not.toContain(drifted);
    }
  });

  it('DEDUPE SHORT-CIRCUIT — existing row means zero writes and zero RPC', async () => {
    // Flip side of the LOOKUP lock: if the dedupe found a row, NO
    // downstream work fires. If someone refactors the short-circuit
    // out (e.g. "always re-extract for updated confidence"), this
    // silently double-bumps the counter on every Twilio retry.
    const tracker: DriftTracker = { eqCalls: [], inserts: [], rpcCalls: [] };
    adminClientImpl = buildDriftCapturingAdminStub({
      tracker,
      dedupeExisting: { id: 'call-previously-recorded' },
    });

    await postWithSignedBody();

    // Lookup fired, but no inserts, no RPC.
    expect(tracker.eqCalls.length).toBeGreaterThan(0);
    expect(tracker.inserts).toHaveLength(0);
    expect(tracker.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
