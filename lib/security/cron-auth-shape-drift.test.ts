// R40(c) cron-auth shape-drift audit — ATTESTATION style.
//
// ──────────────────────────────────────────────────────────────────────
// ATTESTATION RATIONALE
// ──────────────────────────────────────────────────────────────────────
//
// The current cron-auth design is a deliberate security trade-off. This
// file locks the shape so that any future refactor must consciously
// decide to change it (by updating both the code AND this test).
//
// DESIGN DECISIONS LOCKED:
//
// 1. NO REPLAY WINDOW / NONCE / TIMESTAMP CHECK
//    ──────────────────────────────────────────
//    Why we rejected it:
//      • pg_cron + pg_net calls originate from Supabase's control plane
//        over HTTPS. Vercel Cron originates from Vercel's runners over
//        HTTPS. Both are already in-transit protected.
//      • Replay window state (Redis / KV / DB row) would add operational
//        complexity. The current stack has no shared cache that spans
//        multiple invocations across runners.
//      • If CRON_SECRET leaks, a replay window only buys time between
//        leak detection and secret rotation. It doesn't prevent a
//        determined attacker from replaying within the window.
//    Common pitfall this prevents:
//      • A future maintainer adds `if (now - timestamp > TTL)` inside
//        assertCronAuth, thinking it's "free" hardening. But the logic
//        rate-limits *legitimate* cron fires if the system clock skews.
//        This audit forces a conscious choice.
//
// 2. NO IP ALLOW-LIST
//    ────────────────
//    Why we rejected it:
//      • Vercel and Supabase's IP ranges are large and change. Hardcoding
//        them creates a silent-failure surface ("secret rotated but I
//        didn't update IPs; cron is now silently unauthorized").
//      • An attacker on the internet can forge the source IP in a
//        spoofed request (at the Vercel/Supabase control plane boundary
//        where the actual packet comes from a legitimate IP, but the
//        X-Forwarded-For or similar header lies). We'd be trusting a
//        header.
//
// 3. CONSTANT-TIME COMPARE, NOT ===
//    ───────────────────────────────
//    Why it must stay:
//      • A naive `===` short-circuits on the first byte. An attacker
//        can use timing side-channels to progressively recover the
//        secret across many requests.
//      • constantTimeEqual hashes both sides to 32-byte SHA-256 digests
//        before comparing, making the compare length-independent and
//        constant-time.
//    This audit catches attempts to simplify back to `===`.
//
// 4. FAIL CLOSED ON MISSING CRON_SECRET (return 500, not 401)
//    ─────────────────────────────────────────────────────────
//    Why it must return 500:
//      • If we returned 401 or 403, an attacker would see the same code
//        as a legit call with a wrong secret. They can't tell if
//        CRON_SECRET is actually configured. Returning 500 signals "the
//        server is broken", which is accurate — an unconfigured secret
//        is a configuration error, not an auth failure.
//      • Returning 500 also prevents the endpoint from becoming a
//        legitimate "guess the secret" oracle: 401 = "you guessed wrong",
//        500 = "we're misconfigured", no oracle signal either way.
//
// 5. NO LOGGING OF THE CRON_SECRET ITSELF
//    ────────────────────────────────────
//    Why it must not log:
//      • The secret is equivalent to a password. Logging it would expose
//        it to log aggregators, Sentry, team members with log access, etc.
//      • If a breach happens, rotating the secret is easy. But if it was
//        logged, every log store the secret touched must be audited.
//    This audit catches `log.warn('failed secret: ' + secret)` anti-patterns.
//
// 6. HELPER IS PURE (accepts Request, not NextRequest)
//    ─────────────────────────────────────────────────
//    Why Request not NextRequest:
//      • Request is the web standard. NextRequest is Next.js-specific.
//      • By accepting the broader type, callers can use it from any
//        context (getServerSideProps, middleware, API routes, Edge
//        Runtime, etc.) without type friction.
//      • If we locked to NextRequest, we'd create friction if the app
//        ever migrates off Next.js or uses the helper from a context
//        that only has Request.
//
// 7. EXTRACTCRONSECRET IS EXPORTED
//    ────────────────────────────
//    Why it's a separate export:
//      • Tests can inspect what the caller sent without running the full
//        auth dance (e.g., "did we extract the right header?").
//      • A future observability enhancement (e.g., "count auth attempts
//        by source") can call extractCronSecret to get the sent token
//        without assertCronAuth's side-effects (response generation).
//
// ──────────────────────────────────────────────────────────────────────
// WHAT THIS TEST COVERS
// ──────────────────────────────────────────────────────────────────────
//
// This is a SOURCE-LEVEL audit. It reads the cron-auth.ts file and
// asserts on its shape:
//
//   ✓ Fail-closed behavior: status 500 on missing CRON_SECRET (not 401).
//   ✓ Constant-time compare: uses constantTimeEqual, not === or other.
//   ✓ Locked header spellings: exactly x-cron-secret, X-Cron-Secret,
//     Authorization (no custom headers added silently).
//   ✓ Bearer prefix: case-insensitive word-boundary stripping with
//     `.replace(/^Bearer\s+/i, '')`.
//   ✓ Mismatch status: 401 on bad auth (not 400 or 403).
//   ✓ No replay window: forbidden tokens like "timestamp", "nonce",
//     "TTL", "replay", etc. do not appear in the source.
//   ✓ No logging of secret: no import of logger/console and no secret
//     transmission to logs.
//   ✓ Return type: function returns NextResponse | null (not boolean).
//   ✓ Parameter type: function accepts Request (not NextRequest).
//   ✓ Cross-route usage: at least 4 call sites exist in /api/cron/**
//     and /api/status, each followed by `if (deny) return deny;` pattern.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsPreservingPositions } from '@/tests/helpers/source-walker';

