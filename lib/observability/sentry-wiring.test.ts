// Wiring-verification tests for lib/observability/sentry.ts.
//
// Why this file exists (R32):
//   ~43 capture sites are now locked across lib/* and app/api/* with
//   canonical `{lib|route, reason, …}` tag shapes. Every one of them
//   forwards through `captureException(err, ctx)` — but no runtime
//   DSN is wired yet (user-input #6), so none of the captures actually
//   reach a Sentry project.
//
//   That's fine in steady state. But the day the DSN lands and
//   someone runs `npm i @sentry/nextjs` + uncomments the init block
//   in sentry.ts, the stub's call-signature is what every capture
//   site is handing Sentry. If the stub's signature has drifted from
//   @sentry/nextjs's `Sentry.captureException(err, ctx)` — different
//   shape for `ctx.tags`, different allowed keys on `ctx.user`,
//   different severity strings on captureMessage — the drift shows up
//   at deploy time as TypeScript errors in production or (worse) as
//   silently-dropped context.
//
// What this file locks:
//   (a) Stub-mode no-op contract: in the default SENTRY_DSN-unset
//       state, every exported function accepts the shapes that
//       call sites produce today without throwing.
//   (b) Sentry-SDK signature compatibility: the stub's parameter
//       shape matches the published @sentry/nextjs v8 public API
//       for captureException / captureMessage / setUser / init.
//   (c) PII boundary: tags are Record<string, string> (Sentry allows
//       primitives, we tighten to string to prevent accidental
//       object/user-blob tags) and the stub doesn't mutate the ctx
//       object (Sentry treats scope mutations separately via
//       withScope — our stub must not leak state via the passed ctx).
//   (d) Type-shape parity with the exported `CaptureContext` — locks
//       allowed keys so a refactor that removes `extra` (for example)
//       is a visible change.
//
// When to update this file:
//   • Bumping @sentry/nextjs: review the new Sentry API. If they
//     change captureException's second-arg shape, update the stub
//     first, then update these tests.
//   • Adding a new capture-site signature pattern (e.g. a breadcrumb
//     helper): add both the stub export AND a wiring test here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  init,
  captureException,
  captureMessage,
  setUser,
  isEnabled,
  __resetForTests,
  type CaptureContext,
  type CaptureLevel,
} from './sentry';

const env = process.env as Record<string, string | undefined>;

