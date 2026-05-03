// Tests for submitMovingIntake — the server action that persists a
// validated moving intake and returns the new quote_request id.
//
// Stubs: next/headers, @/lib/auth (getUser), and @/lib/supabase/admin.
// The zod schema (MovingIntakeSchema) and real rate-limiter are exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared spy for the observability boundary. Module-level so helpers
// below can assert against it without re-wiring per-test. Reset in
// beforeEach like the other mocks.
const captureExceptionMock = vi.fn();

function mockHeaders(ip: string) {
  vi.doMock('next/headers', () => ({
    headers: () => ({
      get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? ip : null),
    }),
  }));
}

function mockGetUser(user: { id: string } | null) {
  vi.doMock('@/lib/auth', () => ({
    getUser: vi.fn().mockResolvedValue(user),
  }));
}

type CategoryResult = { data: { id: string } | null; error: unknown };
type InsertResult = { data: { id: string } | null; error: unknown };

function mockAdmin(cat: CategoryResult, ins: InsertResult) {
  const insertSpy = vi.fn((_row: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve(ins),
    }),
  }));
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'service_categories') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () => Promise.resolve(cat),
                }),
              }),
            }),
          };
        }
        if (table === 'quote_requests') {
          return { insert: insertSpy };
        }
        throw new Error(`unexpected table ${table}`);
      },
    }),
  }));
  return { insertSpy };
}

// Use an ISO date > today (robust even if this suite runs over midnight).
const FUTURE_ISO = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

const VALID_MOVING_INPUT = {
  origin_address: '123 Main St',
  origin_city: 'Austin',
  origin_state: 'TX',
  origin_zip: '78701',
  destination_address: '456 Oak Ave',
  destination_city: 'Denver',
  destination_state: 'CO',
  destination_zip: '80202',
  home_size: '2 bedroom',
  move_date: FUTURE_ISO,
  flexible_dates: false,
  special_items: [],
  contact_name: 'Alice Example',
  contact_phone: '555-123-4567',
  contact_email: 'alice@example.com',
};

function mockSentry() {
  // Re-registered per test because vi.resetModules() below clears the
  // module cache and re-evaluates the doMock factory on next import().
  vi.doMock('@/lib/observability/sentry', () => ({
    captureException: (err: unknown, ctx?: unknown) =>
      captureExceptionMock(err, ctx),
    captureMessage: vi.fn(),
    init: vi.fn(),
    isEnabled: () => false,
    setUser: vi.fn(),
    __resetForTests: vi.fn(),
  }));
}

