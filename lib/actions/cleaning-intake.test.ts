// Tests for submitCleaningIntake — parallels intake.test.ts.
// Same shape, different vertical: the intake maps city/state/zip
// straight onto the quote_requests row rather than destination_*.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

const FUTURE_ISO = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

const VALID_CLEANING_INPUT = {
  address: '789 Pine St',
  city: 'Seattle',
  state: 'WA',
  zip: '98101',
  home_size: '3 bedroom',
  bathrooms: '2',
  cleaning_type: 'Standard',
  frequency: 'One-time',
  earliest_date: FUTURE_ISO,
  extras: [],
  contact_name: 'Bob Example',
  contact_phone: '206-555-0100',
  contact_email: 'bob@example.com',
};

function mockSentry() {
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

describe('submitCleaningIntake', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    mockSentry();
  });

  it('returns fieldErrors on zod failure (bad zip)', async () => {
    mockHeaders(`8.8.1.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-1' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake({ ...VALID_CLEANING_INPUT, zip: '123' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.fieldErrors?.['zip']).toMatch(/5-digit/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('persists to DB, mapping location directly to city/state/zip_code', async () => {
    mockHeaders(`8.8.2.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-new' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.requestId).toBe('qr-new');

    const row = insertSpy.mock.calls[0][0];
    expect(row.user_id).toBeNull();
    expect(row.category_id).toBe('cat-cln');
    expect(row.status).toBe('pending_payment');
    expect(row.city).toBe('Seattle');
    expect(row.state).toBe('WA');
    expect(row.zip_code).toBe('98101');
    const intake = row.intake_data as Record<string, unknown>;
    expect(intake.address).toBe('789 Pine St');
    expect(intake.contact_email).toBe('bob@example.com');
  });

  it('attaches user_id when signed in', async () => {
    mockHeaders(`8.8.3.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser({ id: 'user-xyz' });
    const { insertSpy } = mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-2' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(res.ok).toBe(true);
    const row = insertSpy.mock.calls[0][0];
    expect(row.user_id).toBe('user-xyz');
  });

  it('returns a generic error if cleaning category missing', async () => {
    mockHeaders(`8.8.4.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: null, error: { message: 'no rows' } },
      { data: { id: 'qr-3' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unavailable/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns a retry-safe error when the insert fails', async () => {
    mockHeaders(`8.8.5.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: null, error: { message: 'fk violation' } }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain('fk');
      expect(res.error).toMatch(/could not save/i);
    }
  });

  // ── Round 29 observability contract (parallels intake.test.ts) ──

  it('captures categoryLookupFailed at the lib boundary when DB errors', async () => {
    mockHeaders(`8.8.7.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    const { insertSpy } = mockAdmin(
      { data: null, error: { message: 'permission denied for service_categories' } },
      { data: { id: 'qr-x' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);

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
        vertical: 'cleaning',
      },
    });
  });

  it('does NOT capture when the category row is simply missing (no DB error)', async () => {
    mockHeaders(`8.8.8.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: null, error: null },
      { data: { id: 'qr-x' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);

    expect(res.ok).toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures insertFailed at the lib boundary on a real DB error', async () => {
    mockHeaders(`8.8.9.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: null, error: { message: 'new row violates check constraint' } }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);

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
        vertical: 'cleaning',
      },
    });
  });

  it('happy path does not capture anything', async () => {
    mockHeaders(`8.8.10.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-ok' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake(VALID_CLEANING_INPUT);

    expect(res.ok).toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('zod-validation-failure does not capture (user error, not server)', async () => {
    mockHeaders(`8.8.11.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-ok' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    const res = await submitCleaningIntake({
      ...VALID_CLEANING_INPUT,
      zip: 'not-a-zip',
    });

    expect(res.ok).toBe(false);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT leak PII into tags or message on either capture path', async () => {
    const PII_VALUES = [
      VALID_CLEANING_INPUT.contact_email,
      VALID_CLEANING_INPUT.contact_phone,
      VALID_CLEANING_INPUT.contact_name,
      VALID_CLEANING_INPUT.address,
    ];

    mockHeaders(`8.8.12.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser({ id: 'user-secret-xyz-789' });
    mockAdmin(
      { data: null, error: { message: 'permission denied' } },
      { data: null, error: null }
    );
    const { submitCleaningIntake: sub1 } = await import('./cleaning-intake');
    await sub1(VALID_CLEANING_INPUT);

    vi.resetModules();
    captureExceptionMock.mockReset();
    mockSentry();
    mockHeaders(`8.8.13.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser({ id: 'user-secret-xyz-789' });
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: null, error: { message: 'db down' } }
    );
    const { submitCleaningIntake: sub2 } = await import('./cleaning-intake');
    await sub2(VALID_CLEANING_INPUT);

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
      expect(serialized).not.toMatch(/user-secret-xyz-789/);
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

    mockHeaders(`8.8.14.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: null, error: { message: 'x' } },
      { data: null, error: null }
    );
    const { submitCleaningIntake: sub1 } = await import('./cleaning-intake');
    await sub1(VALID_CLEANING_INPUT);

    vi.resetModules();
    mockSentry();
    mockHeaders(`8.8.15.${Math.floor(Math.random() * 254) + 1}`);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: null, error: { message: 'y' } }
    );
    const { submitCleaningIntake: sub2 } = await import('./cleaning-intake');
    await sub2(VALID_CLEANING_INPUT);

    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    for (const call of captureExceptionMock.mock.calls) {
      const [, ctx] = call;
      const reason = (ctx as { tags: { reason: string } }).tags.reason;
      expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
      expect(forbidden.has(reason), `disallowed reason: ${reason}`).toBe(false);
    }
  });

  it('rate-limits to 10/min/IP', async () => {
    const ip = `8.8.6.${Math.floor(Math.random() * 254) + 1}`;
    mockHeaders(ip);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-rl' }, error: null }
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');
    for (let i = 0; i < 10; i++) {
      const r = await submitCleaningIntake(VALID_CLEANING_INPUT);
      expect(r.ok).toBe(true);
    }
    const blocked = await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/too many requests/i);
  });
});
