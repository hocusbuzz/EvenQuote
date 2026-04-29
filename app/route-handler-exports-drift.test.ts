// R42(c) — Route handler export-ordering + method-set drift audit.
//
// Next.js App Router uses the NAME of each `export` in a `route.ts`
// as the HTTP method. `export async function GET(req)` handles GET;
// a typo (`export async function Get`) silently becomes a static
// no-op route. Additionally, only a specific set of CONFIG exports
// are recognized by the router (`runtime`, `dynamic`, `revalidate`,
// `fetchCache`, `preferredRegion`, `maxDuration`, `dynamicParams`).
// A misspelled `revelidate` would silently use the default.
//
// This audit locks three contracts across all route.ts files:
//
//   (1) Every exported identifier is either an HTTP-method name
//       (GET/POST/PUT/PATCH/DELETE/OPTIONS/HEAD) OR one of the
//       allowed config names OR an explicitly-allowlisted TYPE
//       alias (`export type XxxReason = ...` is used by R34's
//       reason-union audits — harmless, but requires explicit
//       allow-listing so a typo'd handler can't masquerade as a
//       harmless type export).
//
//   (2) The set of HTTP-method exports for each route matches the
//       EXPECTED_METHODS map. Catches drift both ways:
//         • Someone adds a handler to a route without updating
//           consumers (e.g. cron scheduler doesn't know about the
//           new GET variant).
//         • Someone removes a handler that a consumer still calls
//           (silent 405 in prod).
//
//   (3) No route has a default export. `export default function Foo`
//       is silently ignored by the App Router — the classic mistake
//       of copy-pasting a page component into a route.ts. We want
//       that to be a test failure, not a broken endpoint.
//
// Out of scope (handled elsewhere):
//   • Response body shape — `app/route-response-shape-drift.test.ts`
//     (R38(b)) + `app/route-text-response-shape-drift.test.ts` (R39).
//   • Reason-union lock — `app/route-reason-audit.test.ts` (R36).
//   • Stripe event-type allow-list —
//     `app/api/stripe/webhook/route-event-type-drift.test.ts`
//     (R41(b)).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsOnlyRegex } from '../tests/helpers/source-walker';
import { ALL_ROUTES } from '../tests/helpers/route-catalog';

const ROOT = process.cwd();
const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);
const ALLOWED_CONFIG_EXPORTS = new Set([
  // Next.js route segment config — official names only.
  // https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
  'runtime',
  'dynamic',
  'revalidate',
  'fetchCache',
  'preferredRegion',
  'maxDuration',
  'dynamicParams',
  'generateStaticParams',
]);

// Per-route lock. Adding a route requires adding an entry.
// Adding a handler to a route requires updating the entry.
interface RouteSpec {
  methods: string[]; // exact HTTP-method export set (sorted)
  config: string[]; // exact config-export set (sorted)
  typeAliases?: string[]; // optional TS-only export names
  // Helper functions a route is ALLOWED to expose (imported by other
  // routes / crons). Avoid except when a cross-route import is the
  // deliberate architecture — every entry here should have a reason.
  helperFunctions?: { name: string; reason: string }[];
}

