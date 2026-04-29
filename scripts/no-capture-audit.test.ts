// R34 no-capture audit — scripts/* CLI modules.
//
// Every file in scripts/ is an operator-invoked CLI: ingest, verify,
// seed, analyze, e2e walker. They run manually (or from a Makefile /
// package.json script), NOT on the request-handling hot path and NOT
// on any cron-like schedule under Vercel. That shapes the no-capture
// contract:
//
//   • Scripts log structured lines to stdout/stderr and exit non-zero
//     on failure. A developer running the script sees the failure
//     immediately in their terminal — no Sentry value add.
//   • Scripts are bounded-frequency by definition (human-triggered),
//     but their failure SHAPE is noisy: every dev running a seeding
//     script on a misconfigured local DB would fire identical Sentry
//     events. That's alert pollution, not signal.
//   • Scripts often deliberately use SERVICE_ROLE_KEY and expect env
//     gaps to throw — `createAdminClient()` throwing at construct
//     time is R29 config-state-no-capture. A script wiring Sentry
//     would capture on every "forgot to export my env" moment.
//   • The e2e walker in particular hammers real routes during local
//     dev — it SHOULD exercise happy paths and, for error paths, the
//     routes themselves capture (they're the service-of-record).
//     Scripts adding their own captures would double-capture with
//     the route-level ones that already fire (R26 no-double-capture).
//
// This file is a GREP-ASSERTED allow-list. It reads the source of
// every script and asserts none of them import or call any
// `captureException`/`captureMessage` from `@/lib/observability/sentry`
// or the Sentry SDK directly.
//
// Regression guards:
//   • Directory sync — a new script file that lands without being
//     added to the allow-list fails the test.
//   • Allow-list freshness — a rename/delete that leaves the allow-
//     list pointing at a missing file fails the test.
//
// If a future maintainer legitimately wants a capture in a script
// (e.g. an operator-run backfill that must page on an inconsistency
// discovered mid-run), they must:
//   1. Remove the script from NO_CAPTURE_SCRIPTS and add a
//      justification comment.
//   2. Add a positive capture-site lock in a sibling test file
//      covering reason, tags, and PII guards (same way the R33 app/
//      capture-site audit enforces route: tag presence).
//
// Canonical siblings:
//   • lib/security/no-capture-audit.test.ts (R33) — security-module
//     negative contract, same shape.
//   • app/api-capture-sites.test.ts (R33) — positive contract for
//     app/ capture sites (route: tag required).
//   • app/api/csp-report/route.test.ts + health/version route tests
//     (R32/R33) — per-route attestation siblings.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPTS_DIR = path.resolve(__dirname);

// Allow-list of scripts where capture must NOT appear. Keep aligned
// with the actual directory — the directory-sync guard below fails if
// a new *.ts lands here without being listed.
const NO_CAPTURE_SCRIPTS = [
  'analyze-csp-reports.ts',
  'apply-migration.ts',
  'ingest-businesses.ts',
  'launch-readiness.ts',
  'patch-vapi-speaking-style.ts',
  'patch-vapi-tunnel-url.ts',
  'seed-csp-sample.ts',
  'smoke-seed-on-demand.ts',
  'smoke-webhook-preview.ts',
  'test-e2e.ts',
  'verify-db.ts',
  'wipe-quote-data.ts',
] as const;

// Tokens that indicate capture wiring. Mirrors lib/security/no-capture
// audit — any alias (`Sentry.captureException`, re-exported wrapper,
// etc.) still trips the guard.
const CAPTURE_TOKENS = [
  /\bcaptureException\b/,
  /\bcaptureMessage\b/,
  /\bSentry\.capture\b/,
  /from\s+['"]@\/lib\/observability\/sentry['"]/,
  /from\s+['"]@sentry\/nextjs['"]/,
];

function readScript(file: string): string {
  return fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
}

// Strip TS line + block comments so doc-comments that legitimately
// name capture tokens (like this file itself) don't false-positive.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('scripts/ no-capture audit (R34)', () => {
  for (const script of NO_CAPTURE_SCRIPTS) {
    describe(script, () => {
      it('does not import from the sentry wrapper or the Sentry SDK', () => {
        const source = stripComments(readScript(script));
        for (const token of CAPTURE_TOKENS) {
          const match = source.match(token);
          expect(
            match,
            `${script} unexpectedly matched ${token} — scripts are operator-invoked CLIs and must not capture. ` +
              `If you need a capture site here, remove this script from NO_CAPTURE_SCRIPTS and add a justification comment.`,
          ).toBeNull();
        }
      });

      it('is wired only through console.log/console.error for signal (not capture.*)', () => {
        // Scripts surface signal via stdout/stderr for the operator
        // running them. A script that stopped logging altogether
        // would be fine; one that quietly swapped log for capture
        // would widen the Sentry surface without adding signal.
        const source = stripComments(readScript(script));
        const capturedSomewhere = CAPTURE_TOKENS.some((t) => t.test(source));
        expect(
          capturedSomewhere,
          `${script} contained a capture-indicative token after stripping comments`,
        ).toBe(false);
      });
    });
  }

  it('allow-list stays in sync with the actual directory', () => {
    // A new script that lands without being added to the allow-list
    // would silently escape the audit. This guard reads the directory
    // and asserts every *.ts (non-test) file is accounted for.
    const entries = fs
      .readdirSync(SCRIPTS_DIR)
      .filter(
        (f) =>
          f.endsWith('.ts') &&
          !f.endsWith('.test.ts') &&
          !f.endsWith('.d.ts'),
      );
    const missing = entries.filter(
      (f) => !(NO_CAPTURE_SCRIPTS as readonly string[]).includes(f),
    );
    expect(
      missing,
      `new script(s) found that are not in NO_CAPTURE_SCRIPTS: ${missing.join(', ')}. ` +
        `Either add them to the allow-list or, if they legitimately need capture sites, ` +
        `add a positive capture-site lock in a sibling test file.`,
    ).toEqual([]);
  });

  it('NO_CAPTURE_SCRIPTS references are all real files (no rename drift)', () => {
    // Catches a rename: script moved but allow-list not updated.
    for (const script of NO_CAPTURE_SCRIPTS) {
      const full = path.join(SCRIPTS_DIR, script);
      expect(
        fs.existsSync(full),
        `${script} referenced in allow-list but file does not exist`,
      ).toBe(true);
    }
  });

  it('scripts/ count stays inside the expected band (1-20)', () => {
    // Tripwire: a CI step that accidentally dumps generated scripts
    // into scripts/ would silently add captures we don't notice. A
    // count band catches the class of "10 new files" drift.
    const count = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(20);
  });
});
