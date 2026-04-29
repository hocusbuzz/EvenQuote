// Tests for releaseContactToBusiness — the only code path that
// forwards customer PII (name/phone/email) to a business.
//
// Stubs:
//   - @/lib/supabase/server  (SSR client for auth + ownership check)
//   - @/lib/supabase/admin   (service-role client for context + audit)
//   - @/lib/email/resend     (sendEmail)
//   - @/lib/email/templates  (renderContactRelease) — we stub to keep
//     the suite decoupled from template churn
//   - next/cache             (revalidatePath is a no-op)

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────

type OwnedRow = { id: string; contact_released_at: string | null } | null;

function mockSsr(
  user: { id: string } | null,
  owned: OwnedRow,
  opts: { ownedError?: boolean; userError?: boolean } = {}
) {
  const getUser = vi.fn().mockResolvedValue({
    data: { user },
    error: opts.userError ? { message: 'no session' } : null,
  });
  const maybeSingle = vi.fn().mockResolvedValue({
    data: owned,
    error: opts.ownedError ? { message: 'db down' } : null,
  });
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: { getUser },
      from: (table: string) => {
        if (table !== 'quotes') throw new Error(`ssr: unexpected ${table}`);
        return {
          select: () => ({
            eq: () => ({ maybeSingle }),
          }),
        };
      },
    }),
  }));
  return { getUser, maybeSingle };
}

type AdminOpts = {
  quoteRow?: Record<string, unknown> | null;
  quoteErr?: boolean;
  requestRow?: Record<string, unknown> | null;
  requestErr?: boolean;
  businessRow?: Record<string, unknown> | null;
  businessErr?: boolean;
  existingReleaseId?: string | null;
  /**
   * Simulates the pre-send defense-in-depth check hitting a prior
   * successful audit row (email_send_id IS NOT NULL) whose stamp was
   * never written. The action should short-circuit as already-released.
   */
  priorSendRow?: { id: string; email_send_id: string } | null;
  auditInsertErr?: boolean;
  stampErr?: boolean;
};

function mockAdmin(opts: AdminOpts = {}) {
  const insertSpy = vi.fn();
  const updateSpy = vi.fn();
  const existingReleaseLookup = vi.fn().mockResolvedValue({
    data: opts.existingReleaseId
      ? { id: opts.existingReleaseId }
      : null,
    error: null,
  });
  // Pre-send defense-in-depth lookup: .select().eq().not('email_send_id','is',null).maybeSingle()
  const priorSendLookup = vi.fn().mockResolvedValue({
    data: opts.priorSendRow ?? null,
    error: null,
  });

  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: (table: string) => {
        if (table === 'quote_contact_releases') {
          return {
            // Two select chains land here:
            //   1. owned.contact_released_at=true path: .select().eq().maybeSingle()
            //   2. pre-send double-send check:          .select().eq().not().maybeSingle()
            // The presence/absence of .not() tells them apart.
            select: () => ({
              eq: () => ({
                maybeSingle: existingReleaseLookup,
                not: () => ({
                  maybeSingle: priorSendLookup,
                }),
              }),
            }),
            // audit insert path (followed by .select().single() on happy
            // path; followed by nothing on failure path)
            insert: (row: Record<string, unknown>) => {
              insertSpy(row);
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve(
                      opts.auditInsertErr
                        ? { data: null, error: { message: 'audit fail' } }
                        : { data: { id: 'rel-1' }, error: null }
                    ),
                }),
                // when sendEmail fails we just call .insert() without .select()
                then: undefined,
              };
            },
          };
        }
        if (table === 'quotes') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: opts.quoteErr ? null : opts.quoteRow ?? null,
                    error: opts.quoteErr ? { message: 'q err' } : null,
                  }),
              }),
            }),
            update: (row: Record<string, unknown>) => {
              updateSpy(row);
              return {
                eq: () => ({
                  // update().eq()        — used by the happy-path stamp.
                  // update().eq().is()   — used by the P2-1 repair stamp
                  //                        (guards "only if contact_released_at IS NULL").
                  // Both terminate with a Promise resolution; the repair
                  // path adds .is() in between but we want both to resolve
                  // the same way.
                  then: (
                    resolve: (v: { error: { message: string } | null }) => unknown
                  ) => resolve({ error: opts.stampErr ? { message: 'stamp err' } : null }),
                  is: () =>
                    Promise.resolve({
                      error: opts.stampErr ? { message: 'stamp err' } : null,
                    }),
                }),
              };
            },
          };
        }
        if (table === 'quote_requests') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: opts.requestErr ? null : opts.requestRow ?? null,
                    error: opts.requestErr ? { message: 'r err' } : null,
                  }),
              }),
            }),
          };
        }
        if (table === 'businesses') {
          return {
            select: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: opts.businessErr ? null : opts.businessRow ?? null,
                    error: opts.businessErr ? { message: 'b err' } : null,
                  }),
              }),
            }),
          };
        }
        throw new Error(`admin: unexpected ${table}`);
      },
    }),
  }));
  return { insertSpy, updateSpy, existingReleaseLookup };
}