const EXPECTED_ROUTES: Record<string, RouteSpec> = {
  // Cron handlers. Each cron route supports both scheduler-triggered
  // (POST per R33 convention) and operator-triggered (GET with same
  // auth path).
  'app/api/cron/check-status/route.ts': {
    methods: ['GET', 'POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/cron/check-stuck-requests/route.ts': {
    methods: ['GET', 'POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/cron/retry-failed-calls/route.ts': {
    methods: ['GET', 'POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/cron/send-reports/route.ts': {
    methods: ['GET', 'POST'],
    config: ['dynamic', 'runtime'],
  },

  // CSP violation reports: browser POSTs only.
  'app/api/csp-report/route.ts': {
    methods: ['POST'],
    config: ['dynamic', 'runtime'],
  },

  // Dev-only surfaces, token-gated. Trigger + backfill use GET so
  // they can be hit from `.command` scripts; skip-payment is POST
  // because it mutates.
  'app/api/dev/backfill-call/route.ts': {
    methods: ['GET'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/dev/skip-payment/route.ts': {
    methods: ['POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/dev/trigger-call/route.ts': {
    methods: ['GET'],
    config: ['dynamic', 'runtime'],
  },

  // Probes — GET for uptime monitors; HEAD for cheap alive pings.
  'app/api/health/route.ts': {
    methods: ['GET', 'HEAD'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/version/route.ts': {
    methods: ['GET', 'HEAD'],
    config: ['dynamic', 'runtime'],
  },

  // Google Places proxies — server-side wrappers so the API key
  // stays off the browser. GET only (read-through proxy).
  'app/api/places/autocomplete/route.ts': {
    methods: ['GET'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/places/details/route.ts': {
    methods: ['GET'],
    config: ['dynamic', 'runtime'],
  },

  // Composite status: GET for read, POST for integration probes.
  // `checkStripe` + `checkVapi` are imported by the check-status
  // cron — deliberate cross-route helper sharing.
  // `StatusResponse` is the TS shape consumed by callers.
  'app/api/status/route.ts': {
    methods: ['GET', 'POST'],
    config: ['dynamic', 'runtime'],
    typeAliases: ['StatusResponse'],
    helperFunctions: [
      {
        name: 'checkStripe',
        reason: 'imported by app/api/cron/check-status/route.ts',
      },
      {
        name: 'checkVapi',
        reason: 'imported by app/api/cron/check-status/route.ts',
      },
    ],
  },

  // External webhook sinks. POST only — the vendor contract.
  'app/api/stripe/webhook/route.ts': {
    methods: ['POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/twilio/sms/route.ts': {
    methods: ['POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/vapi/inbound-callback/route.ts': {
    methods: ['POST'],
    config: ['dynamic', 'runtime'],
  },
  'app/api/vapi/webhook/route.ts': {
    methods: ['POST'],
    config: ['dynamic', 'runtime'],
  },

  // User-facing auth handlers.
  'app/auth/callback/route.ts': {
    methods: ['GET'],
    config: [], // Intentionally no runtime/dynamic — defaults are fine.
    typeAliases: ['AuthCallbackReason'],
  },
  'app/auth/signout/route.ts': {
    methods: ['POST'],
    config: [],
  },

  // Post-payment claim flow — GET via signed link in email.
  'app/get-quotes/claim/route.ts': {
    methods: ['GET'],
    config: ['dynamic'],
    typeAliases: ['ClaimReason'],
  },
};

// ── Source discovery ────────────────────────────────────────────────

function discoverRouteFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'route.ts') out.push(path.relative(ROOT, full));
    }
  }
  walk(path.join(ROOT, 'app'));
  return out.sort();
}

// ── Export parser ───────────────────────────────────────────────────

interface ParsedExports {
  methods: string[];
  config: string[];
  typeAliases: string[];
  hasDefault: boolean;
  unknown: string[];
}

function parseExports(src: string): ParsedExports {
  const noComments = stripCommentsOnlyRegex(src);
  const out: ParsedExports = {
    methods: [],
    config: [],
    typeAliases: [],
    hasDefault: false,
    unknown: [],
  };
  // Default export detection (any form).
  if (/^export\s+default\b/m.test(noComments)) out.hasDefault = true;

  // Named exports we recognize. Walk identifiers one pattern at a time.
  //   export async function Name(       → function (HTTP method or other)
  //   export function Name(             → function
  //   export const Name = ...           → const / config / …
  //   export type Name = ...            → type alias
  //   export interface Name { ... }     → interface — forbidden in route files
  const patterns = [
    {
      kind: 'func',
      re: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    },
    {
      kind: 'const',
      re: /^export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/gm,
    },
    {
      kind: 'type',
      re: /^export\s+type\s+([A-Za-z_$][\w$]*)\b/gm,
    },
    {
      kind: 'interface',
      re: /^export\s+interface\s+([A-Za-z_$][\w$]*)\b/gm,
    },
    {
      kind: 'class',
      re: /^export\s+class\s+([A-Za-z_$][\w$]*)\b/gm,
    },
    {
      kind: 'enum',
      re: /^export\s+enum\s+([A-Za-z_$][\w$]*)\b/gm,
    },
  ] as const;

  for (const { kind, re } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(noComments)) !== null) {
      const name = m[1];
      if (kind === 'func') {
        if (HTTP_METHODS.has(name)) out.methods.push(name);
        else out.unknown.push(`function:${name}`);
      } else if (kind === 'const') {
        if (ALLOWED_CONFIG_EXPORTS.has(name)) out.config.push(name);
        else if (HTTP_METHODS.has(name)) out.methods.push(name);
        else out.unknown.push(`const:${name}`);
      } else if (kind === 'type') {
        out.typeAliases.push(name);
      } else {
        // interface / class / enum are unusual in a route.ts —
        // flag them as unknown.
        out.unknown.push(`${kind}:${name}`);
      }
    }
  }

  out.methods.sort();
  out.config.sort();
  out.typeAliases.sort();
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('app/**/route.ts handler export drift (R42)', () => {
  const discovered = discoverRouteFiles();

  it('discovers the expected set of route.ts files (no new surprises)', () => {
    const expected = Object.keys(EXPECTED_ROUTES).sort();
    const missing = expected.filter((p) => !discovered.includes(p));
    const extra = discovered.filter((p) => !expected.includes(p));
    expect(
      { missing, extra },
      `route.ts discovery drift. missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}. Add new routes to EXPECTED_ROUTES.`,
    ).toEqual({ missing: [], extra: [] });
  });

  it('EXPECTED_ROUTES membership matches ALL_ROUTES from route-catalog (R47(b))', () => {
    // Single source-of-truth check: the per-route SPECS in this audit
    // must cover the same set of routes as the shared catalog. If a
    // new route is added to NON_CACHEABLE / CACHEABLE_VERSION but not
    // to EXPECTED_ROUTES (or vice versa), this test fails — making
    // route additions a one-edit-then-fail-loud loop instead of a
    // silent partial-update.
    const specRoutes = new Set(Object.keys(EXPECTED_ROUTES));
    const missingFromSpec: string[] = [];
    for (const p of ALL_ROUTES) {
      if (!specRoutes.has(p)) missingFromSpec.push(p);
    }
    const missingFromCatalog: string[] = [];
    for (const p of specRoutes) {
      if (!ALL_ROUTES.has(p)) missingFromCatalog.push(p);
    }
    expect(
      { missingFromSpec, missingFromCatalog },
      `EXPECTED_ROUTES drift vs route-catalog.ts ALL_ROUTES.\n` +
        `  missing from EXPECTED_ROUTES (in catalog only): ${missingFromSpec.join(', ') || 'none'}\n` +
        `  missing from ALL_ROUTES (in spec only): ${missingFromCatalog.join(', ') || 'none'}\n` +
        `  Both sets must match — adding a route is a one-edit-per-side operation.`,
    ).toEqual({ missingFromSpec: [], missingFromCatalog: [] });
  });

  for (const [relPath, spec] of Object.entries(EXPECTED_ROUTES)) {
    describe(relPath, () => {
      const full = path.join(ROOT, relPath);
      const src = fs.readFileSync(full, 'utf8');
      const parsed = parseExports(src);

      it('has no default export (default exports are ignored by the App Router)', () => {
        expect(
          parsed.hasDefault,
          `${relPath} has a default export — App Router will silently ignore it.`,
        ).toBe(false);
      });

      it(`exposes exactly the expected HTTP methods: ${spec.methods.join(', ') || '(none)'}`, () => {
        expect(parsed.methods).toEqual([...spec.methods].sort());
      });

      it(`declares exactly the expected config exports: ${spec.config.join(', ') || '(none)'}`, () => {
        expect(parsed.config).toEqual([...spec.config].sort());
      });

      it('has no stray exports outside HTTP methods / config / typeAliases / allowed helpers', () => {
        // Type aliases allowed if whitelisted for this route.
        const allowedTypes = new Set(spec.typeAliases ?? []);
        const badTypes = parsed.typeAliases.filter((n) => !allowedTypes.has(n));
        // Helper functions allowed if whitelisted for this route.
        const allowedHelpers = new Set(
          (spec.helperFunctions ?? []).map((h) => h.name),
        );
        const badUnknown = parsed.unknown.filter((n) => {
          // `function:Name` → peel the prefix and check the helper
          // allow-list. Non-function unknowns never pass.
          if (n.startsWith('function:')) {
            const name = n.slice('function:'.length);
            return !allowedHelpers.has(name);
          }
          return true;
        });
        expect(
          { unknown: badUnknown, badTypes },
          `${relPath} has unexpected exports: unknown=${JSON.stringify(badUnknown)}, unexpected type aliases=${JSON.stringify(badTypes)}. A typo like \`export async function Get\` (lower-case e) would land here. If this is a deliberate helper export, add it to RouteSpec.helperFunctions with a reason.`,
        ).toEqual({ unknown: [], badTypes: [] });
      });

      it('has at least one HTTP method handler (route.ts with none is dead code)', () => {
        expect(parsed.methods.length).toBeGreaterThan(0);
      });

      it('config export names are all from the App Router allow-list', () => {
        // Defense in depth — guards against `export const Dynamic = ...`
        // (capital D) silently falling back to the default.
        const offenders = parsed.config.filter(
          (n) => !ALLOWED_CONFIG_EXPORTS.has(n),
        );
        expect(offenders).toEqual([]);
      });
    });
  }

  // Cross-cutting hygiene checks.
  it('NO route file imports client-only React hooks (routes are server-only)', () => {
    // `useState` / `useEffect` inside a route.ts is a copy-paste bug
    // from a page component — the route would never run correctly.
    const hits: string[] = [];
    for (const rel of discovered) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const noComments = stripCommentsOnlyRegex(src);
      if (/\buse(State|Effect|Router|SearchParams|Memo|Callback|Ref)\b/.test(noComments)) {
        hits.push(rel);
      }
    }
    expect(
      hits,
      `route.ts files importing client hooks (routes are server-only): ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });

  it("NO route file declares 'use client' directive (routes are server-only)", () => {
    const hits: string[] = [];
    for (const rel of discovered) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      // Match a leading `'use client'` / `"use client"` directive.
      if (/^\s*['"]use client['"]\s*;?/m.test(src)) hits.push(rel);
    }
    expect(
      hits,
      `route.ts files with 'use client' directive (must be server-only): ${JSON.stringify(hits)}`,
    ).toEqual([]);
  });

  it('every route with `dynamic` config sets it to a valid value', () => {
    // Valid: 'auto' | 'force-dynamic' | 'error' | 'force-static'.
    const valid = new Set(['auto', 'force-dynamic', 'error', 'force-static']);
    for (const rel of discovered) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const noComments = stripCommentsOnlyRegex(src);
      const m = /\bexport\s+const\s+dynamic\s*=\s*['"]([^'"]+)['"]/.exec(noComments);
      if (!m) continue;
      expect(
        valid.has(m[1]),
        `${rel}: dynamic='${m[1]}' is not a valid Next.js App Router value (${[...valid].join(', ')})`,
      ).toBe(true);
    }
  });

  it('every route with `runtime` config sets it to nodejs or edge', () => {
    // EvenQuote uses nodejs for everything that hits Supabase
    // admin / Stripe / Resend. The audit permits 'edge' too for
    // future flexibility but hard-fails on typos.
    const valid = new Set(['nodejs', 'edge']);
    for (const rel of discovered) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const noComments = stripCommentsOnlyRegex(src);
      const m = /\bexport\s+const\s+runtime\s*=\s*['"]([^'"]+)['"]/.exec(noComments);
      if (!m) continue;
      expect(
        valid.has(m[1]),
        `${rel}: runtime='${m[1]}' is not a valid Next.js runtime (nodejs|edge)`,
      ).toBe(true);
    }
  });

  // Coverage tripwire — count must match to prevent "forgot to add
  // to EXPECTED_ROUTES" drift alongside discovery.
  it('route count is unchanged — adding a route requires an EXPECTED_ROUTES entry', () => {
    expect(
      discovered.length,
      `new route.ts detected — update EXPECTED_ROUTES. Discovered: ${JSON.stringify(discovered)}`,
    ).toBe(Object.keys(EXPECTED_ROUTES).length);
  });
});