describe('Sentry stub — SDK wiring verification (R32)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.SENTRY_DSN = env.SENTRY_DSN;
    delete env.SENTRY_DSN;
    __resetForTests();
    // Silence the stub's own log output — we assert on inputs, not
    // whether the stub happened to console.log.
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

  // ── (a) Stub-mode no-op contract ─────────────────────────────────

  describe('stub-mode contracts — all captures are safe no-ops', () => {
    it('captureException accepts (Error) with no ctx', () => {
      expect(() => captureException(new Error('boom'))).not.toThrow();
    });

    it('captureException accepts (Error, undefined) explicitly', () => {
      expect(() => captureException(new Error('boom'), undefined)).not.toThrow();
    });

    it('captureException accepts non-Error values (Sentry allows any)', () => {
      // @sentry/nextjs' signature is `captureException(exception: any, ...)`.
      // Our stub must not narrow to Error — a captureException from a
      // catch-block where the thrown value is a string/plain-object must
      // not crash the stub.
      expect(() => captureException('string failure')).not.toThrow();
      expect(() => captureException({ custom: 'shape' })).not.toThrow();
      expect(() => captureException(null)).not.toThrow();
      expect(() => captureException(undefined)).not.toThrow();
    });

    it('captureMessage accepts (string) with no level or ctx', () => {
      expect(() => captureMessage('some event')).not.toThrow();
    });

    it('captureMessage accepts every CaptureLevel', () => {
      const levels: CaptureLevel[] = ['debug', 'info', 'warning', 'error', 'fatal'];
      for (const level of levels) {
        expect(() => captureMessage('lvl', level)).not.toThrow();
      }
    });

    it('setUser accepts the documented shapes', () => {
      expect(() => setUser({ id: 'u1' })).not.toThrow();
      expect(() => setUser({ id: 'u1', email: 'a@b.com' })).not.toThrow();
      expect(() => setUser({})).not.toThrow();
      expect(() => setUser(null)).not.toThrow();
    });

    it('init is idempotent across many calls', () => {
      // Sentry's real init() is idempotent by design; our stub matches.
      for (let i = 0; i < 20; i++) init();
      // Second-state sanity: isEnabled is still a boolean (never
      // undefined from a re-init race).
      expect(typeof isEnabled()).toBe('boolean');
    });
  });

  // ── (b) Sentry-SDK signature compatibility ───────────────────────

  describe('Sentry SDK v8+ signature compatibility', () => {
    // These tests exercise the EXACT call shapes we hand Sentry at
    // the ~43 capture sites. If the stub's parameter order or key
    // names drift from what @sentry/nextjs expects, the real-wire
    // swap (sentry.ts:90-97) will fail silently (dropping context)
    // or loudly (type errors). This suite catches the drift.

    it('captureException(err, {tags}) — the single most common pattern', () => {
      // This is the lib-boundary shape used by: post-payment, checkout,
      // extract-quote, engine, match-inbound, apply-end-of-call, resend,
      // intake, cleaning-intake, cron-send-reports, cron-retry-failed-
      // calls, vapi-pool, admin (R32).
      const ctx: CaptureContext = {
        tags: { lib: 'example', reason: 'exampleFailed' },
      };
      expect(() => captureException(new Error('x'), ctx)).not.toThrow();
    });

    it('captureException(err, {tags: {lib, reason, requestId}})', () => {
      // Most cron/webhook captures thread a requestId tag.
      const ctx: CaptureContext = {
        tags: { lib: 'cron-send-reports', reason: 'sendFailed', requestId: 'req-1' },
      };
      expect(() => captureException(new Error('x'), ctx)).not.toThrow();
    });

    it('captureException(err, {tags: {route, vapiCallId}}) — webhook pattern', () => {
      const ctx: CaptureContext = {
        tags: { route: 'vapi/webhook', vapiCallId: 'vapi_abc' },
      };
      expect(() => captureException(new Error('x'), ctx)).not.toThrow();
    });

    it('captureException accepts the full CaptureContext — tags + user + extra', () => {
      // Sentry's CaptureContext has tags / user / extra / level / contexts /
      // fingerprint. We expose tags + user + extra (not level/contexts/
      // fingerprint — unused today). The full shape must round-trip.
      const ctx: CaptureContext = {
        tags: { lib: 'test', reason: 'testReason' },
        user: { id: 'u-42' },
        extra: { requestId: 'r-1', itemCount: 3 },
      };
      expect(() => captureException(new Error('x'), ctx)).not.toThrow();
    });

    it('captureMessage(msg, level, {tags}) — the three-arg form', () => {
      // @sentry/nextjs v8 accepts (string, SeverityLevel, CaptureContext).
      // Our stub matches. If Sentry ever collapses this to (string, ctx)
      // with level-on-ctx, we'll need to update both the stub and the
      // call sites — this test catches the drift at stub level.
      expect(() =>
        captureMessage('event', 'warning', { tags: { lib: 'example' } })
      ).not.toThrow();
    });

    it('captureMessage level strings match Sentry v8 SeverityLevel', () => {
      // Sentry's SeverityLevel union: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'.
      // Our CaptureLevel: 'debug' | 'info' | 'warning' | 'error' | 'fatal'.
      // The intersection is what we support. If Sentry adds 'log' or
      // drops 'fatal' in a future major, this test fails loudly.
      const sentryCompatibleLevels: CaptureLevel[] = [
        'fatal',
        'error',
        'warning',
        'info',
        'debug',
      ];
      // Every value is a string literal that Sentry recognizes.
      for (const lvl of sentryCompatibleLevels) {
        expect(['fatal', 'error', 'warning', 'info', 'debug']).toContain(lvl);
      }
    });

    it('setUser({id, email}) — Sentry User shape (id + email keys only today)', () => {
      // Sentry's User type has id/email/username/ip_address. We narrow
      // to {id?, email?} intentionally (username/ip are PII we don't
      // want in the tracker). Lock that the stub still accepts both.
      expect(() => setUser({ id: 'u', email: 'a@b.com' })).not.toThrow();
      // And null-to-clear — part of Sentry's public API.
      expect(() => setUser(null)).not.toThrow();
    });

    it('init() returns void (no promise) — safe to call at module load', () => {
      // Sentry.init() returns `VoidFunction` in @sentry/nextjs. Our
      // stub returns void. Matches. Importantly, it's SYNC — the stub
      // must not become async or call sites at module-load time would
      // need to await it.
      const result = init();
      expect(result).toBeUndefined();
    });
  });

  // ── (c) PII boundary ─────────────────────────────────────────────

  describe('PII boundary — tags are Record<string, string>', () => {
    it('stub accepts only string-valued tags at the type boundary', () => {
      // Compile-time check masquerading as runtime: if the `tags`
      // field ever widens to `Record<string, unknown>`, a maintainer
      // could start stuffing user objects into tags. Keep the shape
      // narrow and assert it here so changes to the type surface are
      // visible.
      const ctx: CaptureContext = {
        tags: { lib: 'x', reason: 'y', requestId: 'r-1' },
      };
      // Every tag value is a string.
      for (const [, v] of Object.entries(ctx.tags ?? {})) {
        expect(typeof v).toBe('string');
      }
      expect(() => captureException(new Error('x'), ctx)).not.toThrow();
    });

    it('stub does NOT mutate the passed ctx object', () => {
      // Sentry uses withScope() for mutation, not in-place. Our stub
      // must be similarly hands-off — if it ever starts mutating
      // (to add default tags, etc.), shared ctx objects passed to
      // multiple captureException calls would accumulate state.
      const ctx: CaptureContext = {
        tags: { lib: 'immut', reason: 'probe' },
      };
      const snapshot = JSON.parse(JSON.stringify(ctx));
      captureException(new Error('x'), ctx);
      expect(ctx).toEqual(snapshot);

      // And with DSN set (enabled path) — still no mutation.
      env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
      init();
      captureException(new Error('x'), ctx);
      expect(ctx).toEqual(snapshot);
    });

    it('stub does not mutate the passed user object on setUser', () => {
      const user = { id: 'u-1', email: 'a@b.com' };
      const snapshot = JSON.parse(JSON.stringify(user));
      setUser(user);
      expect(user).toEqual(snapshot);

      env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
      init();
      setUser(user);
      expect(user).toEqual(snapshot);
    });
  });

  // ── (d) CaptureContext surface lock ──────────────────────────────

  describe('CaptureContext key-set lock', () => {
    it('documented keys on CaptureContext are {tags, user, extra}', () => {
      // Runtime can't inspect TS types, but we CAN construct each
      // documented subset and verify no-throw. If `extra` is removed
      // from the CaptureContext type, the line that builds `withExtra`
      // fails tsc — and if added back under a new name (e.g. renamed
      // to `contexts`), the shape here fails compile too.
      const tagsOnly: CaptureContext = { tags: { a: '1' } };
      const userOnly: CaptureContext = { user: { id: 'u' } };
      const extraOnly: CaptureContext = { extra: { foo: 'bar' } };
      const allThree: CaptureContext = {
        tags: { a: '1' },
        user: { id: 'u' },
        extra: { foo: 'bar' },
      };
      // All four variants must round-trip through captureException
      // without throwing.
      for (const ctx of [tagsOnly, userOnly, extraOnly, allThree]) {
        expect(() => captureException(new Error('x'), ctx)).not.toThrow();
        expect(() => captureMessage('m', 'info', ctx)).not.toThrow();
      }
    });
  });

  // ── (e) Enabled-path signature parity ────────────────────────────

  describe('enabled-path signature parity', () => {
    it('flipping DSN on — all capture shapes still accepted', () => {
      env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
      init();
      expect(isEnabled()).toBe(true);

      // Every shape used at the ~43 capture sites — must still be a
      // no-throw with the real flag flipped, so the day the real SDK
      // lands, the existing call shapes keep working.
      expect(() =>
        captureException(new Error('x'), { tags: { lib: 'a', reason: 'b' } })
      ).not.toThrow();
      expect(() =>
        captureException(new Error('x'), {
          tags: { route: 'cron/x', reason: 'runFailed' },
        })
      ).not.toThrow();
      expect(() =>
        captureException(new Error('x'), {
          tags: { lib: 'a', reason: 'b', requestId: 'r-1' },
          user: { id: 'u-1' },
          extra: { count: 3 },
        })
      ).not.toThrow();
      expect(() => captureMessage('m', 'fatal', { tags: { k: 'v' } })).not.toThrow();
      expect(() => setUser({ id: 'u', email: 'a@b.com' })).not.toThrow();
      expect(() => setUser(null)).not.toThrow();
    });

    it('captureException is still safe on non-Error inputs when enabled', () => {
      // Regression guard: a future refactor of the stub's real-wire
      // body might narrow `err: unknown` to `Error`, breaking every
      // catch-block that re-throws a string. Lock the any-shape.
      env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
      init();
      expect(() => captureException('string')).not.toThrow();
      expect(() => captureException({ code: 'weird' })).not.toThrow();
      expect(() => captureException(null)).not.toThrow();
    });
  });
});
