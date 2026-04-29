// R35 rate-limit boundary audit for intake server actions.
//
// `submitMovingIntake` and `submitCleaningIntake` are the two
// attacker-controlled entry points in the entire app that don't
// require a webhook signature. Every other unauthenticated POST
// surface (Stripe, Vapi, Twilio webhooks) authenticates via signed
// payload before doing any work. The intake actions authenticate
// nothing — by design, since the marketing flow needs guest
// submissions.
//
// That makes the rate-limit assertion the ONLY barrier between an
// attacker and (a) free Supabase quota burn, (b) free
// `service_categories` lookups (cheap but still I/O), (c) free
// `quote_requests` rows in `pending_payment` state. Without it,
// a determined attacker could stuff the table with garbage rows
// at line speed.
//
// The per-action tests already lock the basic 10/min/IP behaviour.
// This audit locks the SHAPE of the rate-limit boundary itself:
//
//   1. Rate-limit fires BEFORE zod validation. If zod ran first,
//      an attacker could spam invalid payloads faster than the
//      limiter blocks them, exhausting the limiter's per-key
//      window-counter math. The current code rate-limits at step
//      0, before validation at step 1.
//
//   2. Rate-limit fires BEFORE the DB category lookup. Otherwise
//      the limiter would only protect the quote_requests insert,
//      not the service_categories select that runs first.
//
//   3. Per-IP partitioning works. An attacker from IP A maxing
//      their bucket must not affect an unrelated user on IP B.
//
//   4. Per-vertical partitioning is INTENTIONAL. Moving and
//      cleaning have separate buckets — a moving spammer doesn't
//      lock out cleaning users. Trade-off: an attacker can send
//      10 moving + 10 cleaning per minute (20 total per IP). This
//      is a known and accepted trade-off documented here.
//
//   5. x-forwarded-for first-IP semantics. Vercel sends
//      "client, proxy1, proxy2" — first IP is the actual client.
//      Defends against an attacker setting their OWN x-forwarded-
//      for header: their public IP gets prepended by Vercel's
//      edge, so they can't spoof "I'm a different user" by
//      injecting XFF.
//
//   6. Header-stripping defense. A request with no XFF and no
//      x-real-ip falls into the 'unknown' bucket — meaning
//      header-strippers all share one bucket and can't escape
//      the limiter by hiding their IP.
//
// If any of these break, the assertion at the top of each action
// becomes a paper tiger.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Shared test scaffolding (mirrors intake.test.ts patterns) ────────
const captureExceptionMock = vi.fn();

function mockHeaders(opts: {
  xff?: string | null;
  xRealIp?: string | null;
}) {
  vi.doMock('next/headers', () => ({
    headers: () => ({
      get: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'x-forwarded-for') return opts.xff ?? null;
        if (lower === 'x-real-ip') return opts.xRealIp ?? null;
        return null;
      },
    }),
  }));
}

function mockGetUser(user: { id: string } | null) {
  vi.doMock('@/lib/auth', () => ({
    getUser: vi.fn().mockResolvedValue(user),
  }));
}

type MockedDb = {
  catSpy: ReturnType<typeof vi.fn>;
  insertSpy: ReturnType<typeof vi.fn>;
};

function mockAdmin(
  cat: { data: { id: string } | null; error: unknown },
  ins: { data: { id: string } | null; error: unknown },
): MockedDb {
  // Track BOTH the category lookup and the insert separately so the
  // audit can assert which one (if either) was reached past the rate
  // limiter.
  const catSpy = vi.fn();
  const insertSpy = vi.fn((_row: Record<string, unknown>) => ({
    select: () => ({ single: () => Promise.resolve(ins) }),
  }));
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'service_categories') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: () => {
                    catSpy();
                    return Promise.resolve(cat);
                  },
                }),
              }),
            }),
          };
        }
        if (table === 'quote_requests') return { insert: insertSpy };
        throw new Error(`unexpected table ${table}`);
      },
    }),
  }));
  return { catSpy, insertSpy };
}

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

// Use a unique 4th-octet per test so the in-memory rate-limit map
// doesn't carry buckets across cases. The map's CLEANUP_INTERVAL_MS
// is 60s — far longer than this suite runs.
let ipCounter = 0;
const newIp = (): string => {
  ipCounter += 1;
  return `9.35.${Math.floor(ipCounter / 254) + 1}.${(ipCounter % 254) + 1}`;
};

