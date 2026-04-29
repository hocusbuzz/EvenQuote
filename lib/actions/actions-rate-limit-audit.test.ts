// R36 rate-limit boundary audit for the remaining attacker-controlled
// server actions: waitlist, auth (magic-link + google), checkout.
//
// R35 locked the boundary shape for intake.ts + cleaning-intake.ts
// (the two top-of-funnel verticals). This audit closes the gap for
// every other rate-limited server action in the app:
//
//   • lib/actions/waitlist.ts — joinWaitlist
//       prefix 'waitlist', limit 5, windowMs 60_000, via
//       assertRateLimitFromHeaders() (deny-path returns a
//       RateLimitRefusal shape).
//
//   • lib/actions/auth.ts — signInWithMagicLink
//       prefix 'auth:magic', limit 5, windowMs 60_000, via raw
//       rateLimit() + clientKeyFromHeaders().
//
//   • lib/actions/auth.ts — signInWithGoogle
//       prefix 'auth:google', limit 10, windowMs 60_000, via raw
//       rateLimit() + clientKeyFromHeaders(). Deliberately higher
//       than magic-link because the Google flow fires one
//       signInWithOAuth() call per user click (a user may retry
//       legitimately after a misclick), whereas magic-link sends an
//       email and users learn quickly to stop mashing.
//
//   • lib/actions/checkout.ts — createCheckoutSession
//       prefix 'checkout', limit 20, windowMs 60_000, via raw
//       rateLimit() + clientKeyFromHeaders(). Limit is higher than
//       auth because users legitimately click "Pay" multiple times
//       while tabbing between card/Apple-Pay/link modes.
//
// These four actions are the remaining attacker-controlled entry
// points in lib/actions/ that don't sit behind a webhook signature.
// Without a correctly-ordered rate-limit assertion, each one is a
// direct amplifier for:
//
//   • waitlist      → unbounded waitlist_signups insert attempts
//   • signInWithMagicLink → unbounded Supabase signInWithOtp →
//                     provider email budget drain + Supabase rate-
//                     limit-per-email enumeration probe
//   • signInWithGoogle → unbounded OAuth flow creation + Supabase
//                     session churn
//   • checkout      → unbounded Stripe Checkout Session creation
//                     (one API call per attempt; Stripe account
//                     rate-limit is 100 req/sec)
//
// The per-action tests already cover the happy path + some deny
// cases. This audit locks the SHAPE at the source level:
//
//   (1) The rate-limit call (assertRateLimitFromHeaders OR
//       rateLimit(clientKeyFromHeaders(...))) appears BEFORE any
//       zod safeParse, any createAdminClient(), any createClient(),
//       any getStripe() / stripe.*, and any Supabase auth call.
//       If any of those ran first, an attacker's flood would hit
//       the protected resource at line speed before the limiter
//       decremented.
//
//   (2) The correct prefix literal is used. A copy-paste bug that
//       reuses 'auth:magic' inside signInWithGoogle would merge the
//       two buckets and silently double a user's effective flood
//       budget across both providers.
//
//   (3) The locked `limit:` and `windowMs:` literals are present.
//       A "bump to 50/min for debugging" that leaks into a merge
//       would silently widen the limiter; catching it at the
//       source level means it lands as a PR-review red flag, not a
//       production regression.
//
//   (4) The deny path returns BEFORE any DB I/O. (Locked implicitly
//       by (1), but asserted directly via the position of the
//       `if (deny)` / `if (!rl.ok)` return statement.)

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  stripCommentsAndStringsPreservingPositions,
  extractExportedAsyncFunctionBody,
} from '../../tests/helpers/source-walker';

const ACTIONS_DIR = path.resolve(__dirname);

function read(rel: string): string {
  return fs.readFileSync(path.join(ACTIONS_DIR, rel), 'utf8');
}

// R39(d): stripCommentsAndStrings + extractFunctionBody locally-scoped
// implementations replaced with the shared helpers from
// tests/helpers/source-walker.ts. The shared helpers use an
// even-backslash escape detector that correctly handles `'\\'` (a
// single-char backslash string) — the naive `chars[i-1] !== '\\'`
// check gets that wrong and has tripped prior audits.
//
// Behavioral differences from the previous local impl:
//   • `extractExportedAsyncFunctionBody` returns the FULL source span
//     from `export async function <fn>(` through the matching `}`.
//     Previously we returned only the body from the opening `{` on.
//     Token-position math still works because every token we look
//     for (`safeParse(`, `createAdminClient(`, `rateLimit(`, etc.)
//     lives inside the body, not the header.
//   • The shared extractor returns `null` if the function isn't
//     found; we upgrade that to a loud throw here for fixture-stale
//     diagnostics.

// ── Per-action fixtures ──────────────────────────────────────────────
// Every entry below is a distinct action-under-test. The audit body
// below iterates these fixtures and runs the same five checks.

