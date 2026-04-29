// Full-path happy-case tests for the Vapi inbound-callback webhook.
//
// This is the voice analog of app/api/twilio/sms — a contractor
// dials back the Vapi callback assistant, the assistant produces an
// end-of-call-report, and we persist it as a `calls` + `quotes` row
// on the matched quote_request.
//
// R24 locked the signature gate + the match-inbound layer
// independently. R25 exercises the full chain inside the route:
//
//   verify → JSON parse → match → calls.insert → extract →
//   quotes.insert → increment_quotes_collected RPC
//
// Drift detection targets:
//   • `calls` row column shape (quote_request_id, business_id,
//     vapi_call_id, status='completed', started_at/ended_at,
//     transcript, recording_url, summary, extracted_data, cost)
//   • `quotes` row column shape (flat extractor fields)
//   • `increment_quotes_collected` RPC name + p_request_id param
//   • 23505 idempotency swallow on BOTH calls + quotes insert
//   • dedupe lookup short-circuits before any insert
//   • signature gate still fires (belt-and-suspenders — prevents a
//     refactor from accidentally making the happy-path tests the ONLY
//     coverage of this route)
//
// We do NOT exercise the extractor against a real Claude call; the
// extractor module has its own test suite. We stub it to return a
// deterministic ok:true/ok:false per test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── match-inbound mock ──────────────────────────────────────────────
const matchInboundMock = vi.fn();
vi.mock('@/lib/calls/match-inbound', () => ({
  matchInboundToQuoteRequest: (...args: unknown[]) => matchInboundMock(...args),
}));

// ── extract-quote mock (per-test deterministic) ─────────────────────
let extractorImpl: (...args: unknown[]) => Promise<unknown> = () =>
  Promise.resolve({ ok: false, reason: 'default stub' });
vi.mock('@/lib/calls/extract-quote', () => ({
  extractQuoteFromCall: (...args: unknown[]) => extractorImpl(...args),
}));

// ── admin client mock (shared mutable state) ────────────────────────
let adminClientImpl: {
  from: (t: string) => unknown;
  rpc: (name: string, args: unknown) => Promise<unknown>;
} = { from: () => ({}), rpc: () => Promise.resolve({}) };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminClientImpl,
}));

// ── vapi webhook verify mock ────────────────────────────────────────
// We import POST once (top-level) and control the verify result via
// this shared value. The route calls verifyVapiWebhook(req) first; by
// flipping `verifyResult` we test both authorized and unauthorized
// flows without swapping routes between tests.
let verifyResult: { ok: true } | { ok: false; error: string } = { ok: true };
vi.mock('@/lib/calls/vapi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/calls/vapi');
  return {
    ...actual,
    verifyVapiWebhook: () => verifyResult,
  };
});

const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
}));

import { POST } from './route';

// ── Admin stub ──────────────────────────────────────────────────────

type OpLog = {
  callsInserts: Record<string, unknown>[];
  quotesInserts: Record<string, unknown>[];
  rpcCalls: { name: string; args: unknown }[];
  dedupeExisting: { id: string; status: string } | null;
  callsInsertResult: { data: { id: string } | null; error: unknown };
  quotesInsertResult: { error: unknown };
  rpcResult: { error: unknown };
};