describe('intake rate-limit boundary audit (R35)', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    mockSentry();
  });

  // ── (1) Rate-limit fires BEFORE zod validation ─────────────────────
  it('rate-limit fires before zod validation (moving): a rate-limited IP submitting bad input gets the rate-limit error, not the zod error', async () => {
    const ip = newIp();
    mockHeaders({ xff: ip });
    mockGetUser(null);
    const { catSpy, insertSpy } = mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-1' }, error: null },
    );
    const { submitMovingIntake } = await import('./intake');

    // Burn the bucket with valid input.
    for (let i = 0; i < 10; i++) {
      const r = await submitMovingIntake(VALID_MOVING_INPUT);
      expect(r.ok).toBe(true);
    }

    // Now submit GARBAGE that would fail zod — but the limiter
    // should fire first. If zod ran before the limiter, the
    // attacker could send millions of bad payloads without ever
    // tripping the limiter (because zod returns early before the
    // rateLimit() call increments the bucket).
    const blocked = await submitMovingIntake({ junk: 'not even a valid shape' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toMatch(/too many requests/i);
      // Critically: NOT a fieldErrors response. Zod must not have
      // run on this attempt.
      expect(blocked.fieldErrors).toBeUndefined();
    }

    // Sanity: only the first 10 valid attempts touched the DB.
    expect(catSpy).toHaveBeenCalledTimes(10);
    expect(insertSpy).toHaveBeenCalledTimes(10);
  });

  it('rate-limit fires before zod validation (cleaning): same boundary as moving', async () => {
    const ip = newIp();
    mockHeaders({ xff: ip });
    mockGetUser(null);
    const { catSpy, insertSpy } = mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-1' }, error: null },
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');

    for (let i = 0; i < 10; i++) {
      const r = await submitCleaningIntake(VALID_CLEANING_INPUT);
      expect(r.ok).toBe(true);
    }
    const blocked = await submitCleaningIntake({ also: 'garbage' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toMatch(/too many requests/i);
      expect(blocked.fieldErrors).toBeUndefined();
    }
    expect(catSpy).toHaveBeenCalledTimes(10);
    expect(insertSpy).toHaveBeenCalledTimes(10);
  });

  // ── (2) Rate-limit fires BEFORE the DB category lookup ─────────────
  it('rate-limit fires before the service_categories select (moving): zero DB calls when limiter blocks', async () => {
    const ip = newIp();
    mockHeaders({ xff: ip });
    mockGetUser(null);
    const { catSpy, insertSpy } = mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-1' }, error: null },
    );
    const { submitMovingIntake } = await import('./intake');

    for (let i = 0; i < 10; i++) await submitMovingIntake(VALID_MOVING_INPUT);
    expect(catSpy).toHaveBeenCalledTimes(10);

    // The blocked attempt must NOT increment the catSpy count.
    await submitMovingIntake(VALID_MOVING_INPUT);
    expect(catSpy).toHaveBeenCalledTimes(10);
    expect(insertSpy).toHaveBeenCalledTimes(10);
  });

  it('rate-limit fires before the service_categories select (cleaning): zero DB calls when limiter blocks', async () => {
    const ip = newIp();
    mockHeaders({ xff: ip });
    mockGetUser(null);
    const { catSpy, insertSpy } = mockAdmin(
      { data: { id: 'cat-cln' }, error: null },
      { data: { id: 'qr-1' }, error: null },
    );
    const { submitCleaningIntake } = await import('./cleaning-intake');

    for (let i = 0; i < 10; i++) await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(catSpy).toHaveBeenCalledTimes(10);

    await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(catSpy).toHaveBeenCalledTimes(10);
    expect(insertSpy).toHaveBeenCalledTimes(10);
  });

  // ── (3) Per-IP isolation ────────────────────────────────────────────
  // These tests need the rate-limit map state to PERSIST across sub-
  // requests within a single test. vi.resetModules() would wipe the
  // in-memory `buckets` Map in lib/rate-limit.ts, so we use mutable
  // header refs read by a single per-test next/headers mock instead
  // of calling resetModules between sub-requests.
  it('per-IP partitioning (moving): attacker IP A maxing the bucket does not block unrelated IP B', async () => {
    const ipA = newIp();
    const ipB = newIp();
    expect(ipA).not.toBe(ipB);

    // Mutable header ref read on every headers().get() call. Switching
    // IPs mid-test = mutate the ref; no resetModules needed.
    let currentXff: string | null = ipA;
    vi.doMock('next/headers', () => ({
      headers: () => ({
        get: (name: string) =>
          name.toLowerCase() === 'x-forwarded-for' ? currentXff : null,
      }),
    }));
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-x' }, error: null },
    );
    const { submitMovingIntake } = await import('./intake');

    // Burn IP A's bucket.
    for (let i = 0; i < 11; i++) await submitMovingIntake(VALID_MOVING_INPUT);
    const blockedA = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(blockedA.ok).toBe(false);

    // Switch to IP B in-place (NO module reset — same buckets Map).
    currentXff = ipB;
    const okB = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(okB.ok).toBe(true);
  });

  // ── (4) Cross-vertical partitioning (intentional) ─────────────────
  it('cross-vertical isolation: a moving-blocked IP can still submit cleaning (separate buckets, intentional trade-off)', async () => {
    const ip = newIp();
    let currentXff: string | null = ip;
    vi.doMock('next/headers', () => ({
      headers: () => ({
        get: (name: string) =>
          name.toLowerCase() === 'x-forwarded-for' ? currentXff : null,
      }),
    }));
    mockGetUser(null);

    // Mock both tables with mutable category id depending on caller.
    // Both intake actions share the same admin client mock — they
    // each ask for a different slug but the mock returns the same
    // shape, which is fine for the rate-limit assertion here.
    mockAdmin(
      { data: { id: 'cat-shared' }, error: null },
      { data: { id: 'qr-x' }, error: null },
    );

    const { submitMovingIntake } = await import('./intake');
    const { submitCleaningIntake } = await import('./cleaning-intake');

    // Burn moving's bucket.
    for (let i = 0; i < 11; i++) await submitMovingIntake(VALID_MOVING_INPUT);
    const blockedM = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(blockedM.ok).toBe(false);

    // Same IP, cleaning vertical — fresh bucket.
    const okC = await submitCleaningIntake(VALID_CLEANING_INPUT);
    expect(okC.ok).toBe(true);
  });

  // ── (5) x-forwarded-for first-IP semantics ─────────────────────────
  it('x-forwarded-for first-IP: multi-hop XFF parsed as the leftmost IP (Vercel-style)', async () => {
    const realClient = newIp();
    const otherClient = newIp();
    const proxy1 = '10.0.0.1';
    const proxy2 = '10.0.0.2';

    // Mutable XFF read on every headers().get() call.
    let currentXff: string | null = `${realClient}, ${proxy1}, ${proxy2}`;
    vi.doMock('next/headers', () => ({
      headers: () => ({
        get: (name: string) =>
          name.toLowerCase() === 'x-forwarded-for' ? currentXff : null,
      }),
    }));
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-x' }, error: null },
    );
    const { submitMovingIntake } = await import('./intake');

    // Burn the realClient bucket via a multi-hop XFF.
    for (let i = 0; i < 11; i++) await submitMovingIntake(VALID_MOVING_INPUT);

    // Same leftmost IP, different proxy chain — must still be blocked.
    currentXff = `${realClient}, 10.99.99.1, 10.99.99.2`;
    const stillBlocked = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(stillBlocked.ok).toBe(false);

    // Different leftmost IP — fresh bucket.
    currentXff = `${otherClient}, ${proxy1}, ${proxy2}`;
    const fresh = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(fresh.ok).toBe(true);
  });

  // ── (6) Header-stripping defense ───────────────────────────────────
  it('header-stripping defense: requests with no XFF and no x-real-ip share the global "unknown" bucket', async () => {
    // Two consecutive requests with NO identifying headers must land
    // in the same bucket — meaning a header-stripping attacker can't
    // escape the limiter just by hiding their IP.
    mockHeaders({ xff: null, xRealIp: null });
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-x' }, error: null },
    );
    const { submitMovingIntake } = await import('./intake');

    // Send 11 from "no-headers" requests in this single test process.
    // The first 10 succeed; the 11th must be blocked. The bucket key
    // resolves to `intake:moving:unknown` per
    // lib/rate-limit.ts#clientKeyFromHeaders fallback.
    let blockedCount = 0;
    for (let i = 0; i < 11; i++) {
      const r = await submitMovingIntake(VALID_MOVING_INPUT);
      if (!r.ok && /too many requests/i.test(r.error)) blockedCount += 1;
    }
    expect(blockedCount).toBeGreaterThanOrEqual(1);
  });

  it('x-real-ip fallback works when XFF is absent (Vercel removes XFF, sets x-real-ip on some platforms)', async () => {
    const realIp = newIp();
    mockHeaders({ xff: null, xRealIp: realIp });
    mockGetUser(null);
    mockAdmin(
      { data: { id: 'cat-mov' }, error: null },
      { data: { id: 'qr-x' }, error: null },
    );
    const { submitMovingIntake } = await import('./intake');
    // Burn the bucket via x-real-ip.
    for (let i = 0; i < 10; i++) {
      const r = await submitMovingIntake(VALID_MOVING_INPUT);
      expect(r.ok).toBe(true);
    }
    const blocked = await submitMovingIntake(VALID_MOVING_INPUT);
    expect(blocked.ok).toBe(false);
  });

  // ── (7) Source-level audit: rate-limit is the FIRST statement ──────
  it('source-level: rateLimit() is invoked BEFORE any other I/O or zod call in intake.ts', async () => {
    // Drift-guard. A future refactor that moves the rate-limit assertion
    // below the zod parse, or below the createAdminClient call, would
    // silently widen the attack surface. Lock the source-level
    // ordering: rateLimit() must appear before any of: `safeParse`,
    // `createAdminClient`, `from(`.
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/actions/intake.ts'),
      'utf8',
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, ' ');
    const rlIdx = stripped.indexOf('rateLimit(');
    const zodIdx = stripped.indexOf('.safeParse(');
    const adminIdx = stripped.indexOf('createAdminClient(');
    const fromIdx = stripped.indexOf('.from(');
    expect(rlIdx, 'rateLimit() not found in intake.ts').toBeGreaterThan(-1);
    expect(zodIdx).toBeGreaterThan(rlIdx);
    expect(adminIdx).toBeGreaterThan(rlIdx);
    expect(fromIdx).toBeGreaterThan(rlIdx);
  });

  it('source-level: rateLimit() is invoked BEFORE any other I/O or zod call in cleaning-intake.ts', async () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/actions/cleaning-intake.ts'),
      'utf8',
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, ' ');
    const rlIdx = stripped.indexOf('rateLimit(');
    const zodIdx = stripped.indexOf('.safeParse(');
    const adminIdx = stripped.indexOf('createAdminClient(');
    const fromIdx = stripped.indexOf('.from(');
    expect(rlIdx, 'rateLimit() not found in cleaning-intake.ts').toBeGreaterThan(-1);
    expect(zodIdx).toBeGreaterThan(rlIdx);
    expect(adminIdx).toBeGreaterThan(rlIdx);
    expect(fromIdx).toBeGreaterThan(rlIdx);
  });

  // ── (8) Source-level audit: key prefixes are partitioned per vertical
  it('source-level: intake.ts uses the "intake:moving" key prefix', async () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/actions/intake.ts'),
      'utf8',
    );
    expect(source).toMatch(/clientKeyFromHeaders\([^,]+,\s*'intake:moving'\s*\)/);
    // Negative: must not use the cleaning prefix.
    expect(source).not.toMatch(/'intake:cleaning'/);
  });

  it('source-level: cleaning-intake.ts uses the "intake:cleaning" key prefix', async () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'lib/actions/cleaning-intake.ts'),
      'utf8',
    );
    expect(source).toMatch(/clientKeyFromHeaders\([^,]+,\s*'intake:cleaning'\s*\)/);
    expect(source).not.toMatch(/'intake:moving'/);
  });

  // ── (9) Source-level audit: limit and windowMs values are bounded ──
  it('source-level: both intake actions use limit:10 windowMs:60_000 (drift guard against silent loosening)', async () => {
    // Catches a future "let's bump it to 100" without code review.
    // If a deliberate change happens, update this test AND document
    // the new limits in the action header comment.
    for (const file of ['lib/actions/intake.ts', 'lib/actions/cleaning-intake.ts']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, ' ');
      // Allow the limit literal inside the rateLimit({...}) call only.
      // The pattern also tolerates whitespace between properties.
      expect(
        stripped,
        `${file}: missing limit:10 in rateLimit({...}) call`,
      ).toMatch(/limit\s*:\s*10\b/);
      expect(
        stripped,
        `${file}: missing windowMs:60_000 in rateLimit({...}) call`,
      ).toMatch(/windowMs\s*:\s*60[_]?000\b/);
    }
  });
});