describe('submitMovingIntake', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    mockSentry();
  });

  it('returns fieldErrors on a zod validation failure without hitting the DB', async () => {
    mockHeaders(`7.7.1.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-1' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake({ ...VALID_MOVING_INPUT, contact_email: 'not-an-email' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.fieldErrors).toBeDefined();
      expect(res.fieldErrors?.['contact_email']).toMatch(/email/i);
    }
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rejects move_date in the past', async () => {
    mockHeaders(`7.7.2.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-1' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake({ ...VALID_MOVING_INPUT, move_date: '2020-01-01' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors?.['move_date']).toMatch(/today or in the future/i);
  });

  it('persists to DB and returns the new request id on valid input', async () => {
    mockHeaders(`7.7.3.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-new' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.requestId).toBe('qr-new');
    expect(insertSpy).toHaveBeenCalledOnce();

    const row = insertSpy.mock.calls[0][0];
    expect(row.user_id).toBeNull(); // guest flow
    expect(row.category_id).toBe('cat-mov');
    expect(row.status).toBe('pending_payment');
    // Primary row location is destination
    expect(row.city).toBe('Denver');
    expect(row.state).toBe('CO');
    expect(row.zip_code).toBe('80202');
    // Full payload is preserved in intake_data
    const intake = row.intake_data as Record<string, unknown>;
    expect(intake.contact_email).toBe('alice@example.com');
    expect(intake.origin_zip).toBe('78701');
  });

  it('attaches user_id when the submitter is signed in', async () => {
    mockHeaders(`7.7.4.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser({ id: 'user-abc' });
    const { insertSpy } = mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-2' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(res.ok).toBe(true);
    const row = insertSpy.mock.calls[0][0];
    expect(row.user_id).toBe('user-abc');
  });

  it('returns a generic error when the moving category is missing', async () => {
    mockHeaders(`7.7.5.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: null, error: { message: 'no rows' } },
      { data: { id: 'qr-3' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unavailable/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns a retry-safe error when the DB insert fails', async () => {
    mockHeaders(`7.7.6.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: null, error: { message: 'constraint violation' } }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // User-facing message must NOT include DB error details
      expect(res.error).not.toContain('constraint');
      expect(res.error).toMatch(/could not save/i);
    }
  });

  // ── Round 29 observability contract ──
  //
  // Pre-R29 the two DB error paths (category lookup + request insert)
  // were log-only. A Supabase permission-denied on insert would silently
  // return generic "Could not save" to every intake submitter with zero
  // Sentry visibility — a full intake outage invisible until the first
  // angry email. Lock the lib-boundary captureException contract here:
  // - captures fire with `{lib:'intake', reason, vertical:'moving'}`
  // - happy paths do NOT capture
  // - "category missing but no DB error" does NOT capture (config state,
  //   not an incident — capturing would flood on intentional pauses)
  // - PII (email/phone/name/address/user_id) never leaks to tags/message

  it('captures categoryLookupFailed at the lib boundary when DB errors', async () => {
    mockHeaders(`7.7.8.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: null, error: { message: 'permission denied for service_categories' } },
      { data: { id: 'qr-x' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);

    expect(res.ok).toBe(false);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^intake categoryLookupFailed:/);
    expect((err as Error).message).toMatch(/permission denied/);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'intake',
        reason: 'categoryLookupFailed',
        vertical: 'moving',
      },
    });
  });

  it('does NOT capture when the category row is simply missing (no DB error)', async () => {
    // is_active=false or a renamed slug returns {data:null, error:null}
    // — that's a config state, not an incident. If we captured here we'd
    // flood Sentry whenever an ops person pauses a vertical.
    mockHeaders(`7.7.9.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: null, error: null },
      { data: { id: 'qr-x' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);

    expect(res.ok).toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures insertFailed at the lib boundary on a real DB error', async () => {
    mockHeaders(`7.7.10.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: null, error: { message: 'new row violates check constraint' } }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);

    expect(res.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^intake insertFailed:/);
    expect((err as Error).message).toMatch(/check constraint/);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'intake',
        reason: 'insertFailed',
        vertical: 'moving',
      },
    });
  });

  it('happy path does not capture anything', async () => {
    mockHeaders(`7.7.11.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-ok' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake(VALID_MOVING_INPUT);

    expect(res.ok).toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('zod-validation-failure does not capture (user error, not server)', async () => {
    // Bad client input should never page the on-call. This is the kind
    // of noise that makes engineers mute Sentry alerts.
    mockHeaders(`7.7.12.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-ok' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');
    const res = await submitMovingIntake({
      ...VALID_MOVING_INPUT,
      contact_email: 'not-an-email',
    });

    expect(res.ok).toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT leak PII into tags or message on either capture path', async () => {
    // Tag values are indexed for search; the blast radius of a tag-level
    // leak is wider than a message leak. Lock both surfaces here.
    const PII_VALUES = [
      VALID_MOVING_INPUT.contact_email,
      VALID_MOVING_INPUT.contact_phone,
      VALID_MOVING_INPUT.contact_name,
      VALID_MOVING_INPUT.origin_address,
      VALID_MOVING_INPUT.destination_address,
    ];

    // Path 1: category lookup
    mockHeaders(`7.7.13.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser({ id: 'user-secret-abc-123' });
    mockAdmin(
      { data: null, error: { message: 'permission denied' } },
      { data: null, error: null }
    );
    const { submitMovingIntake: sub1 } = await import('./intake');
    await sub1(VALID_MOVING_INPUT);

    // Path 2: insert
    vi.resetModules();
    captureExceptionMock.mockReset();
    mockSentry();
    mockHeaders(`7.7.14.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser({ id: 'user-secret-abc-123' });
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: null, error: { message: 'db down' } }
    );
    const { submitMovingIntake: sub2 } = await import('./intake');
    await sub2(VALID_MOVING_INPUT);

    // Both paths should have captured; iterate all calls and assert no
    // PII leaked into the serialized capture context (tags, extras, or
    // error message).
    for (const call of captureExceptionMock.mock.calls) {
      const [err, ctx] = call;
      const serialized = JSON.stringify({
        msg: (err as Error).message,
        ctx,
      });
      for (const pii of PII_VALUES) {
        expect(
          serialized.includes(pii),
          `PII leaked: ${pii} found in capture`
        ).toBe(false);
      }
      // user_id specifically: must not appear in tags (user-level
      // correlation belongs on Sentry's user scope, not tag facets).
      expect(serialized).not.toMatch(/user-secret-abc-123/);
    }
  });

  it('regression: reason is one of the locked values, no catch-all drift', async () => {
    const allowed = new Set(['categoryLookupFailed', 'insertFailed']);
    const forbidden = new Set([
      'unknown',
      'error',
      'failed',
      'dbError',
      'queryFailed',
    ]);

    // Path 1
    mockHeaders(`7.7.15.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: null, error: { message: 'x' } },
      { data: null, error: null }
    );
    const { submitMovingIntake: sub1 } = await import('./intake');
    await sub1(VALID_MOVING_INPUT);

    // Path 2
    vi.resetModules();
    mockSentry();
    mockHeaders(`7.7.16.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: null, error: { message: 'y' } }
    );
    const { submitMovingIntake: sub2 } = await import('./intake');
    await sub2(VALID_MOVING_INPUT);

    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    for (const call of captureExceptionMock.mock.calls) {
      const [, ctx] = call;
      const reason = (ctx as { tags: { reason: string } }).tags.reason;
      expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
      expect(forbidden.has(reason), `disallowed reason: ${reason}`).toBe(false);
    }
  });

  it('rate-limits to 10/min/IP', async () => {
    const ip = `7.7.7.${Math.floor(Math.random() * 254) + 1}`;
    mockHeaders(ip);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-rl' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');

    // Use a distinct email per call: an additional per-email throttle
    // (5/day) was added after this test was written; sharing a single
    // email across 10 IP-bound calls trips the email throttle long
    // before the IP throttle is exercised.
    for (let i = 0; i < 10; i++) {
      const r = await submitMovingIntake({
        ...VALID_MOVING_INPUT,
        contact_email: `alice+rl${i}@example.com`,
      });
      expect(r.ok).toBe(true);
    }
    const blocked = await submitMovingIntake({
      ...VALID_MOVING_INPUT,
      contact_email: `alice+rl-blocked@example.com`,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/too many requests/i);
  });
});