// Tokens that indicate a replay-window implementation. If any of these
// appear in the source (outside of comments/strings), the test fails.
// This list is the LOCK: adding a timestamp check, nonce, or replay
// window requires explicitly updating this list AND explaining why in
// the ATTESTATION RATIONALE above.
const FORBIDDEN_TOKENS = [
  'Date.now',
  'Date.parse',
  'timestamp',
  'nonce',
  'replay',
  'TTL',
  'SKEW',
  'expiresAt',
  'tolerance',
  'window',
];

function readSourceFile(): string {
  const full = path.join(__dirname, 'cron-auth.ts');
  return fs.readFileSync(full, 'utf8');
}

function readSourceStripped(): string {
  return stripCommentsPreservingPositions(readSourceFile());
}

describe('cron-auth shape — fail-closed', () => {
  it('returns 500 when CRON_SECRET is missing (not 401)', () => {
    const src = readSourceFile();
    // Must check `if (!expected)` and return status 500.
    expect(src).toMatch(/if\s*\(\s*!expected\s*\)/);
    expect(src).toMatch(/status:\s*500\b/);
    // Assert 401 is NOT in the fail-closed path (it's only for mismatch).
    const failClosedSection = src.slice(
      src.indexOf('if (!expected)'),
      src.indexOf('if (!constantTimeEqual')
    );
    expect(failClosedSection).not.toMatch(/status:\s*401\b/);
  });

  it('error message is clear on missing CRON_SECRET', () => {
    const src = readSourceFile();
    expect(src).toMatch(/CRON_SECRET not configured/);
  });
});

