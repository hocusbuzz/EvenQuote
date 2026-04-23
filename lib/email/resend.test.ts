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

import { sendEmail } from './resend';

const ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM', 'EVENQUOTE_SUPPORT_EMAIL'] as const;

describe('sendEmail', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    sendImpl = () =>
      Promise.resolve({ data: { id: 'email_default' }, error: null });
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
});
