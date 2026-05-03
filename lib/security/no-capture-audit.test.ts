// R33 no-capture audit — lib/security/* modules.
//
// Every helper in lib/security/* is an adversarial-frequency gate: it
// rejects tampered, malformed, or replayed requests on the hot path of
// a public inbound webhook or a public rate-limited endpoint. That
// makes the no-capture contract LOAD-BEARING:
//
//   • A single forged-signature request during a Stripe retry storm
//     can cost nothing — but a spray of 10k tampered POSTs against the
//     webhook would translate to 10k Sentry events, ruining the signal
//     for a legitimate webhook regression.
//   • Rate-limit refusals are, BY DEFINITION, the attacker's best
//     trigger for flooding: capturing a 429 on every limited request
//     would make our own rate limiter a Sentry amplifier.
//   • Constant-time-equal and CSP helpers are pure utility code on the
//     auth hot path — they must never capture because they run on
//     every probe, not just the ones that matter.
//
// This file is a GREP-ASSERTED allow-list. It reads the source of
// every security module and asserts none of them import or call any
// `captureException`/`captureMessage` from `@/lib/observability/sentry`.
//
// Why grep rather than runtime-mock-and-exercise: the security
// modules have many small branches and some (like cron-auth) run only
// against specific env configs. Exhaustively exercising every branch
// inside this file would duplicate the coverage the individual
// module tests already provide. Regex-against-the-source is both
// cheaper and stricter: it catches a capture site added to a branch
// the per-module tests don't happen to hit.
//
// If a future maintainer wants to legitimately add a Sentry capture
// to one of these helpers (e.g. an operator wants an alert when
// Stripe secret ROTATION is detected), they must:
//   1. Update the allow-list below with a justification comment.
//   2. Update the target module's own test file with a positive
//      capture-site lock (reason, tags, PII guard).
//
// Canonical siblings:
//   • app/api/csp-report/route.test.ts "observability contract — no
//     capture" (R32) — telemetry-sink attestation.
//   • app/api/health/route.test.ts + app/api/version/route.test.ts
//     observability-contract blocks (R33) — probe-endpoint attestation.
//   • lib/calls/engine.test.ts `LOCKED_REASONS` / regression-guard —
//     POSITIVE capture allow-list (counterpoint: those sites MUST
//     fire, these sites MUST NOT).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// List of security modules where captureException/captureMessage must
// NOT appear. Keep this aligned with what the per-module tests cover
// so a security helper that splits into a new file is caught on the
// next test sweep.
//
// If you intentionally need a capture site in one of these files,
// remove it from this list AND add a justification comment.
const NO_CAPTURE_MODULES = [
  'stripe-auth.ts',
  'vapi-auth.ts',
  'rate-limit-auth.ts',
  'cron-auth.ts',
  'dev-token-auth.ts',
  'constant-time-equal.ts',
  'csp.ts',
  // 2026-05-02: three additional adversarial-frequency gates landed
  // post-launch. All three are pure validators with no Sentry surface
  // (verified by grep at audit time):
  //   • honeypot.ts — checks the hidden honeypot field on intake forms;
  //     a tripped honeypot is the BOT's best Sentry-amplification trigger.
  //   • scrub-pii.ts — best-effort PII redaction before free-text reaches
  //     downstream surfaces (call prompts, logs). Failure modes are
  //     "scrub didn't catch this" — observability lives in unit tests,
  //     not Sentry.
  //   • turnstile.ts — Cloudflare Turnstile token verification on intake.
  //     Token rejection is, by design, an attacker probe — capturing
  //     would amplify the floodable surface.
  'honeypot.ts',
  'scrub-pii.ts',
  'turnstile.ts',
] as const;

// Tokens that indicate a capture call or import site. These are
// matched against the source TEXT so a future `captureException` added
// under any alias (`capture`, `Sentry.captureException`, a re-exported
// wrapper) still trips the guard. We do NOT match the shorter `capture`
// because it would false-positive on `timingSafeEqual capture` comments.
const CAPTURE_TOKENS = [
  /\bcaptureException\b/,
  /\bcaptureMessage\b/,
  /\bSentry\.capture\b/,
  /from\s+['"]@\/lib\/observability\/sentry['"]/,
  /from\s+['"]@sentry\/nextjs['"]/,
];

function readModule(file: string): string {
  const full = path.join(__dirname, file);
  return fs.readFileSync(full, 'utf8');
}

describe('lib/security no-capture audit (R33)', () => {
  for (const mod of NO_CAPTURE_MODULES) {
    describe(mod, () => {
      it('does not import from the sentry wrapper or the Sentry SDK', () => {
        const source = readModule(mod);
        for (const token of CAPTURE_TOKENS) {
          const match = source.match(token);
          expect(
            match,
            `${mod} unexpectedly matched ${token} — security helpers are adversarial-frequency gates and must not capture. ` +
              `If you need a capture site here, remove this module from NO_CAPTURE_MODULES and add a justification comment.`,
          ).toBeNull();
        }
      });

      it('is wired only through createLogger for signal (log.* not capture.*)', () => {
        // Security helpers surface their signal via the structured
        // log drain, not Sentry. A helper that stopped logging
        // altogether would be fine (some, like constant-time-equal,
        // genuinely have nothing to log), but one that quietly swapped
        // a log for a capture would widen the Sentry surface.
        const source = readModule(mod);
        // If captureException got added under a new alias, at least
        // one of these token patterns should match. Double-checked
        // against the capture-token list above.
        const capturedSomewhere = CAPTURE_TOKENS.some((t) => t.test(source));
        expect(capturedSomewhere, `${mod} contained a capture-indicative token`).toBe(false);
      });
    });
  }

  it('allow-list stays in sync with the actual directory', () => {
    // A new security module that lands without being added to the
    // allow-list would silently escape the audit. This guard reads
    // the directory and asserts every *.ts (non-test, non-exports)
    // file is accounted for.
    const dir = __dirname;
    const entries = fs
      .readdirSync(dir)
      .filter(
        (f) =>
          f.endsWith('.ts') &&
          !f.endsWith('.test.ts') &&
          f !== 'exports.ts' &&
          // exports.test.ts lives here but is a test file
          !f.startsWith('index'),
      );
    const missing = entries.filter(
      (f) => !(NO_CAPTURE_MODULES as readonly string[]).includes(f),
    );
    expect(
      missing,
      `new security module(s) found that are not in NO_CAPTURE_MODULES: ${missing.join(', ')}. ` +
        `Either add them to the allow-list or, if they legitimately need capture sites, ` +
        `add a positive capture-site lock in their own test file.`,
    ).toEqual([]);
  });

  it('NO_CAPTURE_MODULES references are all real files (no drift)', () => {
    // Catches a rename: module moved but allow-list not updated.
    for (const mod of NO_CAPTURE_MODULES) {
      const full = path.join(__dirname, mod);
      expect(fs.existsSync(full), `${mod} referenced in allow-list but file does not exist`).toBe(
        true,
      );
    }
  });
});
