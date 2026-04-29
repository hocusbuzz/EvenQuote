import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Supabase server client (authed user) ----
const mockGetUser = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
  }),
}));

// ---- Observability boundary ----
// Module-level spy so the per-test beforeEach can reset without needing
// vi.resetModules() (which would also tear down this mock). R25 pattern.
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

// ---- Supabase admin client (RLS bypass for claim-backfill) ----
// Chain: .from(table).select(...).eq(...).maybeSingle()
//   or:  .from(table).update(...).eq(...).is(...)
//
// Different tables are hit in sequence: quote_requests (select + maybe
// update), payments (update). We expose mocks that each test can wire
// up independently.

const mockRequestsMaybeSingle = vi.fn();
const mockRequestsUpdateIs = vi.fn();
const mockPaymentsUpdateIs = vi.fn();

// Build the chain manually so the route's method sequence matches.
function makeAdmin() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'quote_requests') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: mockRequestsMaybeSingle })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({ is: mockRequestsUpdateIs })),
          })),
        };
      }
      if (table === 'payments') {
        return {
          update: vi.fn(() => ({
            eq: vi.fn(() => ({ is: mockPaymentsUpdateIs })),
          })),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  };
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeAdmin(),
}));

async function loadGet() {
  const { GET } = await import('./route');
  return GET;
}

function makeReq(path: string) {
  return new Request(`http://localhost${path}`) as never;
}

const UUID = '11111111-1111-1111-1111-111111111111';

