// Tests for the Resend wrapper.
//
// Four modes to exercise:
//   1. simulation (no RESEND_API_KEY) — returns `simulated: true` and a
//      fake id so the pipeline can run locally without burning credit.
//   2. real send success — passes subject/html/text/replyTo/tags through.
//   3. real send returning an error object (Resend's shape).
//   4. real send throwing (network error).
//
// Module singleton note: resend.ts caches the Resend client in a
// module-local `_client` after the first real send. Tests reset module
// state with `vi.resetModules()` so each case gets a fresh client.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We mock the Resend SDK at module level. `sendImpl` is a mutable
// module-scope let so each test can swap behavior without re-declaring
// the mock and without needing vi.resetModules() (which would also tear
// down the mock factory).
//
// Note: resend.ts caches its Resend client in a module-local `_client`
// singleton. Because the cached instance's `.emails.send` delegates to
// the CURRENT value of `sendImpl` via closure, the singleton does NOT
// need to be reset between tests — updating sendImpl is enough.
let sendImpl: (...args: unknown[]) => unknown = () =>
  Promise.resolve({ data: { id: 'email_default' }, error: null });

vi.mock('resend', () => {
  class Resend {
    emails = {
      send: (...args: unknown[]) => sendImpl(...args),
    };
    // constructor swallows the api key — we don't care about the value,
    // only that `new Resend(key)` succeeds.
    constructor(_key: string) {
      void _key;
    }
  }
  return { Resend };
});

// Mock the observability boundary so we can verify lib-boundary
// captureException calls without the stub's log.error side-effect
// firing on every send failure. vi.mock hoists — applies before
// `import { sendEmail } from './resend'` below.
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

import { sendEmail } from './resend';

const ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM', 'EVENQUOTE_SUPPORT_EMAIL'] as const;

