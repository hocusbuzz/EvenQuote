// Tests for the Sentry stub.
//
// Goal: pin the stub's no-op semantics so we can wire the call sites
// now and swap the implementation later without fear. Each test
// resets module state via `__resetForTests` so the global
// `_initialized` / `_enabled` flags don't leak between cases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  init,
  captureException,
  captureMessage,
  setUser,
  isEnabled,
  __resetForTests,
} from './sentry';

const env = process.env as Record<string, string | undefined>;

describe('Sentry stub', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.SENTRY_DSN = env.SENTRY_DSN;
    delete env.SENTRY_DSN;
    __resetForTests();
    // Silence the stub's own log output during tests — it's noise
    // for assertions, and we re-verify call shape via spies.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (saved.SENTRY_DSN === undefined) delete env.SENTRY_DSN;
    else env.SENTRY_DSN = saved.SENTRY_DSN;
    __resetForTests();
    vi.restoreAllMocks();
  });

  it('isEnabled() is false before init()', () => {
    expect(isEnabled()).toBe(false);
  });

  it('isEnabled() stays false after init() when SENTRY_DSN is unset', () => {
    init();
    expect(isEnabled()).toBe(false);
  });

  it('isEnabled() flips true after init() when SENTRY_DSN is set', () => {
    env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    init();
    expect(isEnabled()).toBe(true);
  });

  it('init() is idempotent — second call does not change state', () => {
    env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    init();
    const firstState = isEnabled();
    // Change env behind the back; a second init() must still be a
    // no-op because `_initialized` is already true.
    delete env.SENTRY_DSN;
    init();
    expect(isEnabled()).toBe(firstState);
  });

  it('captureException is a no-op when disabled (no console output)', () => {
    // Disabled by default (no DSN, no init).
    const spy = vi.spyOn(console, 'error');
    captureException(new Error('boom'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('captureMessage is a no-op when disabled', () => {
    const spy = vi.spyOn(console, 'log');
    captureMessage('hello', 'info');
    expect(spy).not.toHaveBeenCalled();
  });

  it('setUser is a no-op when disabled', () => {
    const spy = vi.spyOn(console, 'debug');
    setUser({ id: 'user_1' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('captureException emits a structured log when enabled', () => {
    env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    init();
    const spy = vi.spyOn(console, 'error');
    captureException(new Error('boom'));
    expect(spy).toHaveBeenCalled();
    // The logger shape is already tested in lib/logger.test.ts; here
    // we only care that SOMETHING was written at error level.
  });

  it('captureMessage emits at info level when enabled', () => {
    env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    init();
    const logSpy = vi.spyOn(console, 'log');
    captureMessage('something happened', 'warning');
    expect(logSpy).toHaveBeenCalled();
  });

  it('setUser does not leak the email string to the stub log', () => {
    // Guards against future laziness: the stub logs `hasEmail: boolean`,
    // NOT the email itself. When the real Sentry wiring lands, the email
    // goes to Sentry only, and Sentry's scrubber is the last defense.
    env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    init();
    const debugSpy = vi.spyOn(console, 'debug');
    setUser({ id: 'user_42', email: 'secret@example.com' });
    for (const call of debugSpy.mock.calls) {
      const out = call.map((c) => String(c)).join(' ');
      expect(out).not.toContain('secret@example.com');
    }
  });

  it('captureException with redaction-worthy PII is routed through the redacted logger', () => {
    // Sanity check: the stub uses `log.error(..., { err, ctx })`,
    // which runs `redactDeep` before emission. So a thrown Error
    // whose message contains an email should show up redacted.
    env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    init();
    const errSpy = vi.spyOn(console, 'error');
    captureException(new Error('failed sending to secret@example.com'));
    const out = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).not.toContain('secret@example.com');
    expect(out).toContain('s***@example.com');
  });
});
