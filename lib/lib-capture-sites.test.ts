// R34 lib/ capture-site shape audit.
//
// ~41 capture sites across 14 lib/ modules wire captureException. Each
// one has a per-module test locking its SPECIFIC tag shape (reason
// allow-list, ctx keys, PII boundary). Per-module tests catch drift
// within a single module. They do NOT catch:
//
//   • A new lib module that adds captureException but forgets the
//     `lib:` anchor tag — Sentry event-groups into the generic bucket.
//   • A module that drops the `tags` object entirely and passes only
//     an Error — event lands in the generic bucket with no facet.
//   • A module that starts tagging a `reason` with an ad-hoc value
//     that isn't reflected in any per-module allow-list.
//   • A module that invents a fourth tag key (domain:, errorCode:,
//     severity:) that escapes every existing per-module assertion.
//
// This file is a CROSS-LIB shape audit — grep-level, not runtime. It
// reads every non-test lib/*.ts (recursively) and asserts that EVERY
// captureException invocation visible in the source either:
//
//   (a) Includes a `tags:` object containing at minimum `lib:` AND
//       `reason:` (canonical shape per R32 memo), OR
//   (b) Is on the approved no-tags allow-list below (documented
//       exceptions — none today).
//
// Routes-side sibling: `app/api-capture-sites.test.ts` (R33). That
// one locks `route:` tag anchors for app/* capture sites; this one
// locks `lib:` + `reason:` anchors for lib/* capture sites.
//
// NEGATIVE contract sibling: `lib/security/no-capture-audit.test.ts`
// (R33) — that one enforces ZERO capture in 7 security modules; this
// one enforces POSITIVE shape for every other lib capture site.
//
// Canonical shapes (from evenquote_project.md R32/R33 close):
//   • {lib:'vapi', reason:'startCall*'}
//   • {lib:'match-inbound', reason:'businessesLookupFailed'|'callsLookupFailed'}
//   • {lib:'apply-end-of-call', reason:'quotesInsertFailed'|'recomputeFailed'}
//   • {lib:'enqueue', reason:'claimFailed'|'insertFailed'|'plannedCountUpdateFailed'|'callIdPersistFailed'|'noBusinessesFallbackFailed'}
//   • {lib:'extract-quote', reason:'extractHttpFailed'|'extractMissingToolUse'|'extractSchemaCoercionFailed'|'extractTransportFailed'}
//   • {lib:'cron-send-reports', reason:'sendFailed'|'finalStampFailed'|'refundLookupFailed'|'refundCreateFailed'|'refundStatusUpdateFailed'}
//   • {lib:'cron-retry-failed-calls', reason:'candidateQueryFailed'|'applyCallEndFailed'}
//   • {lib:'post-payment', reason:'signInWithOtp'}
//   • {lib:'checkout', reason:'stripeSessionCreateFailed'|'stripeReturnedEmptyUrl'}
//   • {lib:'resend', reason:'sendApiErrored'|'sendResponseMissingId'|'sendTransportFailed'}
//   • {lib:'intake', reason:'categoryLookupFailed'|'insertFailed', vertical:'moving'|'cleaning'}
//   • {lib:'vapi-pool', reason:'pickRpcErrored'|'pickRpcThrew'}
//   • {lib:'admin', reason:'archiveUpdateFailed'}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Walk lib/ for every non-test .ts file (excluding the Sentry wrapper
// itself — that module DEFINES captureException and shouldn't be
// audited as if it were a call site).
function collectLibFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      // Sentry wrapper DEFINES the function — its own unit tests
      // validate signature parity (lib/observability/sentry-wiring.test.ts).
      if (p.endsWith(path.join('lib', 'observability', 'sentry.ts'))) continue;
      // Barrel re-exports have no capture logic.
      if (entry.name === 'exports.ts') continue;
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Extract every captureException(...) call including its argument
// list. Balanced-paren scan — regex alone is not enough because the
// ctx objects nest object literals. Mirrors the app/api-capture-sites
// walker.
function extractCaptureCalls(source: string): string[] {
  const out: string[] = [];
  const lines = source.split('\n');
  let buf = '';
  let paren = 0;
  let collecting = false;
  for (const line of lines) {
    // Strip single-line comments before scanning tokens.
    const codeOnly = line.replace(/\/\/.*$/, '');
    for (let i = 0; i < codeOnly.length; i++) {
      if (!collecting) {
        if (
          codeOnly.slice(i, i + 'captureException('.length) === 'captureException(' &&
          (i === 0 || !/[A-Za-z0-9_$]/.test(codeOnly[i - 1]))
        ) {
          collecting = true;
          buf = 'captureException(';
          paren = 1;
          i += 'captureException('.length - 1;
          continue;
        }
      } else {
        const ch = codeOnly[i];
        buf += ch;
        if (ch === '(') paren++;
        else if (ch === ')') {
          paren--;
          if (paren === 0) {
            out.push(buf);
            collecting = false;
            buf = '';
          }
        }
      }
    }
    if (collecting) buf += '\n';
  }
  return out;
}

