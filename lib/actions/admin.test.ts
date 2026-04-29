// Tests for lib/actions/admin.ts — setRequestArchived server action.
//
// Pre-R32 this file had ZERO tests. It's an admin-only surface so the
// blast radius is bounded, but silent DB failures here leave operators
// staring at a toast with no Sentry trail. R32 adds a capture-site at
// the lib boundary with canonical `{lib:'admin', reason, requestId}`
// tags, and this suite locks:
//
//   (a) happy path archives & unarchives with the correct payload,
//   (b) revalidatePath is invoked for ALL three surfaces that show
//       this row (the detail page, the list, and the dashboard),
//   (c) requireAdmin() is awaited BEFORE any DB work or tag fire,
//   (d) invalid requestId short-circuits with NO DB call and NO
//       capture (user/invariant error — not an incident),
//   (e) DB error captures with canonical tags + wrapped message +
//       the no-PII contract,
//   (f) regression guards: forbid reason catch-alls, lock allow-list,
//       lock tag-schema keys, lock wrapped-message prefix.
//
// Pattern mirrors R28 checkout.test.ts and R30 post-payment.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Shared captureException spy (Sentry stub boundary) ──
const captureExceptionMock = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) => captureExceptionMock(err, ctx),
  captureMessage: vi.fn(),
  init: vi.fn(),
  isEnabled: () => false,
  setUser: vi.fn(),
  __resetForTests: vi.fn(),
}));

// ── next/cache revalidatePath is a Next runtime built-in; stub it. ──
const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

// ── requireAdmin: default ok; per-test override when needed. ──
const requireAdminMock = vi.fn(async () => ({ id: 'admin-1', role: 'admin' }));
vi.mock('@/lib/auth', () => ({
  requireAdmin: () => requireAdminMock(),
}));

// ── admin Supabase client: per-test mutable impl. We record every
//    from/update/eq so the tests can assert column names and call
//    ordering without fighting Vitest's module cache. ──
type UpdateCall = {
  table: string;
  payload: Record<string, unknown>;
  eqArgs: Array<{ col: string; val: unknown }>;
};

let updateCalls: UpdateCall[] = [];
let updateResult: { error: { message: string } | null } = { error: null };

function mockAdmin() {
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => ({
        update: (payload: Record<string, unknown>) => {
          const call: UpdateCall = { table, payload, eqArgs: [] };
          updateCalls.push(call);
          const chain = {
            eq: (col: string, val: unknown) => {
              call.eqArgs.push({ col, val });
              // Resolve on the final eq — there's only one eq in this
              // function. If that ever changes, this stub needs to
              // return a new chain on the first call.
              return Promise.resolve(updateResult);
            },
          };
          return chain;
        },
      }),
    }),
  }));
}

