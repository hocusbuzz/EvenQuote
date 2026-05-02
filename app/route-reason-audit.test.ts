// R36 route-level Reason-value allow-list audit.
//
// The R35 lib/ Reason-type audit (`lib/lib-reason-types.test.ts`)
// locks ghost/ad-hoc drift on every `export type XxxReason = ...`
// union in lib/. Route handlers in `app/` do NOT export Reason
// unions — the `reason:` tag literal is inline on the
// captureException call, directly alongside the `route:` literal.
// That means the R35 audit misses the routes entirely.
//
// This file closes the gap at the route layer by:
//
//   • Walking every `app/**/route.ts` (excluding test files).
//   • Extracting each captureException call body via balanced-paren
//     walk (R34 `lib/lib-capture-sites.test.ts` pattern).
//   • Pulling the `route:` tag literal + every `reason:` tag literal
//     out of the same call body.
//   • Grouping by route value, locking the allow-list per route,
//     and running the standard drift guards: camelCase, no
//     duplicates, no catch-alls, no ghost members, no ad-hoc
//     members.
//
// Canonical per-route allow-lists are hard-coded in EXPECTED_REASONS
// below. Adding a new capture site with a new reason value is a
// three-step process:
//
//   1. Add the capture site in route.ts.
//   2. Add the literal to EXPECTED_REASONS for that route.
//   3. Run this audit — ghost/ad-hoc/camelCase guards confirm the
//      shape matches R29/R30 conventions.
//
// The "routes WITHOUT a reason tag" set is also locked separately:
// per R30 memo, webhook routes (stripe/webhook, vapi/webhook,
// vapi/inbound-callback, twilio/sms) deliberately OMIT `reason` in
// favour of per-webhook coordinates (`vapiCallId`, `eventType`). A
// future maintainer who adds `reason` to a webhook route is either
// correct (in which case they update EXPECTED_REASONS) or wrong (in
// which case the test tells them why the convention exists).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALL_ROUTES,
  toRouteSegment,
} from '../tests/helpers/route-catalog';

// ── Hard-coded per-route allow-lists ─────────────────────────────────
// Matches R35-close memory: cron routes + magic-link landing + auth
// callback. Keep alphabetical-by-route. If a new route joins, add an
// entry here AND in EXPECTED_REASONLESS_ROUTES below if it takes no
// `reason:` tag.
const EXPECTED_REASONS: Record<string, readonly string[]> = {
  'auth/callback': ['exchangeCodeForSessionFailed'],
  'cron/check-status': ['integrationProbeFailed'],
  'cron/check-stuck-requests': ['handlerThrew'],
  'cron/dispatch-scheduled-requests': ['topLevelException'],
  'cron/reconcile-calls': ['runFailed'],
  'cron/retry-failed-calls': ['runFailed'],
  'cron/send-reports': ['runFailed'],
  'get-quotes/claim': ['requestLoadFailed', 'quoteBackfillFailed'],
};

// Routes whose capture sites deliberately tag `route:` but NOT
// `reason:`. Per R26 memo: "webhook routes use `{route, vapiCallId}`
// convention (no `reason`); cron routes use `{route, reason}`.
// Different conventions are intentional: webhooks have ONE catch
// boundary per route so `reason` is redundant; cron routes
// anticipate multiple capture sites per handler."
//
// Stripe webhook additionally uses `site:` inside the handler's
// nested try/catch blocks (magic-link, enqueue-calls). That's
// intentional and locked below via EXPECTED_STRIPE_SITES.
const EXPECTED_REASONLESS_ROUTES: readonly string[] = [
  'stripe/webhook',
  'twilio/sms',
  'vapi/inbound-callback',
  'vapi/webhook',
  // Google Places proxies: single catch boundary per handler so
  // `reason:` is redundant; `route:` suffices (same convention as
  // webhook sinks above).
  'places/autocomplete',
  'places/details',
];

