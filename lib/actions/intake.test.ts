// Tests for submitMovingIntake — the server action that persists a
// validated moving intake and returns the new quote_request id.
//
// Stubs: next/headers, @/lib/auth (getUser), and @/lib/supabase/admin.
// The zod schema (MovingIntakeSchema) and real rate-limiter are exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

describe('submitMovingIntake', () => {
  beforeEach(() => {
    vi.resetModules();
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

  it('rate-limits to 10/min/IP', async () => {
    const ip = `7.7.7.${Math.floor(Math.random() * 254) + 1}`;
    mockHeaders(ip);
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-rl' }, error: null }
    );
    const { submitMovingIntake } = await import('./intake');

    for (let i = 0; i < 10; i++) {
      const r = await submitMovingIntake(VALID_MOVING_INPUT);
      expect(r.ok).toBe(true);
    }
    const blocked = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/too many requests/i);
  });
});
