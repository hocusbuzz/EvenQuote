// R37(d) Environment-variable audit.
//
// Every `process.env.X` the codebase reads must be accounted for in
// one of two places:
//
//   (a) `.env.example` (either as an active `KEY=…` line or as a
//       commented-out `# KEY=` reference), OR
//   (b) `PLATFORM_ALLOWLIST` below — Vercel/Node/Next.js/Vitest
//       built-ins we rely on but don't ask operators to set.
//
// Any other `process.env.X` reference fails this audit. The fix is
// either to document the variable in `.env.example` with a short
// paragraph (what it does, when to set it, what happens if unset) or
// to add it to the platform allow-list if it's genuinely injected by
// the runtime.
//
// Why:
//
//   Without this lock, it's trivially easy to add a new feature
//   flag or secret, reference `process.env.X`, ship it to
//   production, and only notice the var was never set when the
//   feature starts misbehaving three weeks later. The classic
//   "env var drift → silent feature misconfiguration" chain.
//
// The audit is purely static — greps source, no runtime mocking.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');

const SOURCE_ROOTS = [
  path.join(REPO_ROOT, 'app'),
  path.join(REPO_ROOT, 'lib'),
  path.join(REPO_ROOT, 'scripts'),
  path.join(REPO_ROOT, 'components'),
];

// Standalone files at the repo root that might reference env vars.
const SINGLE_FILES = [
  path.join(REPO_ROOT, 'middleware.ts'),
  path.join(REPO_ROOT, 'next.config.mjs'),
];

// ── Collect vars referenced by source code ──────────────────────────
function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(p);
        continue;
      }
      if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      // Test files reference env vars for test setup; they're the
      // consumers, not the documenters. Exclude them from the audit
      // (otherwise setting `process.env.FOO = 'x'` in a test would
      // require documenting FOO in .env.example).
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      out.push(p);
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  for (const f of SINGLE_FILES) if (fs.existsSync(f)) out.push(f);
  return out;
}

function extractEnvVarsFromSource(file: string): Set<string> {
  const src = fs.readFileSync(file, 'utf8');
  // Strip comments so JSDoc / header-docs referencing process.env.X
  // don't inflate the audit set.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, (m, p1) => p1 + ' ');
  const names = new Set<string>();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) names.add(m[1]);
  // Also handle `process.env['FOO']` bracket syntax defensively.
  const bre = /process\.env\s*\[\s*['"`]([A-Z][A-Z0-9_]*)['"`]\s*\]/g;
  while ((m = bre.exec(stripped)) !== null) names.add(m[1]);
  return names;
}

function collectSourceEnvVars(): Map<string, string[]> {
  // name → [files that read it]
  const byName = new Map<string, string[]>();
  for (const f of collectSourceFiles()) {
    const names = extractEnvVarsFromSource(f);
    for (const name of names) {
      const rel = path.relative(REPO_ROOT, f);
      const arr = byName.get(name) ?? [];
      arr.push(rel);
      byName.set(name, arr);
    }
  }
  return byName;
}

const SOURCE_ENV_VARS = collectSourceEnvVars();

// ── Collect vars documented in .env.example ─────────────────────────
// Active line: `KEY=value`.
// Commented reference: `# KEY=` or `#KEY=` (a commented-out assignment).
// Plain comments that merely mention a var are NOT counted — the
// reference must be of the form `# KEY=` so it's obviously an
// operator-copy-pasteable hint, not prose.
function collectEnvExampleVars(): Set<string> {
  const src = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const out = new Set<string>();
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, '');
    // Active.
    const active = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (active) {
      out.add(active[1]);
      continue;
    }
    // Commented-out reference: exactly # followed by KEY=
    const commented = /^#+([A-Z][A-Z0-9_]*)=/.exec(line);
    if (commented) out.add(commented[1]);
  }
  return out;
}

const ENV_EXAMPLE_VARS = collectEnvExampleVars();

// ── Platform allow-list ─────────────────────────────────────────────
// These are set by Vercel / Node / Next / the Vitest harness and
// don't belong in .env.example (operators can't set them; they're
// injected by the runtime). Keep this list tight.
const PLATFORM_ALLOWLIST = new Set<string>([
  // Node.js
  'NODE_ENV',
  // Next.js build-time
  'NEXT_PUBLIC_BUILD_SHA', // wired by Vercel build step → version.ts
  'BUILD_TIME',
  // Vercel runtime-injected
  'VERCEL_ENV',
  'VERCEL_REGION',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_REF',
  'VERCEL_BUILD_TIME',
  // Vercel Cron handler — auto-added header hashed against this secret.
  'CRON_SECRET',
]);