describe('/get-quotes/claim', () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetUser.mockReset();
    mockRequestsMaybeSingle.mockReset();
    mockRequestsUpdateIs.mockReset();
    mockPaymentsUpdateIs.mockReset();
    captureExceptionMock.mockReset();
  });

  it('error-redirects when request id is missing', async () => {
    const GET = await loadGet();
    const res = await GET(makeReq('/get-quotes/claim'));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
    expect(new URL(loc).searchParams.get('message')).toMatch(/malformed|missing/i);
  });

  it('error-redirects when request id is not a UUID', async () => {
    const GET = await loadGet();
    const res = await GET(makeReq('/get-quotes/claim?request=not-a-uuid'));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
  });

  it('redirects to /login?next=... when not authed', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/login');
    expect(new URL(loc).searchParams.get('next')).toBe(`/get-quotes/claim?request=${UUID}`);
  });

  it('error-redirects when the request row is not found', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'a@b.co' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({ data: null, error: null });
    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    expect(new URL(res.headers.get('location')!).searchParams.get('message')).toContain(
      'not found'
    );
  });

  it('refuses silently when another user already owns the request', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: 'someone-else',
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    const msg = new URL(res.headers.get('location')!).searchParams.get('message')!;
    expect(msg).toMatch(/already claimed/i);
    // Must not have attempted any writes
    expect(mockRequestsUpdateIs).not.toHaveBeenCalled();
    expect(mockPaymentsUpdateIs).not.toHaveBeenCalled();
  });

  it('refuses when the signed-in email does not match intake email', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'attacker@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'victim@x.com' },
      },
      error: null,
    });
    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    const msg = new URL(res.headers.get('location')!).searchParams.get('message')!;
    expect(msg).toMatch(/different email/i);
    // No writes attempted
    expect(mockRequestsUpdateIs).not.toHaveBeenCalled();
    expect(mockPaymentsUpdateIs).not.toHaveBeenCalled();
  });

  it('happy path: backfills both tables and redirects to /get-quotes/success', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: null });
    mockPaymentsUpdateIs.mockResolvedValue({ error: null });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/get-quotes/success');
    expect(new URL(loc).searchParams.get('request')).toBe(UUID);
    expect(mockRequestsUpdateIs).toHaveBeenCalled();
    expect(mockPaymentsUpdateIs).toHaveBeenCalled();
  });

  it('idempotent: skips quote_requests update when user_id is already this user', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: 'u1', // same user re-clicks magic link
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockPaymentsUpdateIs.mockResolvedValue({ error: null });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    expect(res.headers.get('location')).toContain('/get-quotes/success');
    // quote_requests update should NOT fire on idempotent re-click
    expect(mockRequestsUpdateIs).not.toHaveBeenCalled();
    // payments update is still idempotent-safe via .is('user_id', null)
    expect(mockPaymentsUpdateIs).toHaveBeenCalled();
  });

  it('continues to success when payments backfill errors (non-fatal)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: null });
    mockPaymentsUpdateIs.mockResolvedValue({ error: { message: 'race' } });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    // Still lands on success — quote_requests is the source of truth for
    // the user's ownership; payments.claimed_at is a nice-to-have.
    expect(res.headers.get('location')).toContain('/get-quotes/success');
  });

  it('error-redirects when quote_requests update errors (fatal)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: { message: 'db down' } });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    const msg = new URL(res.headers.get('location')!).searchParams.get('message')!;
    expect(msg).toContain('Could not link');
    expect(mockPaymentsUpdateIs).not.toHaveBeenCalled();
  });

  // ── Round 29 observability contract ──
  //
  // Magic-link claim is the "make or break" UX moment: customer paid,
  // clicked the email, and this route decides whether they ever see
  // their quotes. Pre-R29 both DB error paths were log-only, so a
  // permission-denied or a brief Supabase blip would strand the customer
  // with no operator visibility. Two capture sites now:
  //   - requestLoadFailed (select errored)
  //   - quoteBackfillFailed (update errored post-auth)
  // See route.ts `ClaimReason` for full capture/no-capture rationale.

  it('captures requestLoadFailed on a real DB error (not on missing row)', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for table quote_requests' },
    });
    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));

    expect(new URL(res.headers.get('location')!).searchParams.get('message')).toContain(
      'not found'
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^claim requestLoadFailed:/);
    expect((err as Error).message).toMatch(/permission denied/);
    expect(ctx).toMatchObject({
      tags: {
        route: 'get-quotes/claim',
        reason: 'requestLoadFailed',
        requestId: UUID,
      },
    });
  });

  it('does NOT capture when the row is simply missing (user-facing URL error)', async () => {
    // Wrong request id, tampered URL, or a long-expired magic link.
    // Capturing here would flood Sentry on share-link misuse.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({ data: null, error: null });
    const GET = await loadGet();
    await GET(makeReq(`/get-quotes/claim?request=${UUID}`));

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('captures quoteBackfillFailed when the update errors post-auth', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: { message: 'db down' } });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    expect(new URL(res.headers.get('location')!).searchParams.get('message')).toContain(
      'Could not link'
    );
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^claim quoteBackfillFailed:/);
    expect((err as Error).message).toMatch(/db down/);
    expect(ctx).toMatchObject({
      tags: {
        route: 'get-quotes/claim',
        reason: 'quoteBackfillFailed',
        requestId: UUID,
      },
    });
  });

  it('does NOT capture when payments backfill errors (non-fatal by design)', async () => {
    // quote_requests is the source of truth for ownership; payments
    // claimed_at is cosmetic. A concurrent magic-link reclick can race
    // on this update and capturing would flood.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: null });
    mockPaymentsUpdateIs.mockResolvedValue({ error: { message: 'race' } });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));

    expect(res.headers.get('location')).toContain('/get-quotes/success');
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT capture on email mismatch (false-positive heavy)', async () => {
    // Users with multiple emails forget which they used. Logger already
    // writes a warn; capturing would page on-call for user confusion.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'attacker@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'victim@x.com' },
      },
      error: null,
    });
    const GET = await loadGet();
    await GET(makeReq(`/get-quotes/claim?request=${UUID}`));

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('happy path does not capture anything', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: null });
    mockPaymentsUpdateIs.mockResolvedValue({ error: null });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));

    expect(res.headers.get('location')).toContain('/get-quotes/success');
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('does NOT leak PII (email, user id) into tags or message on either capture path', async () => {
    const PII_VALUES = ['me@x.com', 'victim@x.com', 'u1'];

    // Path 1: requestLoadFailed with user context
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    });
    const GET1 = await loadGet();
    await GET1(makeReq(`/get-quotes/claim?request=${UUID}`));

    // Path 2: quoteBackfillFailed with user context
    vi.resetModules();
    captureExceptionMock.mockReset();
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: { message: 'db down' } });
    const GET2 = await loadGet();
    await GET2(makeReq(`/get-quotes/claim?request=${UUID}`));

    for (const call of captureExceptionMock.mock.calls) {
      const [err, ctx] = call;
      const serialized = JSON.stringify({ msg: (err as Error).message, ctx });
      for (const pii of PII_VALUES) {
        expect(
          serialized.includes(pii),
          `PII leaked: ${pii} found in capture`
        ).toBe(false);
      }
    }
  });

  it('regression: route + reason tag allow-list is locked', async () => {
    // Forbid catch-all reason drift. Any new reason must be added to
    // `ClaimReason` in route.ts AND to this allow-list simultaneously.
    const allowed = new Set(['requestLoadFailed', 'quoteBackfillFailed']);
    const forbidden = new Set([
      'unknown',
      'error',
      'failed',
      'claimFailed',
      'backfillFailed',
    ]);

    // Path 1
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'x' },
    });
    const GET1 = await loadGet();
    await GET1(makeReq(`/get-quotes/claim?request=${UUID}`));

    // Path 2
    vi.resetModules();
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: 'me@x.com' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: { message: 'y' } });
    const GET2 = await loadGet();
    await GET2(makeReq(`/get-quotes/claim?request=${UUID}`));

    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    for (const call of captureExceptionMock.mock.calls) {
      const [, ctx] = call;
      const tags = (ctx as { tags: { route: string; reason: string } }).tags;
      expect(tags.route).toBe('get-quotes/claim');
      expect(allowed.has(tags.reason), `unknown reason: ${tags.reason}`).toBe(true);
      expect(forbidden.has(tags.reason), `disallowed reason: ${tags.reason}`).toBe(false);
    }
  });

  it('normalises email case when comparing intake vs authed', async () => {
    // User signed up as ME@X.COM but intake stored me@x.com (or vice versa).
    // Comparing without normalisation would refuse — we want it to succeed.
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'u1', email: ' ME@X.COM ' } },
    });
    mockRequestsMaybeSingle.mockResolvedValue({
      data: {
        id: UUID,
        user_id: null,
        status: 'pending',
        intake_data: { contact_email: 'me@x.com' },
      },
      error: null,
    });
    mockRequestsUpdateIs.mockResolvedValue({ error: null });
    mockPaymentsUpdateIs.mockResolvedValue({ error: null });

    const GET = await loadGet();
    const res = await GET(makeReq(`/get-quotes/claim?request=${UUID}`));
    expect(res.headers.get('location')).toContain('/get-quotes/success');
  });
});