type SendResult =
  | { ok: true; id: string; simulated: boolean }
  | { ok: false; error: string };

function mockResend(result: SendResult) {
  const sendSpy = vi.fn().mockResolvedValue(result);
  vi.doMock('@/lib/email/resend', () => ({
    sendEmail: sendSpy,
  }));
  return { sendSpy };
}

function mockTemplates() {
  const renderSpy = vi.fn().mockReturnValue({
    subject: 'New lead',
    html: '<p>html</p>',
    text: 'text',
  });
  vi.doMock('@/lib/email/templates', () => ({
    renderContactRelease: renderSpy,
  }));
  return { renderSpy };
}

function mockNextCache() {
  vi.doMock('next/cache', () => ({
    revalidatePath: vi.fn(),
  }));
}

// ─── Fixtures ────────────────────────────────────────────────────────

const QUOTE_ROW = {
  id: 'quote-1',
  quote_request_id: 'qr-1',
  business_id: 'biz-1',
  price_min: 100,
  price_max: 250,
  price_description: null,
  availability: 'This week',
  notes: null,
  requires_onsite_estimate: false,
};

const REQUEST_ROW = {
  id: 'qr-1',
  user_id: 'user-1',
  city: 'Denver',
  state: 'CO',
  intake_data: {
    contact_name: 'Alice',
    contact_phone: '555-555-0100',
    contact_email: 'alice@example.com',
    home_size: '2 bedroom',
  },
  category: { name: 'Moving', slug: 'moving' },
};

const BUSINESS_ROW = {
  id: 'biz-1',
  name: 'A Movers',
  email: 'ops@amovers.com',
  phone: '+14155550100',
};

// ─── Tests ──────────────────────────────────────────────────────────

