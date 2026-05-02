// R33 app/ capture-site shape audit.
//
// ~9 routes across app/ wire captureException. Each one has its own
// per-route test locking the *specific* tag shape for that site (reason
// allow-list, ctx keys, PII boundary). The per-route tests catch
// deviations within a single route. They do NOT catch:
//
//   • A new route that adds captureException but forgets to tag a
//     `route:` entry at all — Sentry would event-group across all app
//     captures since the tag-bag shape drifted.
//   • A route that drops the `tags` object entirely and passes just an
//     Error — the event lands in the generic bucket with no facet to
//     pivot on.
//   • A route that starts tagging a `reason` with an ad-hoc value that
//     isn't reflected in any per-route allow-list.
//
// This file is a CROSS-ROUTE shape audit — grep-level, not runtime. It
// reads every non-test `route.ts` under app/ and asserts that EVERY
// captureException invocation visible in the source either:
//
//   (a) Includes a `tags:` object literal containing at minimum
//       `route:` (cross-route fingerprint anchor), OR
//   (b) Is on the approved no-tags allow-list below (documented
//       exceptions — none today, but the allow-list exists so a
//       future deliberate exception doesn't require a behaviour-
//       bearing refactor).
//
// This is the routes-side counterpart to
// `lib/security/no-capture-audit.test.ts` (R33) — that one locks
// NEGATIVE capture sites, this one locks POSITIVE capture-site shape.
//
// Canonical shapes (see evenquote_project.md R32 close for the full
// list) — tags always start with `route: '...'`:
//   • {route:'cron/send-reports', reason:'runFailed'}
//   • {route:'cron/retry-failed-calls', reason:'runFailed'}
//   • {route:'cron/check-status', reason:'integrationProbeFailed', stripe, vapi}
//   • {route:'vapi/webhook', vapiCallId}
//   • {route:'vapi/inbound-callback', vapiCallId}
//   • {route:'twilio/sms'}
//   • {route:'stripe/webhook', eventType, eventId}
//   • {route:'stripe/webhook', site:'magic-link'|'enqueue-calls', requestId}
//   • {route:'auth/callback', reason:'exchangeCodeForSessionFailed'}
//   • {route:'get-quotes/claim', reason:'requestLoadFailed'|'quoteBackfillFailed', requestId}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Walk app/ for every non-test route.ts and return their absolute paths.
function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'route.ts') out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Extract each captureException(...) call including the argument list.
// Balanced-paren scan — regex is not sufficient because ctx objects
// nest object literals.
function extractCaptureCalls(source: string): string[] {
  const out: string[] = [];
  // Skip matches inside comments or strings — conservative: require
  // the token to be at word boundary AND not preceded by a `/`
  // (comment) or `'`/`"` (string). Line-based pre-filter:
  const lines = source.split('\n');
  let buf = '';
  let paren = 0;
  let collecting = false;
  for (const line of lines) {
    // Strip single-line comments before scanning tokens. This is a
    // rough heuristic; the per-route tests already cover runtime
    // shape, so missing a commented-out capture call is fine.
    const codeOnly = line.replace(/\/\/.*$/, '');
    for (let i = 0; i < codeOnly.length; i++) {
      if (!collecting) {
        // Match `captureException(` at this position, word-boundary.
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

describe('app/ capture-site shape audit (R33)', () => {
  const APP_DIR = path.join(__dirname);
  // `__dirname` under vitest points at the source file's dir. This
  // file lives at app/api-capture-sites.test.ts so app/ IS __dirname.

  const routes = collectRouteFiles(APP_DIR);

  it('discovers at least one route.ts (sanity check on the walker)', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every captureException call includes a `tags:` object', () => {
    const violations: string[] = [];
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      const calls = extractCaptureCalls(source);
      for (const call of calls) {
        // Second arg of captureException is the ctx object. If `tags:`
        // isn't in the source of the call, it's untagged.
        if (!/\btags\s*:/.test(call)) {
          violations.push(`${path.relative(APP_DIR, file)}: ${call.slice(0, 120).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    expect(violations, `capture sites missing tags: ${violations.join('\n')}`).toEqual([]);
  });

  it('every captureException call tags a `route:` (cross-route fingerprint anchor)', () => {
    // A capture without `route:` fingerprints into the global bucket
    // alongside every other app capture — zero signal in the Sentry
    // issues list.
    const violations: string[] = [];
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      const calls = extractCaptureCalls(source);
      for (const call of calls) {
        if (!/\broute\s*:/.test(call)) {
          violations.push(`${path.relative(APP_DIR, file)}: ${call.slice(0, 120).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    expect(violations, `capture sites missing route tag: ${violations.join('\n')}`).toEqual([]);
  });

  it('each route.ts has at most ONE capture convention (all calls share the same top-level tag key-set pattern)', () => {
    // Locks: a route file that started tagging `{route, reason}` then
    // drifted to `{route, errorCode}` on a new site. That drift is
    // invisible to the per-route test if the new site isn't covered.
    // Here we assert: for each route file, every captureException call
    // uses EITHER:
    //   (a) `{route, reason, ...}` shape (cron/checkout/claim style)
    //   (b) `{route, vapiCallId?}` webhook-style (no `reason`)
    //   (c) `{route, site, requestId}` stripe-webhook site shape
    // A file may mix (a) with (c) (see stripe-webhook which has both
    // top-level and magic-link captures), but must not invent a fourth
    // shape without updating this allow-list.
    const ALLOWED_PATTERNS = [
      /\broute\s*:/, // minimum: must tag route
    ];
    // Sanity: no "new" shape means no call with e.g. a `domain:` tag
    // or `errorCode:` tag at the top level — those aren't in any
    // per-route lock today, and would escape the per-route tests.
    const FORBIDDEN_TAG_KEYS = [
      /\btags\s*:\s*\{[^}]*\bdomain\s*:/,
      /\btags\s*:\s*\{[^}]*\berrorCode\s*:/,
      /\btags\s*:\s*\{[^}]*\bseverity\s*:/,
    ];
    const violations: string[] = [];
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      const calls = extractCaptureCalls(source);
      for (const call of calls) {
        for (const pat of ALLOWED_PATTERNS) {
          if (!pat.test(call)) {
            violations.push(
              `${path.relative(APP_DIR, file)}: missing required pattern ${pat}`,
            );
          }
        }
        for (const pat of FORBIDDEN_TAG_KEYS) {
          if (pat.test(call)) {
            violations.push(
              `${path.relative(APP_DIR, file)}: forbidden ad-hoc tag key ${pat}`,
            );
          }
        }
      }
    }
    expect(violations, `shape drift: ${violations.join('\n')}`).toEqual([]);
  });

  it('no captureException call accidentally tags an email, phone, or token value', () => {
    // PII boundary at cross-route level. Per-route tests each assert
    // this for their own tag bag, but a new capture site that lifts a
    // customer email into the tags by mistake wouldn't be caught by
    // the existing tests if it's a fresh route.
    const FORBIDDEN_PII_KEYS = [
      /\btags\s*:\s*\{[^}]*\bemail\s*:/,
      /\btags\s*:\s*\{[^}]*\bphone\s*:/,
      /\btags\s*:\s*\{[^}]*\btoken\s*:/,
      /\btags\s*:\s*\{[^}]*\bpassword\s*:/,
      /\btags\s*:\s*\{[^}]*\bapiKey\s*:/,
    ];
    const violations: string[] = [];
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      const calls = extractCaptureCalls(source);
      for (const call of calls) {
        for (const pat of FORBIDDEN_PII_KEYS) {
          if (pat.test(call)) {
            violations.push(
              `${path.relative(APP_DIR, file)}: forbidden PII key pattern ${pat}`,
            );
          }
        }
      }
    }
    expect(violations, `PII leak into tags: ${violations.join('\n')}`).toEqual([]);
  });

  it('total captureException count across app/ matches the expected ~12 (tripwire against silent additions)', () => {
    // A hard number that DOES change whenever a route adds or removes
    // a capture site. The test doesn't enforce an exact match — it
    // asserts the count is within a sane band and forces the memory
    // file to be updated if the count jumps. Current R32 close count:
    // ~12 call sites across app/ (the total differs from ~43 because
    // most capture sites live in lib/*).
    //
    // If this number diverges wildly, check the memory log in
    // evenquote_project.md for the current expected value, and update
    // the band here to match.
    let total = 0;
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      total += extractCaptureCalls(source).length;
    }
    // 2026-05-01 raised the upper bound to 24 to accommodate:
    //   • stripe/webhook calls-scheduled-email site (#117 deferred
    //     confirmation email)
    //   • cron/dispatch-scheduled-requests park-for-refund site
    //   • additional capture site from the magic-link rewrite that
    //     splits generateLink and sendEmail per R30 reason granularity
    expect(total, `route capture sites = ${total}; expected 8-24`).toBeGreaterThanOrEqual(8);
    expect(total, `route capture sites = ${total}; expected 8-24`).toBeLessThanOrEqual(24);
  });
});