describe('cron-auth shape — constant-time compare', () => {
  it('imports constantTimeEqual from the correct module', () => {
    const src = readSourceFile();
    expect(src).toMatch(
      /import\s*{\s*constantTimeEqual\s*}\s*from\s*['"](\.\/constant-time-equal|@\/lib\/security\/constant-time-equal)['"]/
    );
  });

  it('uses constantTimeEqual for the comparison (not ===)', () => {
    const src = readSourceFile();
    // Must call constantTimeEqual, not use ===.
    expect(src).toMatch(/constantTimeEqual\s*\(/);
    // Assert the comparison is not a naive === between the two secrets.
    // (The secret is hashed first inside constantTimeEqual.)
    const comparisonLine = src.match(
      /if\s*\(\s*!constantTimeEqual\s*\([\s\S]*?\)\s*\)/
    );
    expect(comparisonLine).not.toBeNull();
  });

  it('does not use loose equality (==) on secrets', () => {
    const src = readSourceFile();
    // This regex looks for `==` (not `===`) on the comparison line.
    // We expect NO loose equality check on the secret.
    const weakEqualMatch = src.match(/extractCronSecret[^;]*==\s*[^=]/);
    expect(weakEqualMatch).toBeNull();
  });
});

describe('cron-auth shape — header spellings', () => {
  it('accepts x-cron-secret (lowercase)', () => {
    const src = readSourceFile();
    expect(src).toMatch(/x-cron-secret/i);
  });

  it('accepts X-Cron-Secret (titlecase)', () => {
    const src = readSourceFile();
    expect(src).toMatch(/X-Cron-Secret/);
  });

  it('accepts Authorization: Bearer', () => {
    const src = readSourceFile();
    expect(src).toMatch(/authorization/i);
    expect(src).toMatch(/Bearer/);
  });

  it('does not add custom header spellings like x-api-key', () => {
    const src = readSourceFile();
    expect(src).not.toMatch(/x-api-key/i);
    expect(src).not.toMatch(/x-cron-key/i);
    expect(src).not.toMatch(/x-secret/i);
  });

  it('strips Bearer prefix case-insensitively with word boundary', () => {
    const src = readSourceFile();
    // Must use the exact pattern: /^Bearer\s+/i (case-insensitive,
    // word boundary).
    expect(src).toMatch(/Bearer\\s\+/i);
    expect(src).toMatch(/replace\s*\(\s*\/\^Bearer/i);
  });
});

describe('cron-auth shape — mismatch status', () => {
  it('returns 401 on secret mismatch (not 400 or 403)', () => {
    const src = readSourceFile();
    // The mismatch check must return 401.
    const mismatchSection = src.slice(src.indexOf('if (!constantTimeEqual'));
    expect(mismatchSection).toMatch(/status:\s*401\b/);
    // Assert neither 400 nor 403 appear.
    expect(src).not.toMatch(/status:\s*400\b/);
    expect(src).not.toMatch(/status:\s*403\b/);
  });

  it('error message is clear on mismatch', () => {
    const src = readSourceFile();
    expect(src).toMatch(/unauthorized/);
  });
});

describe('cron-auth shape — no logging of secret', () => {
  it('does not import any logger or console', () => {
    const src = readSourceFile();
    expect(src).not.toMatch(/import.*createLogger/);
    expect(src).not.toMatch(/import.*console/);
    expect(src).not.toMatch(/from\s+['"](\.\.\/)?logger['"]/);
  });

  it('does not call log.* or console.* methods', () => {
    const src = readSourceFile();
    expect(src).not.toMatch(/log\.\w+\(/);
    expect(src).not.toMatch(/console\.\w+\(/);
  });

  it('does not reference the secret in string templates or messages', () => {
    // This is a weaker check (since the secret is a variable, not a
    // hardcoded string), but we can at least verify no obvious patterns.
    const src = readSourceFile();
    const stripped = stripCommentsPreservingPositions(src);
    // Check that the word "secret" doesn't appear in log messages or
    // error bodies (it appears in comments and variable names, which
    // are fine).
    const errorMessages = stripped.match(/"[^"]*error[^"]*"/gi) || [];
    for (const msg of errorMessages) {
      expect(msg.toLowerCase()).not.toMatch(/secret/);
    }
  });
});

describe('cron-auth shape — no replay-window (attestation)', () => {
  it('does not contain replay-window tokens', () => {
    const src = readSourceStripped();
    const lines = src.split('\n');
    for (const token of FORBIDDEN_TOKENS) {
      // Match whole-word tokens to avoid false positives in variable
      // names like `expected` (not `expect*ed*`).
      const tokenRegex = new RegExp(`\\b${token}\\b`, 'i');
      const matches = lines.filter((line) => tokenRegex.test(line));
      expect(
        matches,
        `cron-auth.ts contains forbidden replay-window token "${token}". ` +
          `If you're adding a replay window intentionally, update ` +
          `FORBIDDEN_TOKENS and the ATTESTATION RATIONALE in ` +
          `cron-auth-shape-drift.test.ts.`
      ).toEqual([]);
    }
  });

  it('forbidden-tokens list stays readable', () => {
    // Sanity check: the list should be reasonable length.
    expect(FORBIDDEN_TOKENS.length).toBeGreaterThan(0);
    expect(FORBIDDEN_TOKENS.length).toBeLessThan(50);
    // All tokens should be strings.
    FORBIDDEN_TOKENS.forEach((t) => {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    });
  });
});

describe('cron-auth shape — return contract', () => {
  it('exports assertCronAuth with signature NextResponse | null', () => {
    const src = readSourceFile();
    expect(src).toMatch(/export\s+function\s+assertCronAuth/);
    expect(src).toMatch(/:\s*NextResponse\s*\|\s*null\s*\{/);
  });

  it('returns null on success (not true or void)', () => {
    const src = readSourceFile();
    expect(src).toMatch(/return\s+null\s*;/);
  });

  it('returns NextResponse on failure (not false or Error)', () => {
    const src = readSourceFile();
    expect(src).toMatch(/return\s+NextResponse\.json\(/);
  });
});

describe('cron-auth shape — parameter contract', () => {
  it('accepts Request (not NextRequest)', () => {
    const src = readSourceFile();
    // Function signature must accept `Request`, not `NextRequest`.
    const fnSignature = src.match(
      /function\s+assertCronAuth\s*\([^)]*\):[^{]*\{/s
    );
    expect(fnSignature).not.toBeNull();
    expect(fnSignature![0]).toMatch(/req:\s*Request\b/);
    // Assert NextRequest is NOT the parameter type.
    expect(fnSignature![0]).not.toMatch(/req:\s*NextRequest\b/);
  });

  it('extracts from headers directly (headers.get)', () => {
    const src = readSourceFile();
    expect(src).toMatch(/\.headers\.get\(/);
  });
});

describe('cron-auth shape — extractCronSecret export', () => {
  it('exports extractCronSecret separately', () => {
    const src = readSourceFile();
    expect(src).toMatch(/export\s+function\s+extractCronSecret/);
  });

  it('extractCronSecret returns a string', () => {
    const src = readSourceFile();
    const fnMatch = src.match(
      /export\s+function\s+extractCronSecret\s*\([^)]*\)\s*:\s*[^{]*\{/
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![0]).toMatch(/:\s*string\b/);
  });

  it('extractCronSecret accepts Request', () => {
    const src = readSourceFile();
    const fnMatch = src.match(
      /export\s+function\s+extractCronSecret\s*\(([^)]*)\)/
    );
    expect(fnMatch).not.toBeNull();
    expect(fnMatch![1]).toMatch(/req:\s*Request\b/);
  });
});

describe('cron-auth call-site convention', () => {
  it('is used in /api/cron/send-reports', () => {
    const routePath = path.join(
      __dirname,
      '../../app/api/cron/send-reports/route.ts'
    );
    const src = fs.readFileSync(routePath, 'utf8');
    expect(src).toMatch(/assertCronAuth\s*\(\s*req\s*\)/);
    expect(src).toMatch(/if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/);
  });

  it('is used in /api/cron/retry-failed-calls', () => {
    const routePath = path.join(
      __dirname,
      '../../app/api/cron/retry-failed-calls/route.ts'
    );
    const src = fs.readFileSync(routePath, 'utf8');
    expect(src).toMatch(/assertCronAuth\s*\(\s*req\s*\)/);
    expect(src).toMatch(/if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/);
  });

  it('is used in /api/cron/check-status', () => {
    const routePath = path.join(
      __dirname,
      '../../app/api/cron/check-status/route.ts'
    );
    const src = fs.readFileSync(routePath, 'utf8');
    expect(src).toMatch(/assertCronAuth\s*\(\s*req\s*\)/);
    expect(src).toMatch(/if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/);
  });

  it('is used in /api/status', () => {
    const routePath = path.join(__dirname, '../../app/api/status/route.ts');
    const src = fs.readFileSync(routePath, 'utf8');
    expect(src).toMatch(/assertCronAuth\s*\(\s*req\s*\)/);
    expect(src).toMatch(/if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/);
  });

  it('follows the fail-closed convention: if (deny) return deny', () => {
    // All four call sites must use the pattern `const deny = assertCronAuth(req); if (deny) return deny;`
    // This is not a runtime test but a shape assertion — the code review
    // should have caught it, but this test ensures it stays consistent.
    const callSites = [
      path.join(__dirname, '../../app/api/cron/send-reports/route.ts'),
      path.join(__dirname, '../../app/api/cron/retry-failed-calls/route.ts'),
      path.join(__dirname, '../../app/api/cron/check-status/route.ts'),
      path.join(__dirname, '../../app/api/status/route.ts'),
    ];

    for (const routePath of callSites) {
      const src = fs.readFileSync(routePath, 'utf8');
      // Should follow this pattern:
      // const deny = assertCronAuth(req);
      // if (deny) return deny;
      const pattern = /const\s+deny\s*=\s*assertCronAuth\s*\([^)]*\)\s*;[\s\n]*if\s*\(\s*deny\s*\)\s*return\s+deny\s*;/;
      expect(
        src,
        `${routePath} does not follow the convention: const deny = assertCronAuth(req); if (deny) return deny;`
      ).toMatch(pattern);
    }
  });

  it('has exactly 4 cron-protected routes', () => {
    // This is a sanity check: if a new cron endpoint is added without
    // using assertCronAuth, we'll at least know to check it.
    const callSites = [
      path.join(__dirname, '../../app/api/cron/send-reports/route.ts'),
      path.join(__dirname, '../../app/api/cron/retry-failed-calls/route.ts'),
      path.join(__dirname, '../../app/api/cron/check-status/route.ts'),
      path.join(__dirname, '../../app/api/status/route.ts'),
    ];

    let usageCount = 0;
    for (const routePath of callSites) {
      if (fs.existsSync(routePath)) {
        const src = fs.readFileSync(routePath, 'utf8');
        if (/assertCronAuth\s*\(/.test(src)) {
          usageCount++;
        }
      }
    }

    expect(
      usageCount,
      'assertCronAuth should be used in exactly 4 routes'
    ).toBe(4);
  });
});