describe('releaseContactToBusiness', () => {
  beforeEach(() => {
    vi.resetModules();
    mockNextCache();
    mockTemplates();
  });

  it('rejects a missing quoteId', async () => {
    mockSsr({ id: 'user-1' }, null);
    mockAdmin();
    mockResend({ ok: true, id: 'eml-1', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    // deliberate any-cast: the action should defend against bad input
    const res = await releaseContactToBusiness('' as unknown as string);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/missing/i);
  });

  it('returns not-signed-in when there is no user', async () => {
    mockSsr(null, null);
    mockAdmin();
    mockResend({ ok: true, id: 'eml-1', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not signed in/i);
  });

  it('returns a generic message when the ownership check errors', async () => {
    mockSsr({ id: 'user-1' }, null, { ownedError: true });
    mockAdmin();
    mockResend({ ok: true, id: 'eml-1', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain('db down');
      expect(res.error).toMatch(/could not verify/i);
    }
  });

  it('returns a not-found style message when user does not own the quote', async () => {
    // owned === null means RLS filtered it
    mockSsr({ id: 'user-1' }, null);
    mockAdmin();
    mockResend({ ok: true, id: 'eml-1', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't find that quote/i);
  });

  it('is idempotent when the release has already happened', async () => {
    mockSsr(
      { id: 'user-1' },
      { id: 'quote-1', contact_released_at: '2026-04-22T00:00:00Z' }
    );
    const { insertSpy } = mockAdmin({ existingReleaseId: 'rel-old' });
    const { sendSpy } = mockResend({ ok: true, id: 'eml-x', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyReleased).toBe(true);
      expect(res.releaseId).toBe('rel-old');
    }
    // Must not have re-sent the email or written a new audit row.
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('bails cleanly when the pro has no email on file', async () => {
    mockSsr({ id: 'user-1' }, { id: 'quote-1', contact_released_at: null });
    const { insertSpy } = mockAdmin({
      quoteRow: QUOTE_ROW,
      requestRow: REQUEST_ROW,
      businessRow: { ...BUSINESS_ROW, email: null },
    });
    const { sendSpy } = mockResend({ ok: true, id: 'x', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/does not have an email/i);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('bails when the intake is missing required contact fields', async () => {
    mockSsr({ id: 'user-1' }, { id: 'quote-1', contact_released_at: null });
    const { insertSpy } = mockAdmin({
      quoteRow: QUOTE_ROW,
      requestRow: {
        ...REQUEST_ROW,
        intake_data: { home_size: '2 bedroom' }, // no contact_*
      },
      businessRow: BUSINESS_ROW,
    });
    const { sendSpy } = mockResend({ ok: true, id: 'x', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/contact info is missing/i);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('writes an audit row and surfaces a retry message when Resend fails', async () => {
    mockSsr({ id: 'user-1' }, { id: 'quote-1', contact_released_at: null });
    const { insertSpy, updateSpy } = mockAdmin({
      quoteRow: QUOTE_ROW,
      requestRow: REQUEST_ROW,
      businessRow: BUSINESS_ROW,
    });
    mockResend({ ok: false, error: 'bounced' });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not send the email/i);
    // An audit row was inserted recording the failure.
    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.quote_id).toBe('quote-1');
    expect(row.email_error).toBe('bounced');
    expect(row.email_simulated).toBe(false);
    // No stamp — customer can retry.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('happy path: sends email, inserts audit, stamps quote', async () => {
    mockSsr({ id: 'user-1' }, { id: 'quote-1', contact_released_at: null });
    const { insertSpy, updateSpy } = mockAdmin({
      quoteRow: QUOTE_ROW,
      requestRow: REQUEST_ROW,
      businessRow: BUSINESS_ROW,
    });
    const { sendSpy } = mockResend({ ok: true, id: 'eml-abc', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyReleased).toBe(false);
      expect(res.releaseId).toBe('rel-1');
    }
    // Email sent with the customer as reply-to (so the pro can reply).
    expect(sendSpy).toHaveBeenCalledOnce();
    const sendArgs = sendSpy.mock.calls[0][0];
    expect(sendArgs.to).toBe('ops@amovers.com');
    expect(sendArgs.replyTo).toBe('alice@example.com');
    expect(sendArgs.tag).toBe('contact-release');
    // Audit inserted with the successful send id.
    expect(insertSpy).toHaveBeenCalledOnce();
    const audit = insertSpy.mock.calls[0][0];
    expect(audit.email_send_id).toBe('eml-abc');
    expect(audit.email_simulated).toBe(false);
    expect(audit.released_by_user_id).toBe('user-1');
    // Quote stamped with contact_released_at.
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0][0].contact_released_at).toBeTruthy();
  });

  it('defense-in-depth: a prior successful send (contact_released_at NULL but email_send_id set) does NOT re-send PII', async () => {
    // Regression for GPT Codex P2-1: the happy path writes the audit row
    // BEFORE stamping quotes.contact_released_at. If the stamp fails, a
    // retry used to see contact_released_at=NULL and send the PII email
    // a second time. Fix: the pre-send check queries
    // quote_contact_releases for a row with email_send_id IS NOT NULL
    // and short-circuits.
    mockSsr({ id: 'user-1' }, { id: 'quote-1', contact_released_at: null });
    const { insertSpy, updateSpy } = mockAdmin({
      // A prior send landed but the stamp never ran.
      priorSendRow: { id: 'rel-prior', email_send_id: 'eml-prior' },
      // Populate the rest so we'd fall through if the check were missing.
      quoteRow: QUOTE_ROW,
      requestRow: REQUEST_ROW,
      businessRow: BUSINESS_ROW,
    });
    const { sendSpy } = mockResend({ ok: true, id: 'eml-new', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyReleased).toBe(true);
      expect(res.releaseId).toBe('rel-prior');
    }
    // The important invariant: no new email was sent, no new audit row.
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    // Best-effort stamp repair fires — it's ok if it's called, but it
    // must target contact_released_at only (and use .is(null) to avoid
    // clobbering a subsequent real stamp).
    if (updateSpy.mock.calls.length > 0) {
      expect(updateSpy.mock.calls[0][0]).toHaveProperty('contact_released_at');
    }
  });

  it('defense-in-depth: rejects when the quote_request user_id mismatches', async () => {
    // RLS should have filtered this — but the action has a second check.
    mockSsr({ id: 'user-1' }, { id: 'quote-1', contact_released_at: null });
    const { insertSpy } = mockAdmin({
      quoteRow: QUOTE_ROW,
      requestRow: { ...REQUEST_ROW, user_id: 'someone-else' },
      businessRow: BUSINESS_ROW,
    });
    const { sendSpy } = mockResend({ ok: true, id: 'eml-1', simulated: false });
    const { releaseContactToBusiness } = await import('./release-contact');
    const res = await releaseContactToBusiness('quote-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't find that quote/i);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