// Stripe webhook's inner capture sites tag `site:` instead of
// `reason:`. Different convention, same drift-catching intent.
const EXPECTED_STRIPE_SITES: readonly string[] = [
  'magic-link',
  'enqueue-calls',
  'seed-on-demand',
  // 2026-05-01: deferred-confirmation email site (#117 follow-up).
  'calls-scheduled-email',
  // 2026-05-02: founder "new paid request" alert site (step E in
  // runPostPaymentSideEffects). Uses `site:` rather than `reason:`
  // because the inner try/catch is one of several side-effect
  // boundaries inside the webhook handler — same convention as
  // magic-link / enqueue-calls / seed-on-demand / calls-scheduled-email.
  'new-payment-alert',
];

// ── File walker ──────────────────────────────────────────────────────
const APP_DIR = path.resolve(__dirname);

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name !== 'route.ts') continue;
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

const routeFiles = collectRouteFiles(APP_DIR);

// ── Balanced-paren walker (shared with R35 lib audit) ────────────────
function extractCaptureExceptionCallBodies(source: string): string[] {
  const out: string[] = [];
  const lines = source.split('\n');
  let buf = '';
  let paren = 0;
  let collecting = false;
  for (const line of lines) {
    const codeOnly = line.replace(/\/\/.*$/, '');
    for (let i = 0; i < codeOnly.length; i++) {
      if (!collecting) {
        if (
          codeOnly.slice(i, i + 'captureException('.length) === 'captureException(' &&
          (i === 0 || !/[A-Za-z0-9_$]/.test(codeOnly[i - 1]))
        ) {
          collecting = true;
          buf = '';
          paren = 1;
          i += 'captureException('.length - 1;
          continue;
        }
      } else {
        const ch = codeOnly[i];
        if (ch === '(') paren++;
        else if (ch === ')') {
          paren--;
          if (paren === 0) {
            out.push(buf);
            collecting = false;
            buf = '';
            continue;
          }
        }
        buf += ch;
      }
    }
    if (collecting) buf += '\n';
  }
  return out;
}

type CaptureSite = {
  file: string; // relative to APP_DIR
  routeLiteral: string | null;
  reasonLiteral: string | null;
  siteLiteral: string | null;
};

function extractCaptureSites(file: string, source: string): CaptureSite[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const out: CaptureSite[] = [];
  for (const body of extractCaptureExceptionCallBodies(stripped)) {
    const routeMatch = /\broute\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g.exec(body);
    const reasonMatch = /\breason\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g.exec(body);
    const siteMatch = /\bsite\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g.exec(body);
    out.push({
      file: path.relative(APP_DIR, file),
      routeLiteral: routeMatch?.[1] ?? null,
      reasonLiteral: reasonMatch?.[1] ?? null,
      siteLiteral: siteMatch?.[1] ?? null,
    });
  }
  return out;
}

// ── Pre-compute: all capture sites across app/**/route.ts ────────────
const allSites: CaptureSite[] = [];
for (const file of routeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  allSites.push(...extractCaptureSites(file, source));
}

// Index by route literal for per-route assertions. Sites with a null
// routeLiteral are explicit failures below.
const sitesByRoute = new Map<string, CaptureSite[]>();
for (const s of allSites) {
  if (!s.routeLiteral) continue;
  if (!sitesByRoute.has(s.routeLiteral)) sitesByRoute.set(s.routeLiteral, []);
  sitesByRoute.get(s.routeLiteral)!.push(s);
}