// ── Tests ───────────────────────────────────────────────────────────
describe('Environment-variable audit (R37d)', () => {
  it('parser sanity: at least 20 env vars referenced across source', () => {
    // R37 close snapshot is ~30–40 env var references. A number too
    // low probably means the walker missed a directory; too high
    // suggests a test-file leak (exclusion bypass). Band guard.
    expect(SOURCE_ENV_VARS.size).toBeGreaterThanOrEqual(20);
    expect(SOURCE_ENV_VARS.size).toBeLessThanOrEqual(80);
  });

  it('parser sanity: at least 15 vars documented in .env.example', () => {
    expect(ENV_EXAMPLE_VARS.size).toBeGreaterThanOrEqual(15);
    expect(ENV_EXAMPLE_VARS.size).toBeLessThanOrEqual(80);
  });

  it('every source-referenced env var is EITHER in .env.example OR in the platform allow-list', () => {
    const undocumented: string[] = [];
    for (const [name, files] of SOURCE_ENV_VARS.entries()) {
      if (ENV_EXAMPLE_VARS.has(name)) continue;
      if (PLATFORM_ALLOWLIST.has(name)) continue;
      undocumented.push(
        `${name} — read by ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3} more)` : ''}`,
      );
    }
    expect(
      undocumented,
      `env vars referenced in source but NOT documented in .env.example or platform allow-list:\n  ${undocumented.join('\n  ')}\n\nFix: add a paragraph to .env.example explaining the var (what it does, when to set it, default behavior) OR add it to PLATFORM_ALLOWLIST if it's runtime-injected.`,
    ).toEqual([]);
  });

  it('no var is declared in .env.example without ever being read (catch stale docs)', () => {
    // Tolerated exceptions — reference-only commented entries that
    // point operators at Google Cloud config, NOT at code the app
    // reads. They live in .env.example as guidance, not consumption.
    const IGNORE_UNUSED = new Set([
      // Supabase handles OAuth server-side; the app never reads these.
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      // Reserved for future client-side StripeProvider wiring.
      'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
      // Reserved for catalog-based pricing (currently inline price_data).
      'STRIPE_PRICE_ID_QUOTE_REQUEST',
      // Consumed by @sentry/nextjs init options once DSN is unlocked
      // (outstanding P1 item #6). Documented now so operators see
      // the knob before flipping the DSN on; read path lives inside
      // the Sentry SDK, not the app code, so a naive process.env
      // grep won't find it.
      'SENTRY_TRACES_SAMPLE_RATE',
    ]);
    const unused: string[] = [];
    for (const name of ENV_EXAMPLE_VARS) {
      if (IGNORE_UNUSED.has(name)) continue;
      if (!SOURCE_ENV_VARS.has(name)) unused.push(name);
    }
    expect(
      unused,
      `vars listed in .env.example but not read by any source file (dead env docs — remove or wire up):\n  ${unused.join('\n  ')}`,
    ).toEqual([]);
  });

  it('PLATFORM_ALLOWLIST stays tight — no shadowing of operator-configurable vars', () => {
    // A well-intentioned "move this to the platform list, one less
    // thing to document" refactor would silently hide a user-facing
    // env var from .env.example. Guard the invariant: every entry
    // in PLATFORM_ALLOWLIST must NOT also appear in .env.example.
    const shadowed: string[] = [];
    for (const name of PLATFORM_ALLOWLIST) {
      if (ENV_EXAMPLE_VARS.has(name)) shadowed.push(name);
    }
    expect(
      shadowed,
      `vars appear both in PLATFORM_ALLOWLIST AND .env.example (pick one):\n  ${shadowed.join(', ')}`,
    ).toEqual([]);
  });

  it('the high-value secret vars are ALL documented in .env.example (no platform-allow-list hide)', () => {
    // Narrow belt-and-braces lock. These secrets MUST be documented
    // for any new operator to get started. If someone moves one to
    // the allow-list to dodge the audit, this test fires.
    const MUST_BE_IN_ENV_EXAMPLE = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'SUPABASE_SERVICE_ROLE_KEY',
      'VAPI_API_KEY',
      'VAPI_WEBHOOK_SECRET',
      'TWILIO_AUTH_TOKEN',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_APP_URL',
      'MAINTENANCE_MODE',
    ];
    const missing = MUST_BE_IN_ENV_EXAMPLE.filter(
      (name) => !ENV_EXAMPLE_VARS.has(name),
    );
    expect(
      missing,
      `these secrets MUST be documented in .env.example:\n  ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('.env.example documents CSP + dev-only + observability vars (drift catch for recent R37 additions)', () => {
    // Specific R37 additions. If a maintainer deletes the
    // documentation but leaves the source-side process.env read,
    // the prior audit fires. This one fires early if the doc
    // line itself is deleted.
    const EXPECTED = [
      'CSP_NONCE_ENABLED',
      'CSP_ENFORCE',
      'CSP_VIOLATIONS_PERSIST',
      'LOG_FULL_CSP',
      'MAINTENANCE_MODE',
      'MAINTENANCE_PREVIEW_TOKEN',
      'DEV_TRIGGER_TOKEN',
      'TEST_OVERRIDE_PHONE',
      'ALLOW_PROD_SEED',
      'SENTRY_DSN',
      'SENTRY_TRACES_SAMPLE_RATE',
      'VAPI_CALLBACK_NUMBER',
    ];
    const missing = EXPECTED.filter((name) => !ENV_EXAMPLE_VARS.has(name));
    expect(
      missing,
      `expected ops vars absent from .env.example: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every NEXT_PUBLIC_ var in source is documented (client bundle cannot fallback — must be set at build time)', () => {
    // NEXT_PUBLIC_ vars get inlined at build. Anything read by
    // client code MUST be set in Vercel OR a default must exist.
    // An undocumented NEXT_PUBLIC_X is the most silent-break env
    // shape in Next.js.
    const clientVars = Array.from(SOURCE_ENV_VARS.keys()).filter((n) =>
      n.startsWith('NEXT_PUBLIC_'),
    );
    const undocumented = clientVars.filter(
      (n) => !ENV_EXAMPLE_VARS.has(n) && !PLATFORM_ALLOWLIST.has(n),
    );
    expect(
      undocumented,
      `undocumented NEXT_PUBLIC_ vars (would silently break client bundles):\n  ${undocumented.join('\n  ')}`,
    ).toEqual([]);
    // Sanity check: we actually have some client-side public vars.
    expect(clientVars.length).toBeGreaterThan(0);
  });
});
