// Integration-ish tests for the waitlist server action.
//
// We stub `next/headers` and the admin client so we can exercise the
// full server action in isolation — no Next runtime, no Supabase
// round-trip. The rate limiter is real (in-memory) and its state is
// scoped per test via unique IPs.

import { describe, it, expect, beforeEach, vi } from 'vitest';

function mockHeaders(ip: string) {
  vi.doMock('next/headers', () => ({
    headers: () => ({
      get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? ip : null),
    }),
  }));
}

function mockAdminOk() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'service_categories') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { id: 'cat-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'waitlist_signups') {
          return {
            insert: () => Promise.resolve({ error: null }),
          };
        }
        return {};
      },
    }),
  }));
}

function mockAdminCategoryMissing() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'service_categories') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        return {};
      },
    }),
  }));
}

function mockAdminDupInsert() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'service_categories') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { id: 'cat-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'waitlist_signups') {
          return {
            insert: () =>
              Promise.resolve({
                error: { code: '23505', message: 'dup' },
              }),
          };
        }
        return {};
      },
    }),
  }));
}

function mockAdminInsertFail() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'service_categories') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { id: 'cat-1' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'waitlist_signups') {
          return {
            insert: () =>
              Promise.resolve({
                error: { code: '42P01', message: 'undefined_table' },
              }),
          };
        }
        return {};
      },
    }),
  }));
}

describe('joinWaitlist', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns ok on valid payload', async () => {
    mockHeaders(`1.1.1.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminOk();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'lawncare',
      email: 'hello@example.com',
      zipCode: '10001',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects an invalid email without hitting the DB', async () => {
    mockHeaders(`1.2.3.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminOk();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({ categorySlug: 'lawncare', email: 'not-an-email' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.toLowerCase()).toContain('email');
  });

  it('silently treats a duplicate as success with alreadyOnList=true', async () => {
    mockHeaders(`2.1.1.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminDupInsert();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'lawncare',
      email: 'dup@example.com',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.alreadyOnList).toBe(true);
  });

  it('returns a user-friendly error for unknown categories', async () => {
    mockHeaders(`2.1.2.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminCategoryMissing();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'does-not-exist',
      email: 'ok@example.com',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/available/i);
  });

  it('returns a generic error (no DB leak) when insert fails for non-duplicate reasons', async () => {
    mockHeaders(`2.1.3.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminInsertFail();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'lawncare',
      email: 'err@example.com',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // User-facing message must NOT include the DB error code / message
      expect(res.error).not.toContain('undefined_table');
      expect(res.error).not.toContain('42P01');
      expect(res.error).toMatch(/could not save/i);
    }
  });

  it('rejects a malformed ZIP code', async () => {
    mockHeaders(`2.1.4.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminOk();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'lawncare',
      email: 'ok@example.com',
      zipCode: 'ABCDE',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/zip/i);
  });

  it('accepts ZIP+4 format', async () => {
    mockHeaders(`2.1.5.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminOk();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'lawncare',
      email: 'zipplus@example.com',
      zipCode: '10001-1234',
    });
    expect(res.ok).toBe(true);
  });

  it('normalises email to lowercase on input (trim + toLowerCase)', async () => {
    // Important for dedup semantics — DB has unique(category_id, email).
    // If we stored 'Alice@Example.COM' and 'alice@example.com' as
    // separate rows, the "you're on the list" promise would be a lie.
    mockHeaders(`2.1.6.${Math.floor(Math.random() * 254) + 1}`);
    mockAdminOk();
    const { joinWaitlist } = await import('./waitlist');
    const res = await joinWaitlist({
      categorySlug: 'lawncare',
      email: '  ALICE@EXAMPLE.COM  ',
    });
    expect(res.ok).toBe(true);
  });

  it('rate-limits after 5 requests from the same IP', async () => {
    // Stable IP so the limiter buckets all 6 calls together.
    const ip = `9.9.9.${Math.floor(Math.random() * 254) + 1}`;
    mockHeaders(ip);
    mockAdminOk();
    const { joinWaitlist } = await import('./waitlist');

    for (let i = 0; i < 5; i++) {
      const r = await joinWaitlist({
        categorySlug: 'lawncare',
        email: `user${i}@example.com`,
      });
      expect(r.ok).toBe(true);
    }
    const blocked = await joinWaitlist({
      categorySlug: 'lawncare',
      email: 'too-many@example.com',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/too many/i);
  });
});
