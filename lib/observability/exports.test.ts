// Public-surface snapshot tests for lib/observability/*.
//
// Mirrors lib/security/exports.test.ts. The observability modules are
// consumed from multiple routes and lib entry points (stripe webhook,
// post-payment action, /api/health, /api/version, resend, vapi,
// engine). A silent rename of `captureException` or `getCommitShort`
// would orphan all those callers at once — this file is the single
// lockdown that catches it at CI time.
//
// Contract:
//   • Runtime key set is asserted for each module (exact equality).
//   • Each runtime key is asserted to be a function.
//   • TypeScript-only exports (e.g. `type CaptureContext`) are NOT
//     present in `Object.keys(mod)` at runtime — they do not appear
//     in the assertion set. That's deliberate: this file locks the
//     *callable* surface. Type-only breakage is caught by `tsc`.
//
// When to update this file:
//   • Adding a new runtime export to any lib/observability/* module?
//     Add its name + kind to the corresponding assertion block.
//   • Removing an export? Delete the assertion AND audit the
//     consumers (`grep -R` for the name) before you do.

import { describe, it, expect } from 'vitest';

import * as sentry from './sentry';
import * as version from './version';

function keyKinds(mod: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(mod)
      .sort()
      .map((k) => [k, typeof mod[k]]),
  );
}

describe('lib/observability/sentry public surface', () => {
  it('exposes exactly the expected functions', () => {
    // `__resetForTests` is intentionally part of the runtime surface —
    // unit tests in this repo reset sentry state between cases. Its
    // name is deliberately ugly so accidental production use stands
    // out in review.
    expect(keyKinds(sentry)).toEqual({
      __resetForTests: 'function',
      captureException: 'function',
      captureMessage: 'function',
      init: 'function',
      isEnabled: 'function',
      setUser: 'function',
    });
  });

  it('each export is invocable without throwing in stub mode', () => {
    // Stub mode is the default state on every environment until the
    // Sentry DSN lands (user-input #6). Every function should be a
    // no-op that doesn't throw — these assertions lock that contract.
    sentry.__resetForTests();
    expect(() => sentry.init()).not.toThrow();
    expect(typeof sentry.isEnabled()).toBe('boolean');
    expect(() =>
      sentry.captureException(new Error('export-check'), {
        tags: { lib: 'exports-check' },
      }),
    ).not.toThrow();
    expect(() =>
      sentry.captureMessage('export-check', 'info', {
        tags: { lib: 'exports-check' },
      }),
    ).not.toThrow();
    expect(() => sentry.setUser({ id: 'exports-check' })).not.toThrow();
    expect(() => sentry.setUser(null)).not.toThrow();
    // Leave module in reset state so the real test file's beforeEach
    // doesn't have to account for our side-effects.
    sentry.__resetForTests();
  });
});

describe('lib/observability/version public surface', () => {
  it('exposes exactly the expected functions', () => {
    // These two are the single source of truth for the deployed
    // commit identity. `/api/health` and `/api/version` both import
    // them; a cross-route consistency test (version.consistency.test.ts)
    // locks that both routes read through this module.
    expect(keyKinds(version)).toEqual({
      getCommitSha: 'function',
      getCommitShort: 'function',
    });
  });

  it('each export returns a non-empty string', () => {
    // Contract: both helpers are non-nullable; unset env → 'dev'
    // sentinel. A future refactor that switched to `string | null`
    // would regress all the callers that forward the value into a
    // header, JSON field, or log tag.
    expect(typeof version.getCommitSha()).toBe('string');
    expect(version.getCommitSha().length).toBeGreaterThan(0);
    expect(typeof version.getCommitShort()).toBe('string');
    expect(version.getCommitShort().length).toBeGreaterThan(0);
  });
});
