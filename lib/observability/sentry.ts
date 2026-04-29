// Sentry (or equivalent error tracker) bolt-on point.
//
// Why this file exists now when we haven't installed @sentry/nextjs:
// `lib/logger.ts` already redacts PII and auto-fingerprints errors.
// That's the hard part. What's missing is the SDK + the DSN.
//
// This stub establishes the *shape* we want at call sites ahead of
// the real integration. The contract is:
//
//   • Call `captureException(err, { tags, user })` wherever you'd
//     normally want an error tracker to see an exception.
//   • Call `captureMessage(msg, level, { tags })` for non-error events
//     that are still worth an alert (e.g. Stripe webhook processed
//     but failed the idempotency check).
//   • Call `setUser({ id, email? })` when you authenticate a user in
//     a server action or route handler — Sentry scopes this to the
//     current request.
//
// When SENTRY_DSN is unset (which is the state on all environments
// today), every function is a no-op. Call sites can be added now
// without waiting for the account signup (user-input #6).
//
// When SENTRY_DSN is set, the intended implementation is:
//   • `init()` calls `Sentry.init({ dsn, tracesSampleRate, …})` once
//     at process start (idempotent).
//   • `captureException` forwards to `Sentry.captureException(err,
//     { tags, user })`.
//   • `setUser` forwards to `Sentry.setUser(...)`.
//
// But we keep the SDK import lazy (dynamic import inside init) so
// the package doesn't need to be a hard dep until we actually use it.
// Today the `require('@sentry/nextjs')` line is commented out; flip
// it live once `npm i @sentry/nextjs` is run.
//
// PII contract: do NOT pass raw exception objects that may contain
// user email / phone / payment data. Use `logger.error('...', { err })`
// as the primary path — the logger already redacts — and use
// `captureException(err)` here ONLY on errors that have been
// constructed by our own code (so we know the message shape).
// Sentry's own scrubbers are a backstop, not the primary defense.

import { createLogger } from '@/lib/logger';

const log = createLogger('sentry-stub');

// ── Module state ──
// Intentional module-scoped mutable state. Sentry's native SDK behaves
// the same way (global hub). We mirror that so switching to the real
// SDK is a one-file swap.
let _initialized = false;
let _enabled = false;

export type CaptureLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

export type CaptureContext = {
  /** Arbitrary string tags for Sentry's search UI. */
  tags?: Record<string, string>;
  /** Current user — id is stable, email is not redacted here. */
  user?: { id?: string; email?: string };
  /** Extra context payload. Gets redacted the same way logger does. */
  extra?: Record<string, unknown>;
};

/**
 * Is the error-tracker wired and ready to send? Useful for:
 *   • Unit tests that want to skip when disabled.
 *   • The `/api/health` endpoint, which already reports feature
 *     readiness for Stripe/Vapi/Resend — Sentry can slot into the same
 *     readiness report once integrated.
 */
export function isEnabled(): boolean {
  return _enabled;
}

/**
 * Initialize the tracker. Idempotent — safe to call from multiple
 * entry points (edge middleware, route handlers, cron). Today this
 * only flips the enabled flag; when `@sentry/nextjs` is installed,
 * uncomment the init block below.
 */
export function init(): void {
  if (_initialized) return;
  _initialized = true;
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    _enabled = false;
    log.info('SENTRY_DSN not set — error tracker disabled (stub mode)');
    return;
  }
  // NOTE: uncomment when @sentry/nextjs is a dep.
  // const Sentry = require('@sentry/nextjs');
  // Sentry.init({
  //   dsn,
  //   tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
  //   environment: process.env.VERCEL_ENV ?? 'development',
  //   release: process.env.VERCEL_GIT_COMMIT_SHA,
  // });
  _enabled = true;
  log.info('Sentry stub marked enabled — SDK wiring pending');
}

/**
 * Capture an exception. No-op when disabled.
 *
 * Do not call this from a hot path without at least a sample rate.
 * Most of our error surfaces fire at request-boundary frequency, so
 * this is fine today. Revisit if we add a tight polling loop.
 */
export function captureException(err: unknown, ctx?: CaptureContext): void {
  if (!_enabled) return;
  // Stub: log-only. When @sentry/nextjs lands, this body becomes:
  //   const Sentry = require('@sentry/nextjs');
  //   Sentry.withScope((scope) => { apply ctx, call Sentry.captureException(err); });
  log.error('capture-exception (stub)', { err, ctx });
}

/**
 * Capture a non-exception message. No-op when disabled.
 */
export function captureMessage(
  msg: string,
  level: CaptureLevel = 'info',
  ctx?: CaptureContext,
): void {
  if (!_enabled) return;
  log.info(`capture-message (stub) [${level}]`, { msg, ctx });
}

/**
 * Set the user for the current scope. No-op when disabled.
 *
 * IMPORTANT: `email` here is NOT redacted. Call sites should be
 * selective about passing it — prefer id-only whenever possible.
 * When Sentry is live and we turn this on, we'll want the Sentry
 * project settings' "scrub data" defaults reviewed separately.
 */
export function setUser(user: { id?: string; email?: string } | null): void {
  if (!_enabled) return;
  // Stub path.
  log.debug('set-user (stub)', {
    user: user ? { id: user.id, hasEmail: Boolean(user.email) } : null,
  });
}

/**
 * Test-only: reset module state so unit tests can exercise init()
 * without cross-test leakage. NOT part of the production API.
 *
 * Exported so the test file can call it. Name is deliberately ugly
 * (`__resetForTests`) so an accidental production call stands out.
 */
export function __resetForTests(): void {
  _initialized = false;
  _enabled = false;
}
