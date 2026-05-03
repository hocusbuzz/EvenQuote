// Integration tests for the Stripe webhook handler.
//
// Strategy:
//   • Stub `@/lib/stripe/server` so we can forge Stripe events without
//     a signing secret.
//   • Stub the Supabase admin client — track insert calls and their
//     conflict behaviour from the test.
//   • Stub the post-payment and enqueue-calls modules so the handler
//     completes without trying to send a real email or enqueue real
//     outbound calls.
//
// Coverage targets:
//   • 400 on missing stripe-signature
//   • 400 on bad signature
//   • 500 when STRIPE_WEBHOOK_SECRET is missing
//   • 200 on duplicate event (idempotency via unique stripe_event_id)
//   • 200 with ignored note for unhandled event types
//   • 200 + handler side effects on checkout.session.completed

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Helpers ───────────────────────────────────────────────────────

function makeReq(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/stripe/webhook', {
    method: 'POST',
    headers: new Headers(headers),
    body,
  });
}

type InsertCall = {
  table: string;
  row: Record<string, unknown>;
};

function buildAdminStub(opts: {
  insertError?: { code?: string; message?: string } | null;
  updateRow?: { id: string; status: string; intake_data: unknown; city?: string; state?: string } | null;
  updateError?: { message: string } | null;
  inserts: InsertCall[];
}) {
  return {
    from: (table: string) => {
      if (table === 'payments') {
        return {
          insert: (row: Record<string, unknown>) => {
            opts.inserts.push({ table, row });
            return Promise.resolve({ error: opts.insertError ?? null });
          },
        };
      }
      if (table === 'quote_requests') {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: opts.updateRow ?? null,
                      error: opts.updateError ?? null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    },
  };
}

describe('POST /api/stripe/webhook', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      STRIPE_SECRET_KEY: 'sk_test_x',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc_test_key',
    };
  });

  it('returns 500 when STRIPE_WEBHOOK_SECRET is not set', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({ webhooks: { constructEvent: () => ({}) } }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}', { 'stripe-signature': 'whatever' }));
    expect(res.status).toBe(500);
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({ webhooks: { constructEvent: () => ({}) } }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/signature/i);
  });

  it('returns 400 on signature verification failure', async () => {
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => {
            throw new Error('No signatures found matching the expected signature');
          },
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{"tampered":true}', { 'stripe-signature': 'bad' }));
    expect(res.status).toBe(400);
  });

  it('acknowledges ignored event types with 200', async () => {
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_ignored',
            type: 'payment_intent.created',
            data: { object: {} },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.note).toMatch(/Ignored|Unhandled/);
  });

  it('returns 200 "duplicate" when payments insert hits unique violation', async () => {
    const inserts: InsertCall[] = [];
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_dup',
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_123',
                client_reference_id: 'req-123',
                payment_status: 'paid',
                amount_total: 999,
                currency: 'usd',
                payment_intent: 'pi_123',
                metadata: {},
                customer_details: {},
              },
            },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          insertError: { code: '23505', message: 'unique_violation' },
          inserts,
        }),
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.note).toMatch(/[Dd]uplicate/);
    // First (and only) insert on payments table should have happened.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('payments');
  });

  it('processes a fresh checkout.session.completed and runs side effects', async () => {
    const inserts: InsertCall[] = [];
    const sendMagic = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_new',
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_new',
                client_reference_id: 'req-new',
                payment_status: 'paid',
                amount_total: 999,
                currency: 'usd',
                payment_intent: 'pi_new',
                metadata: {},
                customer_details: { email: 'buyer@example.com' },
              },
            },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () =>
        buildAdminStub({
          insertError: null,
          updateRow: {
            id: 'req-new',
            status: 'paid',
            intake_data: { contact_email: 'buyer@example.com' },
            city: 'Austin',
            state: 'TX',
          },
          inserts,
        }),
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: sendMagic }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: enqueue }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    // #121 — webhook returns immediately; side effects run async via
    // waitUntil. Note flipped from 'Processed' → 'Processed (side effects async)'.
    expect(body.note).toBe('Processed (side effects async)');

    // Assertions on side effects
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.stripe_event_id).toBe('evt_new');
    expect(inserts[0].row.status).toBe('completed'); // NOT 'paid' — enum guard
    // sendPaymentMagicLink now also receives recipientName + categoryName
    // (read off intake_data.contact_name + service_categories.name) so
    // the magic-link email can address the customer by name and use a
    // vertical-specific subject line. Both default to null when the
    // joined row doesn't include them (this stub doesn't seed either).
    expect(sendMagic).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      requestId: 'req-new',
      recipientName: null,
      categoryName: null,
    });
    expect(enqueue).toHaveBeenCalledWith({ quoteRequestId: 'req-new' });
  });

  it('ignores sessions with no quote_request id', async () => {
    const inserts: InsertCall[] = [];
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_noref',
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_noref',
                client_reference_id: null,
                metadata: {},
                payment_status: 'paid',
                amount_total: 999,
                currency: 'usd',
              },
            },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({ inserts }),
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).toMatch(/No quote_request id/i);
    expect(inserts).toHaveLength(0);
  });

  it('skips processing when session.payment_status is not "paid"', async () => {
    const inserts: InsertCall[] = [];
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_unpaid',
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_unpaid',
                client_reference_id: 'req-unpaid',
                payment_status: 'unpaid',
                amount_total: 999,
                currency: 'usd',
                metadata: {},
              },
            },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => buildAdminStub({ inserts }),
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: vi.fn() }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: vi.fn() }));

    const mod = await import('./route');
    const res = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).toMatch(/payment_status=unpaid/);
    expect(inserts).toHaveLength(0);
  });

  // ─── Round 9: deliberate replay-protection coverage ────────────────
  //
  // Round 8 #4 follow-up. The earlier "duplicate" test simulates a
  // single insert returning 23505. This is a stronger end-to-end
  // scenario: the *same* signed event delivered twice in a row through
  // the route handler. The first call must process and run side effects;
  // the second call must dedup and run no side effects at all.
  //
  // This is what Stripe actually does in production when its delivery
  // pipeline recovers from a hiccup — it can re-fire an event we
  // already 200'd. If the handler ever loses idempotency we'd send the
  // magic link twice, enqueue calls twice, and double-bill the customer
  // in the worst case. So this test guards a lot.
  it('replayed checkout.session.completed: first call processes, second is a no-op', async () => {
    // Shared stateful admin stub: tracks every insert across both
    // handler calls. The unique-index behaviour is simulated by
    // returning 23505 if the same stripe_event_id is inserted twice.
    const inserts: InsertCall[] = [];
    const seenEventIds = new Set<string>();

    const sharedAdmin = {
      from: (table: string) => {
        if (table === 'payments') {
          return {
            insert: (row: Record<string, unknown>) => {
              const eventId = row.stripe_event_id as string;
              if (seenEventIds.has(eventId)) {
                // Don't push to inserts — the unique index would reject
                // before the row lands. We want inserts.length to
                // reflect successful inserts only.
                return Promise.resolve({
                  error: { code: '23505', message: 'unique_violation' },
                });
              }
              seenEventIds.add(eventId);
              inserts.push({ table, row });
              return Promise.resolve({ error: null });
            },
          };
        }
        if (table === 'quote_requests') {
          // First call returns the row; second call (re-fire) finds the
          // status already advanced beyond pending_payment, so the
          // .eq('status', 'pending_payment') filter matches nothing.
          // We model this by tracking how many update().eq().eq() chains
          // have completed.
          let updateCallCount = 0;
          return {
            update: () => ({
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: () => {
                      updateCallCount++;
                      if (updateCallCount === 1) {
                        return Promise.resolve({
                          data: {
                            id: 'req-replay',
                            status: 'paid',
                            intake_data: { contact_email: 'replay@example.com' },
                            city: 'Austin',
                            state: 'TX',
                          },
                          error: null,
                        });
                      }
                      // Subsequent calls: no row matched (status moved on).
                      return Promise.resolve({ data: null, error: null });
                    },
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const sendMagic = vi.fn().mockResolvedValue(undefined);
    const enqueue = vi.fn().mockResolvedValue(undefined);

    // Construct the same forged event twice from a constructEvent stub.
    const forgedEvent = {
      id: 'evt_replay_42',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_replay',
          client_reference_id: 'req-replay',
          payment_status: 'paid',
          amount_total: 999,
          currency: 'usd',
          payment_intent: 'pi_replay',
          metadata: {},
          customer_details: { email: 'replay@example.com' },
        },
      },
    };

    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: { constructEvent: () => forgedEvent },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => sharedAdmin,
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: sendMagic }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: enqueue }));

    const mod = await import('./route');

    // ── First delivery ────────────────────────────────────────────
    const res1 = await mod.POST(
      makeReq('{}', { 'stripe-signature': 't=1,v1=ok' })
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.received).toBe(true);
    // #121 — async side effects via waitUntil; note now includes the
    // suffix so it's grep-distinguishable in logs from the legacy
    // synchronous processing path.
    expect(body1.note).toBe('Processed (side effects async)');

    // ── Second delivery (Stripe re-fire of the same event) ────────
    const res2 = await mod.POST(
      makeReq('{}', { 'stripe-signature': 't=1,v1=ok' })
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.received).toBe(true);
    expect(body2.note).toMatch(/[Dd]uplicate/);

    // Critical invariants:
    //   • Only ONE row landed in payments (replay was deduped at the DB).
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.stripe_event_id).toBe('evt_replay_42');
    //   • Side effects only ran once. Magic link must NOT be sent twice
    //     (otherwise the customer's inbox gets two identical emails);
    //     enqueue must NOT fire twice (otherwise we'd dial each
    //     business twice for the same job).
    expect(sendMagic).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  // The replay scenario above asserts THIS particular event id is
  // deduped. This companion test asserts the dedup is keyed on
  // stripe_event_id specifically — so two distinct events for the
  // SAME checkout session (which Stripe can do during retries with
  // newly-issued event ids) both process. The unique index is on
  // event_id, not session_id, so the second one would be a real new
  // insert. This guards against a future "optimization" that swaps
  // the unique index to session_id and accidentally drops legitimate
  // events.
  //
  // Concretely: two checkout.session.completed events with different
  // ids but the same cs_… session id should each get a payments row.
  it('two distinct event ids for the same session both process', async () => {
    const inserts: InsertCall[] = [];
    const seenEventIds = new Set<string>();
    const sharedAdmin = {
      from: (table: string) => {
        if (table === 'payments') {
          return {
            insert: (row: Record<string, unknown>) => {
              const eventId = row.stripe_event_id as string;
              if (seenEventIds.has(eventId)) {
                return Promise.resolve({
                  error: { code: '23505', message: 'unique_violation' },
                });
              }
              seenEventIds.add(eventId);
              inserts.push({ table, row });
              return Promise.resolve({ error: null });
            },
          };
        }
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: 'req-distinct',
                        status: 'paid',
                        intake_data: { contact_email: 'd@example.com' },
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      },
    };

    let nextEventId = 'evt_first';
    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: nextEventId,
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_same_session',
                client_reference_id: 'req-distinct',
                payment_status: 'paid',
                amount_total: 999,
                currency: 'usd',
                payment_intent: 'pi_x',
                metadata: {},
                customer_details: { email: 'd@example.com' },
              },
            },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => sharedAdmin,
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({
      sendPaymentMagicLink: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({
      enqueueQuoteCalls: vi.fn().mockResolvedValue(undefined),
    }));

    const mod = await import('./route');

    nextEventId = 'evt_first';
    const r1 = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(r1.status).toBe(200);

    nextEventId = 'evt_second';
    const r2 = await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));
    expect(r2.status).toBe(200);

    // Both inserts landed — the dedup is per-event-id, not per-session.
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.row.stripe_event_id)).toEqual([
      'evt_first',
      'evt_second',
    ]);
  });

  // ── Retry-storm idempotency ─────────────────────────────────────
  //
  // Stripe's delivery model can produce bursts of the same event in
  // rapid succession (e.g. after our function cold-starts and they
  // retry 3 pending deliveries within 100ms). The dedup lives in the
  // unique index on payments.stripe_event_id — only the FIRST insert
  // wins; the rest hit the unique_violation branch and return 200
  // with note='Duplicate'.
  //
  // This test exercises 10 parallel POSTs of the exact same event and
  // asserts the at-most-once side-effect contract: one payments row,
  // one magic-link send, one call-queue enqueue. Anything more
  // represents a "customer gets 10 copies of the magic link" or
  // "each business gets called 10 times for the same job" bug —
  // both of which would be disasters in production.
  it('10 parallel same-event deliveries yield exactly one side-effect set', async () => {
    const inserts: InsertCall[] = [];
    const seenEventIds = new Set<string>();

    // The admin stub uses an in-memory Set to simulate the DB's unique
    // index on stripe_event_id. Concurrency safety here is the SAME
    // guarantee Postgres gives: Set.add is atomic in V8 single-thread,
    // and real Postgres serializes unique-index inserts under the same
    // event-id. The first request to check-and-add wins; every other
    // concurrent attempt sees the `has()` return true and branches to
    // the unique-violation response.
    const sharedAdmin = {
      from: (table: string) => {
        if (table === 'payments') {
          return {
            insert: (row: Record<string, unknown>) => {
              const eventId = row.stripe_event_id as string;
              if (seenEventIds.has(eventId)) {
                return Promise.resolve({
                  error: { code: '23505', message: 'unique_violation' },
                });
              }
              seenEventIds.add(eventId);
              inserts.push({ table, row });
              return Promise.resolve({ error: null });
            },
          };
        }
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: {
                        id: 'req-storm',
                        status: 'paid',
                        intake_data: { contact_email: 'storm@example.com' },
                      },
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      },
    };

    const sendMagic = vi.fn().mockResolvedValue(undefined);
    // #121 — async side effects now read enq.ok / enq.advanced; mock has
    // to return a shape that satisfies that read so the side-effects
    // pipeline doesn't crash before reaching this test's assertions.
    const enqueue = vi
      .fn()
      .mockResolvedValue({ ok: true, advanced: true, enqueued: 1, note: 'ok' });

    vi.doMock('@/lib/stripe/server', () => ({
      getStripe: () => ({
        webhooks: {
          constructEvent: () => ({
            id: 'evt_retry_storm_1',
            type: 'checkout.session.completed',
            data: {
              object: {
                id: 'cs_storm',
                client_reference_id: 'req-storm',
                payment_status: 'paid',
                amount_total: 999,
                currency: 'usd',
                payment_intent: 'pi_storm',
                metadata: {},
                customer_details: { email: 'storm@example.com' },
              },
            },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => sharedAdmin,
    }));
    vi.doMock('@/lib/actions/post-payment', () => ({ sendPaymentMagicLink: sendMagic }));
    vi.doMock('@/lib/queue/enqueue-calls', () => ({ enqueueQuoteCalls: enqueue }));
    // Step B (#121) — seedBusinessesForRequest runs before enqueue. The
    // sharedAdmin stub only services updates against quote_requests; the
    // seed helper would crash on its own .select() chain and fast-fail the
    // pipeline, blocking enqueue. Mock the seed to succeed.
    vi.doMock('@/lib/ingest/seed-on-demand', () => ({
      seedBusinessesForRequest: vi
        .fn()
        .mockResolvedValue({ ok: true, inserted: 0, skipped: 0 }),
    }));

    const mod = await import('./route');

    // Ten truly parallel POSTs. Promise.all schedules them all on the
    // same microtask tick, which is the closest JS can get to "all
    // arrive simultaneously." Real Stripe retries serialize at the
    // network layer but the in-function handling can overlap when a
    // cold-start burst lands.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }))
      )
    );

    // Every response is 200 — we never 5xx on a duplicate.
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // At-most-once side effects — the canonical retry-storm invariant.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.stripe_event_id).toBe('evt_retry_storm_1');
    expect(sendMagic).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // The other nine must have been deduped at the insert gate — exactly
    // 9 of them should carry a 'Duplicate' note in the response.
    const bodies = await Promise.all(results.map((r) => r.json()));
    const dupCount = bodies.filter((b) => /[Dd]uplicate/.test(String(b.note))).length;
    expect(dupCount).toBe(9);
  });

  // ── captureException tag-shape lockdown ──────────────────────────
  // Three capture sites in the stripe webhook handler:
  //   (a) outer try/catch — tags: { route, eventType, eventId }
  //   (b) sendPaymentMagicLink failure — tags: { route, site: 'magic-link', requestId }
  //   (c) enqueueQuoteCalls failure    — tags: { route, site: 'enqueue-calls', requestId }
  // All three must carry ONLY opaque identifiers (Stripe event ids,
  // request UUIDs) and never include customer email, phone, or name.
  // This block locks the canonical tag shape on (a) as the most
  // frequently-triggered site; (b) and (c) follow the same pattern —
  // the memory note references `lib/actions/post-payment.test.ts` and
  // `lib/queue/enqueue-calls.test.ts` for their lib-boundary capture.
  describe('captureException tag shape', () => {
    it('captures outer-catch with { route, eventType, eventId } and no PII', async () => {
      const captureExceptionMock = vi.fn();
      vi.doMock('@/lib/observability/sentry', () => ({
        captureException: (err: unknown, ctx?: unknown) =>
          captureExceptionMock(err, ctx),
      }));
      vi.doMock('@/lib/stripe/server', () => ({
        getStripe: () => ({
          webhooks: {
            constructEvent: () => ({
              id: 'evt_outer_catch',
              type: 'checkout.session.completed',
              data: {
                object: {
                  id: 'cs_outer',
                  client_reference_id: 'req-outer',
                  payment_status: 'paid',
                  amount_total: 999,
                  currency: 'usd',
                  payment_intent: 'pi_outer',
                  metadata: {},
                  // PII in the event body — must NOT leak into tags.
                  customer_details: {
                    email: 'leaky@example.com',
                    phone: '+14155550123',
                  },
                },
              },
            }),
          },
        }),
      }));
      // Force the outer handler into the catch by throwing from the
      // admin-client factory — the DB insert attempt becomes the
      // throw site.
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => {
          throw new Error('admin exploded leaky@example.com +14155550123');
        },
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn(),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn(),
      }));

      const mod = await import('./route');
      const res = await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok' })
      );
      expect(res.status).toBe(500);

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [err, ctx] = captureExceptionMock.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      // Canonical tag shape — route + event discriminators ONLY.
      expect(ctx).toEqual({
        tags: {
          route: 'stripe/webhook',
          eventType: 'checkout.session.completed',
          eventId: 'evt_outer_catch',
        },
      });
      // PII negative-assertion: even though the throw message contains
      // an email and a phone, the TAGS themselves must not. Sentry's
      // indexed tag search is the attack surface we're protecting.
      for (const v of Object.values((ctx as { tags: Record<string, string> }).tags)) {
        expect(v).not.toMatch(/@/);
        expect(v).not.toMatch(/\+?\d{10,}/);
      }
    });
  });

  // ── Drift detection (R27) ───────────────────────────────────────
  //
  // Sibling to R25's twilio/sms + vapi/inbound-callback and R26's
  // vapi/webhook drift suites. Stripe webhook is the last unprotected
  // external-webhook surface.
  //
  // Behavioral tests above prove the handler's semantics (idempotency,
  // side effects). They do NOT catch silent DB-shape drift: a migration
  // that renames `payments.stripe_event_id` → `stripe_evt_id` would
  // still let every test above pass (the stub's insert accepts any
  // row) while production would fail on the unique index lookup and
  // flood Stripe retries.
  //
  // Each test here locks an EXACT observable shape. Any rename
  // requires updating BOTH the route and this test — which is the
  // point. Targeted drift vectors:
  //
  //   • payments insert column-set rename or addition
  //     → dedup breaks silently (23505 branch stops firing) OR
  //       RLS blocks the new column OR Postgres rejects with 42703.
  //   • payments.status enum literal rename ('completed' → 'paid')
  //     → Postgres 22P02 invalid enum; every payment row vanishes.
  //       (This is the exact bug the route's own comments call out
  //       as a past production incident — the drift test guards the
  //       fix.)
  //   • quote_requests update filter drops `.eq('status',
  //     'pending_payment')` → webhook clobbers calls-in-flight rows
  //     (reverts 'calling' back to 'paid'), stalling the batch.
  //   • quote_requests select list drops `intake_data` → magic-link
  //     send uses session.customer_details.email only (still works
  //     for Stripe-provided but loses intake contact_email override).
  describe('drift detection (R27) — locks canonical DB shapes', () => {
    // Preceding captureException-shape block mocked the admin client
    // to throw. vi.doMock persists across vi.resetModules() (that's
    // how it's documented to behave), so the drift suite opens with
    // an explicit unmock + resetModules. Pattern from R26 vapi/webhook
    // drift suite; reuse so future drift blocks follow the same shape.
    beforeEach(() => {
      vi.doUnmock('@/lib/supabase/admin');
      vi.doUnmock('@/lib/stripe/server');
      vi.doUnmock('@/lib/actions/post-payment');
      vi.doUnmock('@/lib/queue/enqueue-calls');
      vi.resetModules();
    });

    type DriftTracker = {
      paymentsInserts: Record<string, unknown>[];
      quoteRequestsUpdates: Record<string, unknown>[];
      quoteRequestsFilters: Array<{ column: string; value: unknown }[]>;
      quoteRequestsSelect: string[];
    };

    function buildDriftAdminStub(opts: {
      insertError?: { code?: string; message?: string } | null;
      updateRow?: {
        id: string;
        status: string;
        intake_data: unknown;
        city?: string;
        state?: string;
      } | null;
      tracker: DriftTracker;
    }) {
      return {
        from: (table: string) => {
          if (table === 'payments') {
            return {
              insert: (row: Record<string, unknown>) => {
                opts.tracker.paymentsInserts.push(row);
                return Promise.resolve({ error: opts.insertError ?? null });
              },
            };
          }
          if (table === 'quote_requests') {
            const filters: { column: string; value: unknown }[] = [];
            const chain = {
              eq: (column: string, value: unknown) => {
                filters.push({ column, value });
                return chain;
              },
              select: (list: string) => {
                opts.tracker.quoteRequestsSelect.push(list);
                return {
                  maybeSingle: () => {
                    opts.tracker.quoteRequestsFilters.push(filters);
                    return Promise.resolve({
                      data: opts.updateRow ?? null,
                      error: null,
                    });
                  },
                };
              },
            };
            return {
              update: (patch: Record<string, unknown>) => {
                opts.tracker.quoteRequestsUpdates.push(patch);
                return chain;
              },
            };
          }
          return {};
        },
      };
    }

    const BASE_SESSION = {
      id: 'cs_drift',
      client_reference_id: 'req-drift',
      payment_status: 'paid',
      amount_total: 999,
      currency: 'usd',
      payment_intent: 'pi_drift',
      metadata: {},
      customer_details: { email: 'drift@example.com' },
    };

    function mockForgedEvent(eventId: string, overrides?: Record<string, unknown>) {
      vi.doMock('@/lib/stripe/server', () => ({
        getStripe: () => ({
          webhooks: {
            constructEvent: () => ({
              id: eventId,
              type: 'checkout.session.completed',
              data: {
                object: { ...BASE_SESSION, ...overrides },
              },
            }),
          },
        }),
      }));
    }

    it('payments insert carries EXACTLY the 8 canonical columns', async () => {
      const tracker: DriftTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
        quoteRequestsFilters: [],
        quoteRequestsSelect: [],
      };
      mockForgedEvent('evt_drift_cols');
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftAdminStub({
            updateRow: {
              id: 'req-drift',
              status: 'paid',
              intake_data: { contact_email: 'drift@example.com' },
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn().mockResolvedValue(undefined),
      }));

      const mod = await import('./route');
      const res = await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok' })
      );
      expect(res.status).toBe(200);

      // EXACT key set — migration that renames or adds a column must
      // also update this test. Set-equality (not superset).
      expect(tracker.paymentsInserts).toHaveLength(1);
      expect(new Set(Object.keys(tracker.paymentsInserts[0]))).toEqual(
        new Set([
          'user_id',
          'quote_request_id',
          'stripe_session_id',
          'stripe_payment_intent_id',
          'stripe_event_id',
          'amount',
          'currency',
          'status',
        ])
      );
      // Spot-check values to catch silent snake_case→camelCase
      // inversions or swapped slots.
      expect(tracker.paymentsInserts[0].quote_request_id).toBe('req-drift');
      expect(tracker.paymentsInserts[0].stripe_event_id).toBe('evt_drift_cols');
      expect(tracker.paymentsInserts[0].stripe_session_id).toBe('cs_drift');
      expect(tracker.paymentsInserts[0].stripe_payment_intent_id).toBe('pi_drift');
      expect(tracker.paymentsInserts[0].amount).toBe(999);
      expect(tracker.paymentsInserts[0].currency).toBe('usd');
      // Guest flow: user_id starts NULL. /claim backfills it.
      expect(tracker.paymentsInserts[0].user_id).toBeNull();
    });

    it('payments.status is the literal "completed" (NOT "paid" — enum regression guard)', async () => {
      // The route file's header explicitly documents that 'paid' is
      // NOT a valid payment_status enum value and earlier code writing
      // 'paid' here silently failed with Postgres 22P02 on every
      // insert. This test locks 'completed' as THE literal so a future
      // "cleanup" PR reverting to 'paid' breaks here, not in prod.
      const tracker: DriftTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
        quoteRequestsFilters: [],
        quoteRequestsSelect: [],
      };
      mockForgedEvent('evt_drift_status');
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftAdminStub({
            updateRow: {
              id: 'req-drift',
              status: 'paid',
              intake_data: {},
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn().mockResolvedValue(undefined),
      }));

      const mod = await import('./route');
      await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));

      expect(tracker.paymentsInserts[0].status).toBe('completed');
      // Negative: guard against re-introducing 'paid' by mistake.
      expect(tracker.paymentsInserts[0].status).not.toBe('paid');
    });

    it('quote_requests update filters on id AND status="pending_payment" (clobber guard)', async () => {
      // If the `.eq('status','pending_payment')` filter is dropped,
      // the webhook would clobber a row already advanced to 'calling'
      // back down to 'paid' — stalling the engine's batch.
      const tracker: DriftTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
        quoteRequestsFilters: [],
        quoteRequestsSelect: [],
      };
      mockForgedEvent('evt_drift_filter');
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftAdminStub({
            updateRow: {
              id: 'req-drift',
              status: 'paid',
              intake_data: {},
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn().mockResolvedValue(undefined),
      }));

      const mod = await import('./route');
      await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));

      // Update value: status flips to 'paid' (target enum literal).
      expect(tracker.quoteRequestsUpdates).toHaveLength(1);
      expect(tracker.quoteRequestsUpdates[0]).toEqual({ status: 'paid' });
      // Filter chain: TWO .eq() calls, on id then status='pending_payment'.
      expect(tracker.quoteRequestsFilters).toHaveLength(1);
      const filters = tracker.quoteRequestsFilters[0];
      expect(filters).toHaveLength(2);
      const filterMap = new Map(filters.map((f) => [f.column, f.value]));
      expect(filterMap.get('id')).toBe('req-drift');
      expect(filterMap.get('status')).toBe('pending_payment');
    });

    it('quote_requests select returns intake_data column (magic-link contact lookup guard)', async () => {
      // The handler reads `updated.intake_data.contact_email` to route
      // the magic link. If the select list drops `intake_data`, the
      // magic link falls back to session.customer_details.email only
      // — which works for most Stripe flows BUT loses any override
      // the intake form set (e.g. "send report to accounting@..." with
      // a different payer email). Lock the select shape.
      const tracker: DriftTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
        quoteRequestsFilters: [],
        quoteRequestsSelect: [],
      };
      mockForgedEvent('evt_drift_select');
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftAdminStub({
            updateRow: {
              id: 'req-drift',
              status: 'paid',
              intake_data: { contact_email: 'drift@example.com' },
            },
            tracker,
          }),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn().mockResolvedValue(undefined),
      }));

      const mod = await import('./route');
      await mod.POST(makeReq('{}', { 'stripe-signature': 't=1,v1=ok' }));

      expect(tracker.quoteRequestsSelect).toHaveLength(1);
      const selectList = tracker.quoteRequestsSelect[0];
      // Parse the comma-delimited list into a set for order-independence.
      const cols = new Set(selectList.split(',').map((c) => c.trim()));
      expect(cols.has('intake_data')).toBe(true);
      expect(cols.has('id')).toBe(true);
      expect(cols.has('status')).toBe(true);
    });

    it('23505 on payments insert swallows without firing side effects (dedup guard)', async () => {
      // Mirror of the behavioral duplicate test above, but asserting
      // the invariant at the drift layer: a 23505 on payments insert
      // MUST short-circuit before quote_requests.update OR any side
      // effect. A future refactor that moves the side-effect block
      // before the insert would silently regress this.
      const tracker: DriftTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
        quoteRequestsFilters: [],
        quoteRequestsSelect: [],
      };
      const sendMagic = vi.fn();
      const enqueue = vi.fn();
      mockForgedEvent('evt_drift_dedupe');
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () =>
          buildDriftAdminStub({
            insertError: { code: '23505', message: 'unique_violation' },
            tracker,
          }),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: sendMagic,
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: enqueue,
      }));

      const mod = await import('./route');
      const res = await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok' })
      );
      expect(res.status).toBe(200);
      // Insert was attempted...
      expect(tracker.paymentsInserts).toHaveLength(1);
      // ...but NOTHING downstream fired.
      expect(tracker.quoteRequestsUpdates).toHaveLength(0);
      expect(sendMagic).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Round 30 — idempotency-key drift under retry storm
  // ─────────────────────────────────────────────────────────────────
  //
  // R27's drift suite locked the 8-column set on the payments insert.
  // That pins the schema but does NOT prove that `stripe_event_id` is
  // the idempotency key Stripe retries deduplicate on. This suite
  // locks the retry-storm contract:
  //
  //   1. The column named `stripe_event_id` is what the insert path
  //      writes for dedupe. A rename to `event_id` or `idempotency_key`
  //      without updating the unique index would silently break
  //      dedupe — the old index still exists but the new code writes
  //      to a different column, so EVERY retry appears "new" and fires
  //      side effects N times per event.
  //
  //   2. Under a 20-retry storm (Stripe's observed worst case — they
  //      retry up to 72h on non-2xx, but during internal incidents
  //      they can re-deliver bursts), the side-effect block fires
  //      exactly ONCE. Magic link sent 20 times = 20 auth emails to
  //      the customer + 20 entries in Resend's rate-limit log.
  //
  //   3. The 23505 return note is the stable operator-facing string
  //      "Duplicate event — already processed". Operators may build
  //      dashboards or grep this; a "helpful" rewording would break
  //      downstream analytics.
  //
  //   4. Two DIFFERENT event IDs for the SAME session_id both attempt
  //      an insert (session_id is NOT the idempotency key). This
  //      catches a refactor that flips the dedupe semantics to
  //      session-level — which would silently drop the charge.succeeded
  //      / checkout.session.completed pair Stripe sometimes sends as
  //      separate events.

  describe('idempotency-key drift (R30) — retry-storm contract', () => {
    beforeEach(() => {
      vi.doUnmock('@/lib/supabase/admin');
      vi.doUnmock('@/lib/stripe/server');
      vi.doUnmock('@/lib/actions/post-payment');
      vi.doUnmock('@/lib/queue/enqueue-calls');
      vi.resetModules();
    });

    type IdemTracker = {
      paymentsInserts: Record<string, unknown>[];
      quoteRequestsUpdates: Record<string, unknown>[];
    };

    // A stateful stub that actually honors the unique-index semantic on
    // stripe_event_id. The first insert for a given event_id succeeds;
    // subsequent ones return { code: '23505' }. This lets us simulate
    // a real retry storm against the handler.
    //
    // NOTE: `seenEventIds` MUST be shared across every createAdminClient()
    // call within a single test — the route calls createAdminClient on
    // every request, so a per-stub state would reset per-request and
    // break the retry-storm simulation. We hoist it to a closure over
    // the stub factory.
    function buildStatefulAdminStub(
      tracker: IdemTracker,
      seenEventIds: Set<string>
    ) {
      return {
        from: (table: string) => {
          if (table === 'payments') {
            return {
              insert: (row: Record<string, unknown>) => {
                tracker.paymentsInserts.push(row);
                const eid = row.stripe_event_id as string | undefined;
                if (eid && seenEventIds.has(eid)) {
                  return Promise.resolve({
                    error: { code: '23505', message: 'unique_violation' },
                  });
                }
                if (eid) seenEventIds.add(eid);
                return Promise.resolve({ error: null });
              },
            };
          }
          if (table === 'quote_requests') {
            const chain = {
              eq: () => chain,
              select: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      id: 'req-storm',
                      status: 'paid',
                      intake_data: { contact_email: 'storm@example.com' },
                    },
                    error: null,
                  }),
              }),
            };
            return {
              update: (patch: Record<string, unknown>) => {
                tracker.quoteRequestsUpdates.push(patch);
                return chain;
              },
            };
          }
          return {};
        },
      };
    }

    const BASE_SESSION = {
      id: 'cs_storm',
      client_reference_id: 'req-storm',
      payment_status: 'paid',
      amount_total: 999,
      currency: 'usd',
      payment_intent: 'pi_storm',
      metadata: {},
      customer_details: { email: 'storm@example.com' },
    };

    function mockEventStreamByHeader() {
      // The webhook reads `stripe-signature` header — we can piggy-back
      // the event id there per-request by returning whatever the header
      // carries from constructEvent. Keeps the stub generic.
      vi.doMock('@/lib/stripe/server', () => ({
        getStripe: () => ({
          webhooks: {
            constructEvent: (_raw: string, sig: string) => {
              // Sig format: "t=1,v1=ok,eid=<event_id>,sid=<session_id>"
              const eidMatch = /eid=([^,]+)/.exec(sig);
              const sidMatch = /sid=([^,]+)/.exec(sig);
              const eventId = eidMatch?.[1] ?? 'evt_default';
              const sessionId = sidMatch?.[1] ?? BASE_SESSION.id;
              return {
                id: eventId,
                type: 'checkout.session.completed',
                data: {
                  object: { ...BASE_SESSION, id: sessionId },
                },
              };
            },
          },
        }),
      }));
    }

    it('locks `stripe_event_id` as the idempotency column name on the insert', async () => {
      // A rename/drift to `event_id`, `idempotency_key`, or
      // `stripe_id` without updating the unique index would silently
      // disable dedupe. Lock the exact column NAME at the row level.
      const tracker: IdemTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
      };
      const seen = new Set<string>();
      mockEventStreamByHeader();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildStatefulAdminStub(tracker, seen),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn(),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn(),
      }));

      const mod = await import('./route');
      await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_key_lock,sid=cs_a' })
      );

      expect(tracker.paymentsInserts).toHaveLength(1);
      const row = tracker.paymentsInserts[0];
      // Canonical column name must be `stripe_event_id`, value =
      // the event.id from constructEvent. Drift-detection: if the
      // handler starts writing to any other key, this fails.
      expect(Object.keys(row)).toContain('stripe_event_id');
      expect(row.stripe_event_id).toBe('evt_key_lock');
      // Negative lock: common refactor targets must NOT appear.
      expect(Object.keys(row)).not.toContain('event_id');
      expect(Object.keys(row)).not.toContain('idempotency_key');
      expect(Object.keys(row)).not.toContain('stripe_id');
    });

    it('20-retry storm of the same event.id fires side effects exactly ONCE', async () => {
      // Stripe's retry strategy can redeliver the same event repeatedly
      // during their infra incidents. A retry storm that bypassed
      // dedupe would send 20 magic-link emails + enqueue 20 call
      // batches. The handler MUST insert 20 times (attempting) but
      // succeed exactly once; side effects MUST fire exactly once.
      const tracker: IdemTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
      };
      const seen = new Set<string>();
      const sendMagic = vi.fn();
      const enqueue = vi.fn();
      mockEventStreamByHeader();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildStatefulAdminStub(tracker, seen),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: sendMagic,
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: enqueue,
      }));

      const mod = await import('./route');
      // 20 sequential deliveries of the same event.id.
      for (let i = 0; i < 20; i++) {
        await mod.POST(
          makeReq('{}', {
            'stripe-signature': 't=1,v1=ok,eid=evt_storm,sid=cs_storm',
          })
        );
      }

      // Every retry attempted the insert (real retry hits the DB) ...
      expect(tracker.paymentsInserts).toHaveLength(20);
      // ... but only ONE succeeded, so status-update ran once ...
      expect(tracker.quoteRequestsUpdates).toHaveLength(1);
      // ... and side effects fired exactly once.
      expect(sendMagic).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('returns the stable "Duplicate event — already processed" note on retry', async () => {
      // Operators may alert on this literal string (or greplog on it).
      // A well-meaning rewording would break dashboards. Lock it.
      const tracker: IdemTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
      };
      const seen = new Set<string>();
      mockEventStreamByHeader();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildStatefulAdminStub(tracker, seen),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn(),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn(),
      }));

      const mod = await import('./route');
      // First delivery processes.
      const first = await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_note,sid=cs_note' })
      );
      const firstBody = (await first.json()) as { note?: string };
      // #121 — webhook returns the async-side-effects suffix.
      expect(firstBody.note).toBe('Processed (side effects async)');

      // Retry: note flips to the locked "duplicate" string.
      const retry = await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_note,sid=cs_note' })
      );
      expect(retry.status).toBe(200);
      const retryBody = (await retry.json()) as { note?: string };
      expect(retryBody.note).toBe('Duplicate event — already processed');
    });

    it('two DIFFERENT event ids with the SAME session id BOTH attempt to insert', async () => {
      // Dedupe is event-scoped, not session-scoped. Stripe's event
      // graph for a single session can emit checkout.session.completed
      // + charge.succeeded + payment_intent.succeeded, each with
      // distinct event ids. (We ignore the latter two by event type,
      // but that's a separate guard.) If a refactor keyed idempotency
      // on session_id, legitimate distinct events for the same session
      // would silently merge.
      const tracker: IdemTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
      };
      const seen = new Set<string>();
      mockEventStreamByHeader();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildStatefulAdminStub(tracker, seen),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn(),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn(),
      }));

      const mod = await import('./route');
      await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_A,sid=cs_shared' })
      );
      await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_B,sid=cs_shared' })
      );

      // Both events attempted the insert — stateful stub confirms it
      // keyed dedupe on stripe_event_id, not stripe_session_id.
      expect(tracker.paymentsInserts).toHaveLength(2);
      // The two rows share a session_id but differ on event_id.
      expect(tracker.paymentsInserts[0].stripe_session_id).toBe('cs_shared');
      expect(tracker.paymentsInserts[1].stripe_session_id).toBe('cs_shared');
      expect(tracker.paymentsInserts[0].stripe_event_id).toBe('evt_A');
      expect(tracker.paymentsInserts[1].stripe_event_id).toBe('evt_B');
    });

    it('retry storm does NOT re-run the quote_requests status update after dedupe', async () => {
      // The R27 suite locked that quote_requests.update filters on
      // status='pending_payment' to avoid clobbering 'calling'. R30
      // locks the upstream guarantee: a retry that hits 23505 must
      // short-circuit BEFORE the update runs at all, regardless of
      // the filter. Two layers of defense — if someone removes the
      // status filter, this test still catches silent retries.
      const tracker: IdemTracker = {
        paymentsInserts: [],
        quoteRequestsUpdates: [],
      };
      const seen = new Set<string>();
      mockEventStreamByHeader();
      vi.doMock('@/lib/supabase/admin', () => ({
        createAdminClient: () => buildStatefulAdminStub(tracker, seen),
      }));
      vi.doMock('@/lib/actions/post-payment', () => ({
        sendPaymentMagicLink: vi.fn(),
      }));
      vi.doMock('@/lib/queue/enqueue-calls', () => ({
        enqueueQuoteCalls: vi.fn(),
      }));

      const mod = await import('./route');
      // First call: update runs once.
      await mod.POST(
        makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_guard,sid=cs_guard' })
      );
      expect(tracker.quoteRequestsUpdates).toHaveLength(1);

      // 5 retries: update count MUST stay at 1.
      for (let i = 0; i < 5; i++) {
        await mod.POST(
          makeReq('{}', { 'stripe-signature': 't=1,v1=ok,eid=evt_guard,sid=cs_guard' })
        );
      }
      expect(tracker.quoteRequestsUpdates).toHaveLength(1);
    });
  });
});