const LIB_DIR = path.resolve(__dirname);

// Pre-compute once per suite — expensive in aggregate (I/O) but cheap
// per-test.
const libFiles = collectLibFiles(LIB_DIR);
const fileCalls: Array<{ file: string; call: string }> = [];
for (const file of libFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const call of extractCaptureCalls(source)) {
    fileCalls.push({ file, call });
  }
}

describe('lib/ capture-site shape audit (R34)', () => {
  it('discovers at least one capture site (sanity check on the walker)', () => {
    expect(fileCalls.length).toBeGreaterThan(0);
  });

  it('every captureException call includes a `tags:` object', () => {
    const violations: string[] = [];
    for (const { file, call } of fileCalls) {
      if (!/\btags\s*:/.test(call)) {
        violations.push(
          `${path.relative(LIB_DIR, file)}: ${call.slice(0, 120).replace(/\s+/g, ' ')}…`,
        );
      }
    }
    expect(violations, `capture sites missing tags: ${violations.join('\n')}`).toEqual([]);
  });

  it('every captureException call anchors a `lib:` tag (inline OR via helper/spread)', () => {
    // The `lib:` tag is the minimum fingerprint anchor for Sentry
    // event grouping across lib captures. Without it, a new site
    // groups into the generic bucket and becomes invisible in the
    // Sentry issues list.
    //
    // A lib can resolve `lib:` one of three ways:
    //   (a) inline: `tags: { lib: 'admin', ... }`
    //   (b) via spread: `tags: { ...baseCaptureTags, reason: ... }`
    //       — then the file must contain a `lib:` literal nearby.
    //   (c) via helper: `tags: tagsFor('reason')` where the helper
    //       declaration (same file) defines `lib:`.
    // All three pass the per-module test; the audit here accepts any
    // of them. A call that has NEITHER inline lib nor any spread/helper
    // reference to file-level `lib:` is a real violation.
    const violations: string[] = [];
    for (const { file, call } of fileCalls) {
      if (/\blib\s*:/.test(call)) continue; // inline wins
      // Look at the surrounding file — if the file declares `lib:`
      // in any context AND the call uses a spread or helper, accept.
      const source = fs.readFileSync(file, 'utf8');
      const usesSpreadOrHelper =
        /\.{3}\s*[A-Za-z_$][\w$]*/.test(call) ||
        /\btags\s*:\s*[A-Za-z_$][\w$]*\s*\(/.test(call);
      const fileDeclaresLib = /\blib\s*:/.test(source);
      if (usesSpreadOrHelper && fileDeclaresLib) continue;
      violations.push(
        `${path.relative(LIB_DIR, file)}: ${call.slice(0, 120).replace(/\s+/g, ' ')}…`,
      );
    }
    expect(violations, `capture sites missing lib tag: ${violations.join('\n')}`).toEqual([]);
  });

  it('every captureException call anchors a `reason:` tag (inline OR via helper/spread)', () => {
    // `reason:` is the per-module discriminator that maps to each
    // module's exported Reason type (ResendReason, CheckoutReason,
    // etc.). Same resolution rules as `lib:` — inline, spread, or
    // helper are all valid.
    const violations: string[] = [];
    for (const { file, call } of fileCalls) {
      if (/\breason\s*:/.test(call)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const usesSpreadOrHelper =
        /\.{3}\s*[A-Za-z_$][\w$]*/.test(call) ||
        /\btags\s*:\s*[A-Za-z_$][\w$]*\s*\(/.test(call);
      const fileDeclaresReason = /\breason\s*:/.test(source);
      if (usesSpreadOrHelper && fileDeclaresReason) continue;
      violations.push(
        `${path.relative(LIB_DIR, file)}: ${call.slice(0, 120).replace(/\s+/g, ' ')}…`,
      );
    }
    expect(
      violations,
      `capture sites missing reason tag: ${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('every lib file that contains a capture call also declares both lib: and reason: at the file level', () => {
    // Per-file sanity: even when a call uses a spread or helper, the
    // file MUST contain `lib:` and `reason:` string-keyed somewhere
    // (inside a helper, base tag object, or inline). A file that
    // captures but never declares `lib:`/`reason:` anywhere is broken.
    const fileViolations: string[] = [];
    const filesWithCaptures = new Set(fileCalls.map((c) => c.file));
    for (const file of filesWithCaptures) {
      const source = fs.readFileSync(file, 'utf8');
      if (!/\blib\s*:/.test(source)) {
        fileViolations.push(
          `${path.relative(LIB_DIR, file)}: file contains captureException but never declares a \`lib:\` tag key`,
        );
      }
      if (!/\breason\s*:/.test(source)) {
        fileViolations.push(
          `${path.relative(LIB_DIR, file)}: file contains captureException but never declares a \`reason:\` tag key`,
        );
      }
    }
    expect(
      fileViolations,
      `files missing tag declarations: ${fileViolations.join('\n')}`,
    ).toEqual([]);
  });

  it('no captureException call tags a forbidden ad-hoc top-level key', () => {
    // A future site that adds `domain:` or `errorCode:` or `severity:`
    // at the top level would escape every per-module test. Lock the
    // set of approved top-level keys — if a legitimate new key is
    // needed, add it to the allow-list AND update the per-module
    // test with a shape assertion.
    const FORBIDDEN_TAG_KEYS = [
      /\btags\s*:\s*\{[^}]*\bdomain\s*:/,
      /\btags\s*:\s*\{[^}]*\berrorCode\s*:/,
      /\btags\s*:\s*\{[^}]*\bseverity\s*:/,
    ];
    const violations: string[] = [];
    for (const { file, call } of fileCalls) {
      for (const pat of FORBIDDEN_TAG_KEYS) {
        if (pat.test(call)) {
          violations.push(
            `${path.relative(LIB_DIR, file)}: forbidden ad-hoc tag key ${pat}`,
          );
        }
      }
    }
    expect(violations, `shape drift: ${violations.join('\n')}`).toEqual([]);
  });

  it('no captureException call leaks PII into tags', () => {
    // PII boundary at cross-lib level. Per-module tests each assert
    // this for their own tag bag, but a new capture site that lifts a
    // customer email / phone / API key into tags by mistake wouldn't
    // be caught by the existing tests if the site is added to a
    // module that doesn't already have a PII assertion.
    const FORBIDDEN_PII_KEYS = [
      /\btags\s*:\s*\{[^}]*\bemail\s*:/,
      /\btags\s*:\s*\{[^}]*\bphone\s*:/,
      /\btags\s*:\s*\{[^}]*\btoken\s*:/,
      /\btags\s*:\s*\{[^}]*\bpassword\s*:/,
      /\btags\s*:\s*\{[^}]*\bapiKey\s*:/,
      /\btags\s*:\s*\{[^}]*\bname\s*:/,
      /\btags\s*:\s*\{[^}]*\baddress\s*:/,
    ];
    const violations: string[] = [];
    for (const { file, call } of fileCalls) {
      for (const pat of FORBIDDEN_PII_KEYS) {
        if (pat.test(call)) {
          violations.push(
            `${path.relative(LIB_DIR, file)}: forbidden PII key pattern ${pat}`,
          );
        }
      }
    }
    expect(violations, `PII leak into tags: ${violations.join('\n')}`).toEqual([]);
  });

  it('total captureException count across lib/ stays inside the expected band', () => {
    // Tripwire: a silent addition of 10 new sites (e.g. a refactor
    // that widens capture coverage without updating memory) would
    // trip this. Current R33 close ~41 capture sites in lib/ (excludes
    // the 7 security modules under the NEGATIVE contract and the
    // sentry.ts wrapper itself).
    //
    // Band is deliberately wide (30-80) to allow organic growth as
    // more library audits land, but narrow enough to catch a "scripts
    // dumped 30 new captures" accident.
    const total = fileCalls.length;
    expect(total, `lib capture sites = ${total}; expected 30-80`).toBeGreaterThanOrEqual(30);
    expect(total, `lib capture sites = ${total}; expected 30-80`).toBeLessThanOrEqual(80);
  });

  it('every capture-wiring lib file lives under an expected subtree', () => {
    // Catches a refactor that accidentally puts capture logic under
    // an unexpected path (e.g. lib/components or lib/types) where it
    // shouldn't exist. Known subtrees: actions, calls, cron, email,
    // ingest (R47 on-demand seeder), observability (the wrapper itself
    // — but excluded from walk).
    const EXPECTED_SUBTREES = [
      'actions',
      'calls',
      'cron',
      'email',
      'ingest',
      'observability',
    ];
    const touchedSubtrees = new Set<string>();
    for (const { file } of fileCalls) {
      const rel = path.relative(LIB_DIR, file);
      const top = rel.split(path.sep)[0];
      touchedSubtrees.add(top);
    }
    const unexpected = [...touchedSubtrees].filter(
      (t) => !EXPECTED_SUBTREES.includes(t),
    );
    expect(
      unexpected,
      `capture wiring found under unexpected subtree(s): ${unexpected.join(', ')}. ` +
        `If intentional, add to EXPECTED_SUBTREES here.`,
    ).toEqual([]);
  });
});