describe('setRequestArchived', () => {
  beforeEach(() => {
    vi.resetModules();
    captureExceptionMock.mockReset();
    revalidatePathMock.mockReset();
    requireAdminMock.mockReset();
    requireAdminMock.mockImplementation(async () => ({ id: 'admin-1', role: 'admin' }));
    updateCalls = [];
    updateResult = { error: null };
    mockAdmin();
  });

  // ── Happy path ──

  it('archives: writes archived_at=ISO-timestamp, returns ok, revalidates all 3 paths', async () => {
    const { setRequestArchived } = await import('./admin');
    const res = await setRequestArchived('req-abc', true);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.note).toMatch(/archived\./i);

    expect(updateCalls).toHaveLength(1);
    const [call] = updateCalls;
    expect(call.table).toBe('quote_requests');
    // ISO-8601 timestamp — Z-suffix, millisecond-precise
    expect(call.payload.archived_at).toEqual(expect.any(String));
    expect((call.payload.archived_at as string)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(call.eqArgs).toEqual([{ col: 'id', val: 'req-abc' }]);

    // All three surfaces that show this row must be revalidated.
    // Order doesn't matter; coverage does.
    const paths = revalidatePathMock.mock.calls.map((c) => c[0]).sort();
    expect(paths).toEqual(['/admin', '/admin/requests', '/admin/requests/req-abc']);
  });

  it('unarchives: writes archived_at=null, returns ok', async () => {
    const { setRequestArchived } = await import('./admin');
    const res = await setRequestArchived('req-xyz', false);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.note).toMatch(/unarchived\./i);

    expect(updateCalls).toHaveLength(1);
    const [call] = updateCalls;
    expect(call.payload.archived_at).toBeNull();
    expect(call.eqArgs).toEqual([{ col: 'id', val: 'req-xyz' }]);
  });

  it('update payload is a single-key object {archived_at} — no stray columns', async () => {
    // Tag schema lock for the DB update: if a future maintainer adds
    // an audit column like `archived_by` or `archived_reason`, we
    // want the test to fail FIRST so the columns can be added to the
    // schema AND to this assertion together.
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-shape', true);
    const keys = Object.keys(updateCalls[0].payload).sort();
    expect(keys).toEqual(['archived_at']);
  });

  // ── requireAdmin gate ──

  it('awaits requireAdmin BEFORE any DB work (auth gate)', async () => {
    // requireAdmin is the auth gate. If it throws (non-admin), no DB
    // work should have happened and no capture should fire.
    requireAdminMock.mockImplementationOnce(async () => {
      throw new Error('NEXT_REDIRECT:/');
    });
    const { setRequestArchived } = await import('./admin');

    await expect(setRequestArchived('req-auth', true)).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    expect(updateCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // ── Input validation ──

  it('missing requestId returns error WITHOUT any DB call or Sentry capture', async () => {
    // Classic input-validation path. This fires AFTER requireAdmin
    // (so we know the caller is authenticated) but BEFORE any
    // side effect. Must not capture — a form-state bug would flood
    // Sentry with every empty submit.
    const { setRequestArchived } = await import('./admin');
    const res = await setRequestArchived('', true);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing requestId/);
    expect(updateCalls).toHaveLength(0);
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  // ── DB-error capture path (R32 audit) ──

  it('DB error: returns {ok:false, error}, does NOT revalidate', async () => {
    updateResult = { error: { message: 'permission denied for table quote_requests' } };
    const { setRequestArchived } = await import('./admin');

    const res = await setRequestArchived('req-err', true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('permission denied for table quote_requests');

    // Revalidation must NOT run — nothing changed.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('DB error: captures to Sentry with canonical {lib, reason, requestId} tags', async () => {
    updateResult = { error: { message: 'db down' } };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-obs', true);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({
      tags: {
        lib: 'admin',
        reason: 'archiveUpdateFailed',
        requestId: 'req-obs',
      },
    });
  });

  it('DB error: wrapped error message uses controlled prefix (fingerprint stability)', async () => {
    // R28/R29 pattern — Sentry groups by fingerprint built from the
    // thrown Error's message. Wrap with a controlled message so upstream
    // vendor text (which drifts, or embeds values) does NOT become
    // part of the fingerprint.
    updateResult = {
      error: { message: 'new row violates row-level security policy for table "quote_requests"' },
    };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-fp', true);

    const [err] = captureExceptionMock.mock.calls[0];
    expect((err as Error).message).toBe('quote_requests.update(archived_at) failed');
    // Raw Supabase text must NOT leak into the Error message.
    expect((err as Error).message).not.toContain('row-level security');
  });

  it('DB error: no-PII guard — raw Supabase message not in ctx.tags, admin user id not in ctx', async () => {
    // Tags are our PII boundary. Supabase errors can contain column
    // names / table relations / even row data depending on the error
    // code. The wrapped Error prevents leaks via message; this test
    // locks the TAG boundary.
    updateResult = {
      error: {
        message: 'pk violation on "quote_requests" row id=00000000-0000-0000-0000-000000000001 user=admin@example.com',
      },
    };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-pii', true);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    // No admin email, no raw Supabase text, no unrelated row id.
    expect(serialized).not.toMatch(/admin@example\.com/);
    expect(serialized).not.toMatch(/pk violation/);
    expect(serialized).not.toMatch(/row-level security/);
    expect(serialized).not.toMatch(/00000000-0000-0000-0000-000000000001/);
  });

  it('DB error: no-PII guard — archived boolean is NOT serialized into tags', async () => {
    // Separate assertion: `archived` is a boolean with low signal
    // value in Sentry; including it as a tag would double the issue
    // count without adding alerting value. Lock it out.
    updateResult = { error: { message: 'db down' } };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-bool', false); // unarchive path

    const [, ctx] = captureExceptionMock.mock.calls[0];
    const tags = (ctx as { tags: Record<string, string> }).tags;
    expect('archived' in tags).toBe(false);
  });

  // ── Happy path: NO capture (false-positive guard) ──

  it('happy path does NOT capture to Sentry', async () => {
    // If "lib:admin" ever starts showing up on the Sentry dashboard
    // without a DB error, this test is the first place to check.
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-happy', true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  // ── Regression guards (R28/R29/R30 pattern) ──

  it('regression: never emits catch-all reason values', async () => {
    updateResult = { error: { message: 'any failure' } };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-reg', true);

    const forbidden = new Set([
      'unknown',
      'error',
      'failed',
      'updateFailed',
      'archiveFailed',
      'dbFailed',
      'runFailed',
    ]);
    for (const call of captureExceptionMock.mock.calls) {
      const ctx = call[1] as { tags?: { reason?: string } };
      const reason = ctx?.tags?.reason;
      expect(reason).toBeDefined();
      expect(forbidden.has(reason as string)).toBe(false);
    }
  });

  it('regression: reason is in the single-value AdminReason allow-list', async () => {
    updateResult = { error: { message: 'db down' } };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-allow', true);

    const allowed = new Set(['archiveUpdateFailed']);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const reason = (ctx as { tags: { reason: string } }).tags.reason;
    expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
  });

  it('regression: tag object is strictly {lib, reason, requestId} — no extra facets', async () => {
    // Schema lock. If a future "helpful" addition adds `adminId`,
    // `archived`, or `error.code` as a tag, this test fails first.
    updateResult = { error: { message: 'db down' } };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-schema', true);

    const [, ctx] = captureExceptionMock.mock.calls[0];
    const tagKeys = Object.keys((ctx as { tags: Record<string, string> }).tags).sort();
    expect(tagKeys).toEqual(['lib', 'reason', 'requestId']);
  });

  it('regression: wrapped message prefix "quote_requests.update(archived_at) failed" is locked', async () => {
    // If the wrapped prefix text is renamed, Sentry spawns new issues
    // for every deploy until the fingerprint stabilizes. Lock it.
    updateResult = { error: { message: 'vendor said no' } };
    const { setRequestArchived } = await import('./admin');
    await setRequestArchived('req-prefix', true);

    const [err] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('quote_requests.update(archived_at) failed');
  });
});