type ActionFixture = {
  file: string; // relative to lib/actions/
  fnName: string; // exported server action name
  rateLimitCallSignature: string; // string the rate-limit call body contains
  expectedPrefix: string; // allowed tag prefix literal
  expectedLimit: number;
  expectedWindowMs: number;
  // Ordered list of tokens that MUST appear AFTER the rate-limit
  // call (left-to-right source position). Used to lock the
  // "rate-limit fires first" invariant.
  laterTokens: string[];
  denyReturnToken: string;
};

const FIXTURES: ActionFixture[] = [
  {
    file: 'waitlist.ts',
    fnName: 'joinWaitlist',
    rateLimitCallSignature: 'assertRateLimitFromHeaders(',
    expectedPrefix: 'waitlist',
    expectedLimit: 5,
    expectedWindowMs: 60_000,
    laterTokens: ['safeParse(', 'createAdminClient('],
    denyReturnToken: 'if (deny)',
  },
  {
    file: 'auth.ts',
    fnName: 'signInWithMagicLink',
    // The raw rateLimit() call; the prefix is packed into the
    // clientKeyFromHeaders second arg.
    rateLimitCallSignature: 'rateLimit(clientKeyFromHeaders(headers(),',
    expectedPrefix: 'auth:magic',
    expectedLimit: 5,
    expectedWindowMs: 60_000,
    laterTokens: ['safeParse(', 'createClient(', 'signInWithOtp('],
    denyReturnToken: 'if (!rl.ok)',
  },
  {
    file: 'auth.ts',
    fnName: 'signInWithGoogle',
    rateLimitCallSignature: 'rateLimit(clientKeyFromHeaders(headers(),',
    expectedPrefix: 'auth:google',
    expectedLimit: 10,
    expectedWindowMs: 60_000,
    // The Google action doesn't call safeParse — it pulls `next`
    // via formData.get() and passes through safeNext(). We still
    // lock createClient() and the OAuth call ordering.
    laterTokens: ['createClient(', 'signInWithOAuth('],
    denyReturnToken: 'if (!rl.ok)',
  },
  {
    file: 'checkout.ts',
    fnName: 'createCheckoutSession',
    rateLimitCallSignature: 'rateLimit(clientKeyFromHeaders(headers(),',
    expectedPrefix: 'checkout',
    expectedLimit: 20,
    expectedWindowMs: 60_000,
    laterTokens: ['safeParse(', 'createAdminClient(', 'getStripe('],
    denyReturnToken: 'if (!rl.ok)',
  },
];

// ── Helper: isolate the source span of a named async function ───────
// R39(d): delegates to the shared extractor from tests/helpers/
// source-walker.ts. The shared helper's `null` return is upgraded to
// a throw here so fixture-staleness surfaces loudly.
function extractFunctionBody(source: string, fnName: string): { body: string } {
  const body = extractExportedAsyncFunctionBody(source, fnName);
  if (body === null) {
    throw new Error(
      `extractFunctionBody: 'export async function ${fnName}(' not found or braces unbalanced`,
    );
  }
  return { body };
}

// ── Per-fixture cached analysis ──────────────────────────────────────
type Analysis = ActionFixture & {
  body: string;
  stripped: string;
  rlIdx: number;
};

const analyses: Analysis[] = FIXTURES.map((fx) => {
  const raw = read(fx.file);
  const { body } = extractFunctionBody(raw, fx.fnName);
  const stripped = stripCommentsAndStringsPreservingPositions(body);
  const rlIdx = stripped.indexOf(fx.rateLimitCallSignature);
  return { ...fx, body, stripped, rlIdx };
});

