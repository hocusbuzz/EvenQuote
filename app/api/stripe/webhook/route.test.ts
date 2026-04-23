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
    expect(body.note).toBe('Processed');

    // Assertions on side effects
    expect(inserts).toHaveLength(1);
    expect(inserts[0].row.stripe_event_id).toBe('evt_new');
    expect(inserts[0].row.status).toBe('completed'); // NOT 'paid' — enum guard
    expect(sendMagic).toHaveBeenCalledWith({
      email: 'buyer@example.com',
      requestId: 'req-new',
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
    expect(body1.note).toBe('Processed');

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
});