describe('sendEmail', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    sendImpl = () =>
      Promise.resolve({ data: { id: 'email_default' }, error: null });
    captureExceptionMock.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const baseInput = {
    to: 'alex@example.com',
    subject: 'Your report',
    html: '<p>hi</p>',
    text: 'hi',
    tag: 'quote-report',
  };

  it('simulation mode when RESEND_API_KEY is unset', async () => {
    const result = await sendEmail(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.simulated).toBe(true);
      if (result.simulated) {
        expect(result.id).toMatch(/^sim_email_/);
        expect(result.reason).toMatch(/RESEND_API_KEY/);
      }
    }
  });

  it('real send: passes from/to/subject/html/text/replyTo/tags; returns provider id', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    let captured: Record<string, unknown> | null = null;
    sendImpl = (arg: unknown) => {
      captured = arg as Record<string, unknown>;
      return Promise.resolve({ data: { id: 'email_live_xyz' }, error: null });
    };

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.simulated).toBe(false);
      if (!result.simulated) expect(result.id).toBe('email_live_xyz');
    }

    expect(captured).not.toBeNull();
    expect(captured!.to).toBe('alex@example.com');
    expect(captured!.subject).toBe('Your report');
    expect(captured!.html).toBe('<p>hi</p>');
    expect(captured!.text).toBe('hi');
    // Default from + replyTo.
    expect(captured!.from).toBe('EvenQuote <reports@evenquote.com>');
    expect(captured!.replyTo).toBe('support@evenquote.com');
    // Tag wrapped into Resend's tag shape.
    expect(captured!.tags).toEqual([{ name: 'kind', value: 'quote-report' }]);
  });

  it('honors RESEND_FROM and EVENQUOTE_SUPPORT_EMAIL env overrides', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    process.env.RESEND_FROM = 'Hey <hey@evenquote.com>';
    process.env.EVENQUOTE_SUPPORT_EMAIL = 'help@evenquote.com';
    let captured: Record<string, unknown> | null = null;
    sendImpl = (arg: unknown) => {
      captured = arg as Record<string, unknown>;
      return Promise.resolve({ data: { id: 'e1' }, error: null });
    };

    await sendEmail(baseInput);

    expect(captured!.from).toBe('Hey <hey@evenquote.com>');
    expect(captured!.replyTo).toBe('help@evenquote.com');
  });

  it('honors per-call from and replyTo over env defaults', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    process.env.RESEND_FROM = 'Default <d@evenquote.com>';
    let captured: Record<string, unknown> | null = null;
    sendImpl = (arg: unknown) => {
      captured = arg as Record<string, unknown>;
      return Promise.resolve({ data: { id: 'e1' }, error: null });
    };

    await sendEmail({
      ...baseInput,
      from: 'Override <o@evenquote.com>',
      replyTo: 'override-reply@evenquote.com',
    });

    expect(captured!.from).toBe('Override <o@evenquote.com>');
    expect(captured!.replyTo).toBe('override-reply@evenquote.com');
  });

  it('omits tags when no tag is provided', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    let captured: Record<string, unknown> | null = null;
    sendImpl = (arg: unknown) => {
      captured = arg as Record<string, unknown>;
      return Promise.resolve({ data: { id: 'e1' }, error: null });
    };

    const { tag: _omit, ...noTag } = baseInput;
    void _omit;
    await sendEmail(noTag);

    expect(captured!.tags).toBeUndefined();
  });

  it('returns ok:false when Resend responds with an error object', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () =>
      Promise.resolve({
        data: null,
        error: { name: 'validation_error', message: 'bad from address' },
      });

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/validation_error/);
      expect(result.error).toMatch(/bad from address/);
    }
  });

  it('returns ok:false when Resend response body is missing id', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.resolve({ data: {}, error: null });

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing id/);
  });

  it('returns ok:false when the send call throws (network error)', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.reject(new Error('ECONNRESET'));

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ECONNRESET/);
  });

  it('handles array recipients in simulation mode without throwing', async () => {
    const result = await sendEmail({
      ...baseInput,
      to: ['a@example.com', 'b@example.com'],
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.simulated) {
      expect(result.id).toMatch(/^sim_email_/);
    }
  });

  // ── Round 20 observability contract ──
  //
  // Every sendEmail failure path — provider-error object, malformed
  // success response, and raw transport exception — must reach the
  // error tracker through the lib-boundary captureException call with
  // the canonical `{ lib: 'resend', reason: 'sendFailed' }` tag shape.
  //
  // Before Round 20, send failures were silent from the tracker's POV
  // (the route handler callers had to remember to wrap each call).
  // Customers missing their quote-report email is a trust-destroying
  // failure mode and deserves first-class alerting.

  it('captures Resend API errors at the lib boundary with canonical tags', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () =>
      Promise.resolve({
        data: null,
        error: { name: 'validation_error', message: 'bad from address' },
      });

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    // Sentry groups by stack trace — real Error > structured object.
    expect(err).toBeInstanceOf(Error);
    // Controlled prefix locks the fingerprint so provider rewording
    // (e.g. "validation_error" → "invalid_from") doesn't spawn a new
    // Sentry issue per deploy. R28 convention.
    expect((err as Error).message).toMatch(/^Resend sendApiErrored:/);
    expect((err as Error).message).toMatch(/validation_error/);
    // Tag shape is load-bearing. A future rename silently orphans
    // alert routing; this test makes the rename fail loud.
    expect(ctx).toMatchObject({
      tags: {
        lib: 'resend',
        reason: 'sendApiErrored',
        emailTag: 'quote-report',
      },
    });
  });

  it('captures missing-id response at the lib boundary', async () => {
    // Resend has never returned this shape, but if the provider ever
    // changes its contract we want the first failure to page us rather
    // than send silent empty-success responses through to callers.
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.resolve({ data: {}, error: null });

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Resend sendResponseMissingId');
    expect(ctx).toMatchObject({
      tags: {
        lib: 'resend',
        reason: 'sendResponseMissingId',
        emailTag: 'quote-report',
      },
    });
  });

  it('captures transport-level throws at the lib boundary', async () => {
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.reject(new Error('ECONNRESET'));

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionMock.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    // Transport throws: we pass the raw Error through unchanged so the
    // underlying stack trace is preserved for debugging. Fingerprint
    // stability still holds because `tags.reason` is the canonical
    // grouping key on the Sentry side.
    expect((err as Error).message).toBe('ECONNRESET');
    expect(ctx).toMatchObject({
      tags: { lib: 'resend', reason: 'sendTransportFailed' },
    });
  });

  it('omits emailTag from tags when the caller did not supply one', async () => {
    // Not every send path names the email kind (cron retry scripts,
    // etc). The tag set must still be well-formed — `emailTag`
    // appears only when there IS a tag, never as an empty string or
    // `undefined` literal that would pollute Sentry's facet search.
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.reject(new Error('boom'));

    const { tag: _omit, ...noTag } = baseInput;
    void _omit;
    await sendEmail(noTag);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    expect((ctx as { tags: Record<string, string> }).tags).toEqual({
      lib: 'resend',
      reason: 'sendTransportFailed',
    });
  });

  // ── Round 29 reason-granularity regression guards ──
  //
  // Prior to R29 all three failure paths shared `reason: 'sendFailed'`
  // which silently merged "Resend is down" and "our from address is
  // unverified" into one Sentry issue. Alert rules couldn't distinguish
  // provider outage from self-inflicted config drift.
  //
  // Below: lock the allowed reason set AND forbid drift back to any of
  // the catch-all shapes a future refactor might reach for.

  it('regression: forbids reason catch-alls across every failure path', async () => {
    // Any refactor that collapses the three paths back to one reason
    // (or introduces a vague 'unknown'/'error'/'failed' label) loses
    // alert-routing value. Run all three paths in sequence and assert
    // NONE of them emit a disallowed reason.
    process.env.RESEND_API_KEY = 'rsnd_test';
    const forbidden = new Set([
      'sendFailed', // pre-R29 catch-all
      'unknown',
      'error',
      'failed',
      'sendError',
      'providerError',
    ]);

    // Path 1: API error
    sendImpl = () =>
      Promise.resolve({
        data: null,
        error: { name: 'validation_error', message: 'bad' },
      });
    await sendEmail(baseInput);

    // Path 2: missing id
    sendImpl = () => Promise.resolve({ data: {}, error: null });
    await sendEmail(baseInput);

    // Path 3: transport throw
    sendImpl = () => Promise.reject(new Error('boom'));
    await sendEmail(baseInput);

    expect(captureExceptionMock).toHaveBeenCalledTimes(3);
    for (const call of captureExceptionMock.mock.calls) {
      const [, ctx] = call;
      const reason = (ctx as { tags: { reason: string } }).tags.reason;
      expect(forbidden.has(reason), `disallowed reason: ${reason}`).toBe(false);
    }
  });

  it('regression: tag schema lock — EXACT keys, no drift', async () => {
    // Strict key-set: if a future change adds `to`, `from`, `customerId`,
    // or similar PII/incident-detail to the tags object, this test
    // catches it. Sentry tag values are INDEXED for search; anything in
    // here survives message-body scrubbers.
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.reject(new Error('boom'));

    // With emailTag
    await sendEmail(baseInput);
    const [, withTag] = captureExceptionMock.mock.calls[0];
    const withTagKeys = Object.keys(
      (withTag as { tags: Record<string, string> }).tags
    ).sort();
    expect(withTagKeys).toEqual(['emailTag', 'lib', 'reason']);

    // Without emailTag
    captureExceptionMock.mockReset();
    const { tag: _omit, ...noTag } = baseInput;
    void _omit;
    await sendEmail(noTag);
    const [, noTagCtx] = captureExceptionMock.mock.calls[0];
    const noTagKeys = Object.keys(
      (noTagCtx as { tags: Record<string, string> }).tags
    ).sort();
    expect(noTagKeys).toEqual(['lib', 'reason']);
  });

  it('regression: reason is one of the three locked values', async () => {
    // If a future path is added, it MUST be added to this allow-list
    // AND to the ResendReason union in resend.ts. Drift between the two
    // is the exact class of bug this guard catches.
    process.env.RESEND_API_KEY = 'rsnd_test';
    const allowed = new Set([
      'sendApiErrored',
      'sendResponseMissingId',
      'sendTransportFailed',
    ]);

    // Cycle all three paths
    sendImpl = () =>
      Promise.resolve({
        data: null,
        error: { name: 'e', message: 'm' },
      });
    await sendEmail(baseInput);
    sendImpl = () => Promise.resolve({ data: {}, error: null });
    await sendEmail(baseInput);
    sendImpl = () => Promise.reject(new Error('x'));
    await sendEmail(baseInput);

    expect(captureExceptionMock).toHaveBeenCalledTimes(3);
    const seen = new Set<string>();
    for (const call of captureExceptionMock.mock.calls) {
      const [, ctx] = call;
      const reason = (ctx as { tags: { reason: string } }).tags.reason;
      expect(allowed.has(reason), `unknown reason: ${reason}`).toBe(true);
      seen.add(reason);
    }
    // Every path should be distinct — no accidental reason collision.
    expect(seen.size).toBe(3);
  });

  it('does NOT include the recipient email as a tag value (privacy)', async () => {
    // Logger redaction does not apply to Sentry tags. If someone adds
    // `{ to: input.to }` to captureTags, this test catches it before the
    // PII ships to the tracker. Tags are indexed for search — the blast
    // radius of a tag-level leak is wider than a message-level leak.
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () => Promise.reject(new Error('smtp down'));

    await sendEmail({
      ...baseInput,
      to: 'private@customer.com',
    });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, ctx] = captureExceptionMock.mock.calls[0];
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toMatch(/private@customer\.com/);
  });

  it('happy path does not capture anything', async () => {
    // Sanity: a successful send MUST NOT produce a false positive in the
    // tracker. If the Resend surface starts seeing spurious sendFailed
    // events, this is the first test to check.
    process.env.RESEND_API_KEY = 'rsnd_test';
    sendImpl = () =>
      Promise.resolve({ data: { id: 'email_live_ok' }, error: null });

    const result = await sendEmail(baseInput);

    expect(result.ok).toBe(true);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('simulation mode does not capture (no real send, no failure)', async () => {
    // No RESEND_API_KEY → simulation path. Should not produce a
    // sendFailed event — it's a deliberate local/dev no-op, not an
    // outage.
    await sendEmail(baseInput);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