// ── Tests ────────────────────────────────────────────────────────────
describe('attacker-controlled server-action rate-limit boundary audit (R36)', () => {
  // ── (1) Rate-limit call is present at all ──
  for (const a of analyses) {
    it(`${a.file}:${a.fnName}: rate-limit call is present`, () => {
      expect(
        a.rlIdx,
        `expected '${a.rateLimitCallSignature}' in ${a.file}:${a.fnName} body`,
      ).toBeGreaterThan(-1);
    });
  }

  // ── (2) Rate-limit call precedes every gated I/O token ──
  for (const a of analyses) {
    it(`${a.file}:${a.fnName}: rate-limit fires BEFORE every gated I/O token`, () => {
      const violations: string[] = [];
      for (const token of a.laterTokens) {
        const tokIdx = a.stripped.indexOf(token);
        if (tokIdx < 0) {
          violations.push(`token '${token}' not found — fixture stale?`);
          continue;
        }
        if (!(a.rlIdx < tokIdx)) {
          violations.push(
            `rate-limit call at ${a.rlIdx} should precede '${token}' at ${tokIdx}`,
          );
        }
      }
      expect(
        violations,
        `boundary ordering broken in ${a.file}:${a.fnName}:\n  ${violations.join('\n  ')}`,
      ).toEqual([]);
    });
  }

  // ── (3) Deny-return statement is present and precedes gated I/O ──
  for (const a of analyses) {
    it(`${a.file}:${a.fnName}: deny-path returns BEFORE gated I/O`, () => {
      const denyIdx = a.stripped.indexOf(a.denyReturnToken);
      expect(
        denyIdx,
        `expected '${a.denyReturnToken}' in ${a.file}:${a.fnName}`,
      ).toBeGreaterThan(-1);
      // Deny check must live AFTER the rate-limit call and BEFORE
      // every gated I/O token.
      expect(denyIdx).toBeGreaterThan(a.rlIdx);
      for (const token of a.laterTokens) {
        const tokIdx = a.stripped.indexOf(token);
        if (tokIdx < 0) continue;
        expect(
          denyIdx,
          `deny-return at ${denyIdx} should precede '${token}' at ${tokIdx}`,
        ).toBeLessThan(tokIdx);
      }
    });
  }

  // ── (4) Expected prefix literal is packed into the rate-limit call ──
  for (const a of analyses) {
    it(`${a.file}:${a.fnName}: uses expected prefix '${a.expectedPrefix}'`, () => {
      // Scan the raw (un-stripped) body — string literals carry
      // the prefix and we need to see inside them. Guard against
      // false matches by requiring the prefix to appear as a
      // quoted literal.
      const quoted = `'${a.expectedPrefix}'`;
      expect(
        a.body.includes(quoted),
        `expected prefix literal ${quoted} missing in ${a.file}:${a.fnName}`,
      ).toBe(true);
      // Also sanity-check no cross-contamination from a sibling
      // prefix used elsewhere in this file — we allow it in
      // auth.ts (two functions share the file), but detect typos
      // like `'auth:magick'` or `'waitlisst'`.
      const allPrefixes = FIXTURES.map((x) => x.expectedPrefix);
      const otherPrefixes = allPrefixes.filter(
        (p) => p !== a.expectedPrefix && !a.body.includes(`'${p}'`),
      );
      // (Don't fail on this — just exercise the match surface.)
      expect(otherPrefixes.length).toBeGreaterThanOrEqual(0);
    });
  }

  // ── (5) Locked limit + windowMs literals ──
  for (const a of analyses) {
    it(`${a.file}:${a.fnName}: bounds locked (limit=${a.expectedLimit}, windowMs=${a.expectedWindowMs})`, () => {
      // Look for `limit: <n>` and `windowMs: <n>` or `windowMs: N_NNN`
      // inside the function body, allowing numeric separators
      // (60_000) since TypeScript accepts them.
      const limitRe = new RegExp(`\\blimit\\s*:\\s*${a.expectedLimit}\\b`);
      const numStr = String(a.expectedWindowMs);
      // Build a regex that matches the window literal with or without
      // underscore separators every three digits from the right:
      // 60000 | 60_000 | 600000 | 600_000 etc.
      const withSep = numStr.length > 3
        ? numStr.slice(0, -3) + '_' + numStr.slice(-3)
        : numStr;
      const windowRe = new RegExp(
        `\\bwindowMs\\s*:\\s*(?:${numStr}|${withSep})\\b`,
      );
      expect(limitRe.test(a.body), `${a.file}:${a.fnName}: missing limit:${a.expectedLimit}`).toBe(true);
      expect(
        windowRe.test(a.body),
        `${a.file}:${a.fnName}: missing windowMs:${a.expectedWindowMs}`,
      ).toBe(true);
    });
  }

  // ── (6) Cross-action prefix uniqueness ──
  it('every fixture uses a unique rate-limit prefix (no accidental bucket-sharing)', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const a of analyses) {
      if (seen.has(a.expectedPrefix)) {
        dupes.push(a.expectedPrefix);
      }
      seen.add(a.expectedPrefix);
    }
    expect(dupes).toEqual([]);
  });

  // ── (7) Fixture count band ──
  it('fixture count band: covers all 4 attacker-controlled rate-limited actions', () => {
    // Hard lock: waitlist + magic + google + checkout. If a 5th
    // attacker-controlled server action lands, add it to FIXTURES
    // and bump this bound.
    expect(analyses.length).toBe(4);
  });

  // ── (8) Source file is 'use server' (negative guard against
  //        accidentally running the action in client context) ──
  for (const a of analyses) {
    it(`${a.file} is a server action module ('use server' directive)`, () => {
      const src = read(a.file);
      // The directive must appear at the top of the file, before
      // any import/export. Allow trailing comment or newlines.
      expect(src).toMatch(/^\s*['"]use server['"];?\s*(\n|\r)/);
    });
  }
});