function makeAdminStub(opts: Partial<OpLog> = {}): {
  client: {
    from: (t: string) => unknown;
    rpc: (name: string, args: unknown) => Promise<unknown>;
  };
  log: OpLog;
} {
  const log: OpLog = {
    callsInserts: [],
    quotesInserts: [],
    rpcCalls: [],
    dedupeExisting: null,
    callsInsertResult: { data: { id: 'call-inbound-0' }, error: null },
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

// ── Payload builder ─────────────────────────────────────────────────

function endOfCallReport(opts: {
  callId?: string;
  callerPhone?: string;
  transcript?: string | null;
  summary?: string | null;
  recordingUrl?: string | null;
  cost?: number | null;
  durationSeconds?: number | null;
  structuredData?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    message: {
      type: 'end-of-call-report',
      call: {
        id: opts.callId ?? 'vc-inbound-1',
        customer: { number: opts.callerPhone ?? '+14155550199' },
      },
      transcript: opts.transcript ?? 'I can do $600 Friday morning',
      summary: opts.summary ?? 'Contractor confirmed $600 Friday',
      recordingUrl: opts.recordingUrl ?? null,
      cost: opts.cost ?? 0.12,
      durationSeconds: opts.durationSeconds ?? 42,
      analysis: {
        structuredData: opts.structuredData ?? {},
      },
    },
  };
}

function makePost(payload: unknown): Request {
  return new Request('https://example.com/api/vapi/inbound-callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const BASE_MATCH = {
  businessId: 'biz-1',
  businessName: 'Acme Movers',
  quoteRequestId: 'qr-1',
  outboundCallId: 'call-outbound-1',
  categorySlug: 'moving',
  categoryName: 'Moving',
  extractionSchema: { price_anchors: '$500–$1500' },
};

const BASE_EXTRACTION_OK = {
  ok: true,
  quote: {
    priceMin: 600,
    priceMax: 600,
    priceDescription: '$600',
    availability: 'Friday morning',
    includes: ['2 movers', 'truck'],
    excludes: ['packing materials'],
    notes: null,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    requiresOnsiteEstimate: false,
    confidenceScore: 0.88,
  },
};

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/vapi/inbound-callback', () => {
  beforeEach(() => {
    matchInboundMock.mockReset();
    captureExceptionMock.mockReset();
    verifyResult = { ok: true };
    extractorImpl = () => Promise.resolve(BASE_EXTRACTION_OK);
    // Default admin: dedupe empty, inserts succeed, rpc succeeds.
    const { client } = makeAdminStub();
    adminClientImpl = client;
  });

  afterEach(() => {
    adminClientImpl = { from: () => ({}), rpc: () => Promise.resolve({}) };
    extractorImpl = () => Promise.resolve({ ok: false, reason: 'default' });
    verifyResult = { ok: true };
  });

  // Signature gate — belt-and-suspenders. The verifier has its own
  // test suite but we want one assertion here so a refactor that
  // drops the verify call shows up in THIS file's failure output.
  it('rejects with 401 when verifyVapiWebhook returns ok:false', async () => {
    verifyResult = { ok: false, error: 'bad-secret' };
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(401);
    // No downstream work should have been attempted.
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('ignores non end-of-call-report messages (status-update, etc.)', async () => {
    const res = await POST(
      makePost({ message: { type: 'status-update', call: { id: 'vc-1' } } })
    );
    expect(res.status).toBe(200);
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('returns 400 on missing call.id in an end-of-call-report', async () => {
    const res = await POST(
      makePost({
        message: {
          type: 'end-of-call-report',
          // no call.id and no top-level callId
          customer: { number: '+14155550199' },
        },
      })
    );
    expect(res.status).toBe(400);
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('returns 200 without inserting when caller phone is missing', async () => {
    // Defensive ignore — Vapi rarely delivers without a customer.number
    // but when it does we treat it as a no-op rather than pinging Sentry
    // on every orphan report.
    const res = await POST(
      makePost({
        message: {
          type: 'end-of-call-report',
          call: { id: 'vc-no-phone' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(matchInboundMock).not.toHaveBeenCalled();
  });

  it('is a no-op when no quote_request matches the caller phone (orphan)', async () => {
    // Per the route's docstring: orphan callbacks must 200 + no-op so
    // Vapi does not retry. No Sentry capture (null-match is documented
    // outcome, not an error).
    matchInboundMock.mockResolvedValueOnce(null);
    const { client, log } = makeAdminStub();
    adminClientImpl = client;
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(0);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the vapi_call_id has already been recorded (dedupe)', async () => {
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    const { client, log } = makeAdminStub({
      dedupeExisting: { id: 'call-prev-0', status: 'completed' },
    });
    adminClientImpl = client;
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(0);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('full-path: inserts calls + quotes + bumps counter with the canonical shapes', async () => {
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    extractorImpl = () => Promise.resolve(BASE_EXTRACTION_OK);
    const { client, log } = makeAdminStub();
    adminClientImpl = client;

    const res = await POST(
      makePost(
        endOfCallReport({
          callId: 'vc-inbound-ABC',
          callerPhone: '+14155550199',
          transcript: 'I can do $600 Friday morning',
          summary: 'Contractor confirmed $600 Friday',
          recordingUrl: 'https://recordings.vapi.ai/abc.mp3',
          cost: 0.12,
          durationSeconds: 42,
          structuredData: { price: 600 },
        })
      )
    );
    expect(res.status).toBe(200);

    // One calls insert with the canonical column set.
    expect(log.callsInserts).toHaveLength(1);
    const call = log.callsInserts[0];
    expect(call.quote_request_id).toBe('qr-1');
    expect(call.business_id).toBe('biz-1');
    expect(call.vapi_call_id).toBe('vc-inbound-ABC');
    expect(call.status).toBe('completed');
    expect(call.transcript).toBe('I can do $600 Friday morning');
    expect(call.summary).toBe('Contractor confirmed $600 Friday');
    expect(call.recording_url).toBe('https://recordings.vapi.ai/abc.mp3');
    expect(call.duration_seconds).toBe(42);
    expect(call.cost).toBe(0.12);
    expect(call.extracted_data).toEqual({ price: 600 });
    // Timestamps must be present as ISO strings (we don't assert exact
    // values — that would flake on test runtime — only the invariant
    // that both fields are populated).
    expect(typeof call.started_at).toBe('string');
    expect(typeof call.ended_at).toBe('string');

    // One quotes insert.
    expect(log.quotesInserts).toHaveLength(1);
    const q = log.quotesInserts[0];
    expect(q.call_id).toBe('call-inbound-0');
    expect(q.quote_request_id).toBe('qr-1');
    expect(q.business_id).toBe('biz-1');
    expect(q.price_min).toBe(600);
    expect(q.price_max).toBe(600);
    expect(q.price_description).toBe('$600');
    expect(q.availability).toBe('Friday morning');
    expect(q.includes).toEqual(['2 movers', 'truck']);
    expect(q.excludes).toEqual(['packing materials']);
    expect(q.requires_onsite_estimate).toBe(false);
    expect(q.confidence_score).toBe(0.88);

    // Counter bump fired with the canonical RPC + param name.
    expect(log.rpcCalls).toHaveLength(1);
    expect(log.rpcCalls[0].name).toBe('increment_quotes_collected');
    expect(log.rpcCalls[0].args).toEqual({ p_request_id: 'qr-1' });

    // Happy path — no Sentry pages.
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('persists calls audit row but skips quotes insert when extractor returns ok:false', async () => {
    // Low-confidence / no-price cases still deserve an audit trail
    // in `calls` (contractor did call back) but the quotes row must
    // NOT be inserted and the counter must NOT be bumped. A bogus
    // quote is strictly worse than a missing one — customers compare
    // prices, and comparing $0 against $800 would surface a broken
    // contractor.
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    extractorImpl = () =>
      Promise.resolve({ ok: false, reason: 'no price in transcript' });
    const { client, log } = makeAdminStub();
    adminClientImpl = client;
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(1);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('swallows 23505 on calls insert as race-idempotency and does not proceed', async () => {
    // Two Vapi retries race past the dedupe lookup at the same time;
    // the UNIQUE(vapi_call_id) constraint collapses them. One wins,
    // one gets 23505. The 23505 loser must NOT insert a quote or
    // bump the counter — the winner already did that.
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    const { client, log } = makeAdminStub({
      callsInsertResult: {
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      },
    });
    adminClientImpl = client;
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(1);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('swallows 23505 on quotes insert (second-retry race) and does not bump counter twice', async () => {
    // Race pattern at the quotes layer: the calls insert won (first
    // inserter) but a prior attempt already wrote the quotes row
    // under its own calls row. UNIQUE(call_id) or similar collapses
    // it. The counter bump MUST NOT fire — the earlier attempt did.
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    const { client, log } = makeAdminStub({
      quotesInsertResult: {
        error: { code: '23505', message: 'quotes_call_id_key' },
      },
    });
    adminClientImpl = client;
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(1);
    expect(log.quotesInserts).toHaveLength(1);
    expect(log.rpcCalls).toHaveLength(0); // CRITICAL: no double-bump
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures + 500s on non-23505 calls-insert errors', async () => {
    // A DB outage or relation-missing error is a real page. Route
    // returns 500 so Vapi retries (transient failures heal on retry;
    // the 23505 swallow above handles the dup case). Sentry sees it.
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    const { client, log } = makeAdminStub({
      callsInsertResult: {
        data: null,
        error: { code: '42P01', message: 'relation "calls" does not exist' },
      },
    });
    adminClientImpl = client;
    const res = await POST(
      makePost(endOfCallReport({ callId: 'vc-err-1' }))
    );
    expect(res.status).toBe(500);
    expect(log.quotesInserts).toHaveLength(0);
    expect(log.rpcCalls).toHaveLength(0);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect(ctx).toEqual({
      tags: { route: 'vapi/inbound-callback', vapiCallId: 'vc-err-1' },
    });
  });

  it('tolerates a missing increment_quotes_collected RPC (logs but keeps 200)', async () => {
    // If the RPC hasn't been deployed yet, the quote is safely
    // persisted and ops can reconcile the counter later. We log
    // but do NOT 500 — turning the webhook into a retry storm
    // over a missing helper function would be worse than a slightly
    // stale counter.
    matchInboundMock.mockResolvedValueOnce(BASE_MATCH);
    const { client, log } = makeAdminStub({
      rpcResult: {
        error: { code: '42883', message: 'function does not exist' },
      },
    });
    adminClientImpl = client;
    const res = await POST(makePost(endOfCallReport({})));
    expect(res.status).toBe(200);
    expect(log.callsInserts).toHaveLength(1);
    expect(log.quotesInserts).toHaveLength(1);
    expect(log.rpcCalls).toHaveLength(1);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