// ── Tests ────────────────────────────────────────────────────────────
describe('app/ route-level Reason allow-list audit (R36)', () => {
  it('discovers at least 5 route.ts files with captureException sites', () => {
    // Sanity check on the walker. R35 close count: 7 distinct route
    // files with capture sites (auth/callback, cron/{check-status,
    // retry-failed-calls, send-reports}, get-quotes/claim, stripe/
    // webhook, twilio/sms, vapi/webhook, vapi/inbound-callback).
    // Asserting ≥ 5 so a benign restructure doesn't false-positive.
    const filesWithCaptures = new Set(
      allSites.filter((s) => s.routeLiteral !== null).map((s) => s.file),
    );
    expect(filesWithCaptures.size).toBeGreaterThanOrEqual(5);
  });

  it('every captureException site tags route: (no untagged captures)', () => {
    // Every capture site in app/**/route.ts must carry a `route:`
    // literal. A capture site with no route tag means Sentry can't
    // route the alert anywhere specific — it's the equivalent of
    // `catch (e) { log.error(e) }` from Sentry's perspective.
    const violations: string[] = [];
    for (const s of allSites) {
      if (s.routeLiteral === null) {
        violations.push(
          `${s.file}: captureException call with no route: tag literal`,
        );
      }
    }
    expect(
      violations,
      `untagged captureException sites:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every EXPECTED_REASONS route has at least one capture site in the app tree', () => {
    // Drift guard: if a route is removed outright (e.g. a cron job
    // decommissioned), the allow-list entry becomes dead weight and
    // future drift would go undetected. Force the allow-list to
    // stay in sync with the actual routes.
    const violations: string[] = [];
    for (const route of Object.keys(EXPECTED_REASONS)) {
      if (!sitesByRoute.has(route)) {
        violations.push(
          `route '${route}' is in EXPECTED_REASONS but has no capture site — either the route was deleted or the allow-list is stale`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('every reason literal emitted at a capture site is in the EXPECTED_REASONS allow-list (no ad-hoc values)', () => {
    const violations: string[] = [];
    for (const [route, sites] of sitesByRoute.entries()) {
      // Skip routes that are deliberately reason-less (webhooks).
      if (EXPECTED_REASONLESS_ROUTES.includes(route)) continue;
      const allowed = EXPECTED_REASONS[route];
      if (!allowed) {
        violations.push(
          `route '${route}' has capture sites but no entry in EXPECTED_REASONS — add it`,
        );
        continue;
      }
      for (const s of sites) {
        if (s.reasonLiteral === null) {
          violations.push(
            `${s.file}: capture site on route '${route}' has no reason: tag — either add a reason literal or move the route to EXPECTED_REASONLESS_ROUTES`,
          );
          continue;
        }
        if (!allowed.includes(s.reasonLiteral)) {
          violations.push(
            `${s.file}: capture site emits reason: '${s.reasonLiteral}' on route '${route}' but the allow-list is [${allowed
              .map((r) => `'${r}'`)
              .join(', ')}]`,
          );
        }
      }
    }
    expect(
      violations,
      `ad-hoc reason values detected:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every EXPECTED_REASONS allow-list entry is emitted at a capture site (no ghost reasons)', () => {
    const violations: string[] = [];
    for (const [route, allowed] of Object.entries(EXPECTED_REASONS)) {
      const sites = sitesByRoute.get(route) ?? [];
      const emitted = new Set(
        sites.map((s) => s.reasonLiteral).filter((r): r is string => r !== null),
      );
      for (const member of allowed) {
        if (!emitted.has(member)) {
          violations.push(
            `route '${route}': allow-list declares '${member}' but no capture site emits it`,
          );
        }
      }
    }
    expect(
      violations,
      `ghost reason values detected:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reason literals are camelCase (drift guard against snake_case / kebab-case)', () => {
    // Mirrors the lib/ audit. Sentry tag values sort and group
    // cleanly when casing is consistent across the app. A typo like
    // `reason: 'run_failed'` would otherwise fragment alerts.
    const violations: string[] = [];
    for (const s of allSites) {
      if (s.reasonLiteral === null) continue;
      if (!/^[a-z][A-Za-z0-9]*$/.test(s.reasonLiteral)) {
        violations.push(`${s.file}: reason '${s.reasonLiteral}' violates camelCase`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no catch-all reason values (regression guard for "unknown"/"error"/"failed")', () => {
    // Explicit forbidden list. Every authored reason should name a
    // specific failure mode, not a generic catch-all that would
    // silently absorb future classes of failure.
    const forbidden = new Set([
      'unknown',
      'error',
      'failed',
      'runBatch',
      'handlerError',
    ]);
    const violations: string[] = [];
    for (const s of allSites) {
      if (s.reasonLiteral === null) continue;
      if (forbidden.has(s.reasonLiteral)) {
        violations.push(`${s.file}: reason '${s.reasonLiteral}' is a forbidden catch-all`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('EXPECTED_REASONLESS_ROUTES capture sites genuinely have no reason: tag (convention lock)', () => {
    // R26 memo: webhook routes deliberately don't carry `reason:`
    // because they have ONE catch boundary per handler. If a future
    // edit adds `reason:` to a webhook, either the convention
    // changed (in which case update this test and the memo) or it's
    // inconsistent drift.
    const violations: string[] = [];
    for (const route of EXPECTED_REASONLESS_ROUTES) {
      const sites = sitesByRoute.get(route) ?? [];
      for (const s of sites) {
        // Stripe webhook uses `site:` at inner capture sites —
        // exempt that specific route/site combination.
        if (route === 'stripe/webhook' && s.siteLiteral !== null) continue;
        if (s.reasonLiteral !== null) {
          violations.push(
            `${s.file}: route '${route}' capture site emits reason: '${s.reasonLiteral}' but the convention for this route is NO reason tag — either move the route out of EXPECTED_REASONLESS_ROUTES or remove the reason literal`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('stripe/webhook site: literals are in the EXPECTED_STRIPE_SITES allow-list (no ad-hoc values)', () => {
    // Stripe-specific sub-audit — mirrors the reason-value audit for
    // the `site:` convention used at stripe/webhook inner capture
    // sites.
    const violations: string[] = [];
    for (const s of sitesByRoute.get('stripe/webhook') ?? []) {
      if (s.siteLiteral === null) continue;
      if (!EXPECTED_STRIPE_SITES.includes(s.siteLiteral)) {
        violations.push(
          `${s.file}: stripe/webhook site: '${s.siteLiteral}' not in allow-list [${EXPECTED_STRIPE_SITES
            .map((x) => `'${x}'`)
            .join(', ')}]`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('every EXPECTED_STRIPE_SITES value is emitted at stripe/webhook (no ghost sites)', () => {
    // Ghost-site check: the allow-list should match reality. If one
    // of the inner try/catch blocks is removed, the allow-list
    // should shrink with it.
    const emitted = new Set(
      (sitesByRoute.get('stripe/webhook') ?? [])
        .map((s) => s.siteLiteral)
        .filter((x): x is string => x !== null),
    );
    const violations: string[] = [];
    for (const expected of EXPECTED_STRIPE_SITES) {
      if (!emitted.has(expected)) {
        violations.push(`stripe/webhook: no capture site emits site: '${expected}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('count band: between 8 and 25 total capture sites across app/**/route.ts', () => {
    // Count tripwire. R35 close: ~13 capture sites across app/ per
    // memo. Band is generous to allow legitimate growth without
    // retuning every round, but tight enough that a refactor
    // doubling the count overnight would trip.
    expect(allSites.length).toBeGreaterThanOrEqual(8);
    expect(allSites.length).toBeLessThanOrEqual(25);
  });

  it('every EXPECTED_REASONLESS_ROUTES entry is a known route in route-catalog ALL_ROUTES (R47(b))', () => {
    // EXPECTED_REASONLESS_ROUTES uses route-segment format
    // ('stripe/webhook', 'places/autocomplete') — i.e. the path
    // inside app/api/, used as the `route:` tag literal. Map each
    // entry back to a catalog path ('app/api/stripe/webhook/route.ts')
    // and verify it exists in ALL_ROUTES. A typo here silently turns
    // off the reasonless-route exemption for the typo'd entry AND
    // re-imposes the reason-tag requirement on the actually-intended
    // route — the failure mode is "two routes wrong instead of one".
    const ghosts: string[] = [];
    for (const seg of EXPECTED_REASONLESS_ROUTES) {
      // 'stripe/webhook' → 'app/api/stripe/webhook/route.ts'
      const catalogPath = `app/api/${seg}/route.ts`;
      if (!ALL_ROUTES.has(catalogPath)) ghosts.push(seg);
    }
    expect(
      ghosts,
      `EXPECTED_REASONLESS_ROUTES has segments not in route-catalog.ts ALL_ROUTES (typo or stale): ${ghosts.join(', ')}`,
    ).toEqual([]);
  });

  it('toRouteSegment round-trips against ALL_ROUTES (sanity)', () => {
    // Sanity check on the helper itself — every catalog path under
    // app/api/* should produce a valid route segment. Locks the
    // helper's behavior so a future refactor doesn't break it.
    for (const p of ALL_ROUTES) {
      if (!p.startsWith('app/api/')) continue;
      const seg = toRouteSegment(p);
      expect(
        seg.startsWith('api/'),
        `toRouteSegment(${p}) = ${seg} (expected to start with 'api/')`,
      ).toBe(true);
    }
  });
});
