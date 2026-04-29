// R41(b) — intake_data READ-path drift audit.
//
// R39(c) locked the WRITE path: ZOD FIELD → ACTION-LEVEL PROMOTION →
// QUOTE_REQUESTS COLUMN. That audit catches a schema-rename drift on
// the way IN.
//
// What it does NOT cover: every downstream reader of `intake_data`.
// intake_data is a jsonb bag, so a reader can silently reach for
// `intake['notes']` even when the schema's canonical field is
// `additional_notes`. The TypeScript `Record<string, unknown>` gate
// makes the silent-undefined bug invisible to tsc + lint + the R39
// write-path audit. The only time this surfaces is when a customer
// notices the value didn't make it into an email.
//
// This audit closes the READ path.
//
// Scope:
//   (1) Every string literal key read from `intake_data` (via the
//       patterns `intake['<key>']` / `intake.<key>` / `intake_data.<key>`)
//       must be a member of KNOWN_FIELDS (the union of moving + cleaning
//       Zod schemas, plus an explicit ALLOWED_LEGACY list for any
//       intentionally-looser reads).
//   (2) KNOWN_FIELDS is computed at run-time from the Zod schema files
//       (moving-intake.ts + cleaning-intake.ts) by pattern-matching
//       `<field>: z.` lines inside `z.object({...})` bodies. Drift in
//       schemas flows into KNOWN_FIELDS automatically.
//   (3) A READ_SITES catalog lists every expected read-site with its
//       expected field set — the audit fails if a site reads a key
//       not in its declared set (catches "someone added a read
//       without adding it to the catalog") OR if a site declares a
//       key it no longer reads (ghost).
//
// Intentionally out of scope (future R42+):
//   • Type-level lock on each read (does intake.contact_email get read
//     as string? boolean?). The write path already locks the Zod type;
//     the read path would need to statically verify the cast site.
//   • jsonb->>'field' grep inside .sql — we have no such grep today.
//     All reads happen in TS; if a migration gains one, extend this
//     audit to parse .sql too.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseZodObjectFields,
  stripCommentsAndStringLiteralsRegex,
  stripCommentsOnlyRegex,
} from '../../tests/helpers/source-walker';

const ROOT = process.cwd();

// ── Parse KNOWN_FIELDS from Zod schema files ─────────────────────────
// We do NOT import the schemas at run-time — this is a lexical audit.
// Parsing the source file lets us catch drift even if a schema is
// re-exported under a different name elsewhere.
//
// R42(a): `parseZodObjectFields` now lives in
// `tests/helpers/source-walker.ts` (fourth use-site lift). The
// whitespace-tolerant `z\s*\.` regex that fixed R41(a)'s
// `additional_notes: z\n .string()` miss is in the canonical helper.

function readFieldSetsFromSchemaFiles(): { moving: Set<string>; cleaning: Set<string> } {
  const moving = fs.readFileSync(
    path.join(ROOT, 'lib/forms/moving-intake.ts'),
    'utf8',
  );
  const cleaning = fs.readFileSync(
    path.join(ROOT, 'lib/forms/cleaning-intake.ts'),
    'utf8',
  );
  return {
    moving: parseZodObjectFields(moving),
    cleaning: parseZodObjectFields(cleaning),
  };
}

// ── Parse READ-path keys from a TS/TSX file ──────────────────────────
//
// We detect three patterns — each distinguishable at parse time:
//   A.  intake['<key>']         — bracket access with string literal
//   B.  intake.<key>            — dot access
//   C.  <any>.intake_data.<key> — dot access via the column name
//
// False positives we must avoid:
//   • `intake_data` appearing inside a .select() string — not a read
//     but a column list. We strip string literals before parsing.
//   • `intake.contact_email?.trim()` — trailing `?.` / `.trim()` — we
//     only care about the key in the access position.
//   • `intake_data: Record<string, unknown>` — a type annotation, not
//     a read. Not a pattern match since `Record` isn't a key.

// R42(a): `stripCommentsAndStringLiteralsRegex` and `stripCommentsOnlyRegex`
// now live in `tests/helpers/source-walker.ts`. Same regexes, same
// grammar-anchoring (`\n` in the negated class — see source-walker
// header for the full R41(a) rationale).

// For the "bracket with literal" pattern we INTENTIONALLY keep string
// literals — that's how the key is expressed.
function extractBracketKeys(src: string): Set<string> {
  const keys = new Set<string>();
  // Strip comments only (keep strings). See source-walker header for
  // line-comments-first rationale.
  const noComments = stripCommentsOnlyRegex(src);
  const re = /\bintake\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

function extractDotKeys(src: string): Set<string> {
  const keys = new Set<string>();
  // Strip strings and comments so dotted access inside strings is ignored.
  const stripped = stripCommentsAndStringLiteralsRegex(src);
  // Pattern: `<boundary>intake.<key>` — avoid intake_data/intake['...'].
  // Boundary: start-of-file or non-word char. Lookbehind unavailable in
  // some runtimes so use a non-capturing group.
  const re = /(?:^|[^\w])intake\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const key = m[1];
    // Filter methods/properties we know are not fields. The jsonb bag
    // is flat; no methods.
    if (key === 'length' || key === 'constructor') continue;
    keys.add(key);
  }
  return keys;
}

// R44(d): PostgREST JSON path read pattern — `intake_data->>key` or
// `intake_data->'key'`. Used from .ilike()/.eq() predicates in Supabase
// query builder. KEEP string literals so the key inside the path is
// visible.
function extractPostgRESTKeys(src: string): Set<string> {
  const keys = new Set<string>();
  const noComments = stripCommentsOnlyRegex(src);
  // `->>contact_email` (bare identifier) OR `->>'contact_email'` OR
  // `->'contact_email'`. Match both `->` and `->>`.
  const re = /intake_data\s*->>?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

function extractAllReadKeys(src: string): Set<string> {
  const out = new Set<string>([
    ...extractBracketKeys(src),
    ...extractDotKeys(src),
    ...extractPostgRESTKeys(src),
  ]);
  return out;
}

// ── READ_SITES catalog ───────────────────────────────────────────────
//
// Each entry lists a file + the exact set of intake_data keys it
// reads today. An unexpected key read at that site fails tests. A
// declared key that no longer appears at that site fails tests.

interface ReadSite {
  path: string;
  description: string;
  reads: Set<string>;
}

// IMPORTANT: when updating this list, ONLY include fields that the
// source actually reads today. The audit is two-way — additions AND
// removals are flagged.

const READ_SITES: ReadSite[] = [
  {
    path: 'app/admin/requests/page.tsx',
    description: 'admin list: contact name/email tile',
    reads: new Set(['contact_name', 'contact_email']),
  },
  {
    path: 'app/admin/requests/[id]/page.tsx',
    description: 'admin detail: fallback contact email when no profile',
    reads: new Set(['contact_email']),
  },
  {
    path: 'app/get-quotes/checkout/page.tsx',
    description: 'checkout page: email mask + origin city/state preview',
    reads: new Set(['contact_email', 'origin_city', 'origin_state']),
  },
  {
    path: 'app/get-quotes/success/page.tsx',
    description: 'success page: email for post-payment magic link',
    reads: new Set(['contact_email']),
  },
  {
    path: 'app/get-quotes/claim/route.ts',
    description: 'claim route: verify signed-in email == intake email',
    reads: new Set(['contact_email']),
  },
  {
    path: 'app/api/stripe/webhook/route.ts',
    description: 'webhook: extract contact email for post-payment magic link',
    reads: new Set(['contact_email']),
  },
  {
    path: 'lib/actions/checkout.ts',
    description: 'checkout action: Stripe prefill email',
    reads: new Set(['contact_email']),
  },
  {
    path: 'lib/actions/release-contact.ts',
    description:
      'contact release: customer fields for email + summarizeIntake bullets',
    reads: new Set([
      'contact_name',
      'contact_phone',
      'contact_email',
      'origin_city',
      'destination_city',
      'move_date',
      'home_size',
      'cleaning_type',
      'bathrooms',
      'additional_notes',
    ]),
  },
  {
    path: 'lib/cron/send-reports.ts',
    description: 'hourly report cron: guest recipient fallback',
    reads: new Set(['contact_email', 'contact_name']),
  },
  {
    // R44(d): admin user-detail page joins unclaimed quote_requests
    // via `.ilike('intake_data->>contact_email', profile.email)`. This
    // is a PostgREST JSON-path read, not a destructure; the new
    // `extractPostgRESTKeys` extractor picks it up.
    path: 'app/admin/users/[id]/page.tsx',
    description:
      'admin user detail: link unclaimed requests by intake email',
    reads: new Set(['contact_email']),
  },
];

// ── Tests ────────────────────────────────────────────────────────────

const { moving, cleaning } = readFieldSetsFromSchemaFiles();
const KNOWN_FIELDS = new Set<string>([...moving, ...cleaning]);

describe('intake_data READ-path drift (R41)', () => {
  // Sanity: schemas parse to something sensible.
  it('moving schema exposes core fields (contact_*, origin_*, destination_*)', () => {
    expect(moving.has('contact_email')).toBe(true);
    expect(moving.has('contact_name')).toBe(true);
    expect(moving.has('contact_phone')).toBe(true);
    expect(moving.has('origin_city')).toBe(true);
    expect(moving.has('destination_city')).toBe(true);
    expect(moving.has('move_date')).toBe(true);
    expect(moving.has('home_size')).toBe(true);
    expect(moving.has('additional_notes')).toBe(true);
  });

  it('cleaning schema exposes core fields (contact_*, address, bathrooms, cleaning_type)', () => {
    expect(cleaning.has('contact_email')).toBe(true);
    expect(cleaning.has('contact_name')).toBe(true);
    expect(cleaning.has('contact_phone')).toBe(true);
    expect(cleaning.has('bathrooms')).toBe(true);
    expect(cleaning.has('cleaning_type')).toBe(true);
    expect(cleaning.has('home_size')).toBe(true);
    expect(cleaning.has('additional_notes')).toBe(true);
  });

  // Per-site: every key read at the site is in KNOWN_FIELDS.
  for (const site of READ_SITES) {
    it(`${site.path}: every read key is a known schema field`, () => {
      const src = fs.readFileSync(path.join(ROOT, site.path), 'utf8');
      const actualReads = extractAllReadKeys(src);
      const unknownReads = [...actualReads].filter((k) => !KNOWN_FIELDS.has(k));
      expect(
        unknownReads,
        `${site.path} reads intake keys NOT present in any Zod schema: ${JSON.stringify(unknownReads)}`,
      ).toEqual([]);
    });
  }

  // Per-site: actual reads equal declared reads (bidirectional).
  for (const site of READ_SITES) {
    it(`${site.path}: READ_SITES entry matches actual source reads`, () => {
      const src = fs.readFileSync(path.join(ROOT, site.path), 'utf8');
      const actualReads = extractAllReadKeys(src);
      const expected = new Set(site.reads);

      const missing = [...expected].filter((k) => !actualReads.has(k));
      const extra = [...actualReads].filter((k) => !expected.has(k));

      expect(
        { missing, extra },
        `${site.path} READ_SITES drift. missing=${JSON.stringify(missing)}; extra=${JSON.stringify(extra)}`,
      ).toEqual({ missing: [], extra: [] });
    });
  }

  // Coverage tripwire: if any file in app/ or lib/ references `intake_data`
  // or has `const intake = ...` from a request, it should be in READ_SITES
  // OR explicitly excluded. Keep the allow-list tight.
  const EXCLUDED_FROM_READ_SITES = new Set<string>([
    // The write-path actions — they create intake_data, they don't read it.
    'lib/actions/intake.ts',
    'lib/actions/cleaning-intake.ts',
    // The calls engine fans out ALL intake keys to the Vapi prompt —
    // it's a generic passthrough, not a named-field reader.
    'lib/calls/engine.ts',
    // Retry-calls cron also uses the generic passthrough via
    // buildVariableValues().
    'lib/cron/retry-failed-calls.ts',
    // Dev surface — gated by DEV_TRIGGER_TOKEN.
    'app/api/dev/skip-payment/route.ts',
    'app/api/dev/trigger-call/route.ts',
    // Test files and the write-path drift audits.
    'lib/actions/intake-promotion-drift.test.ts',
    'lib/actions/actions-zod-schema-drift.test.ts',
    'lib/actions/actions-return-convention-audit.test.ts',
    'lib/actions/actions-rate-limit-audit.test.ts',
    'lib/actions/intake-rate-limit-audit.test.ts',
    'lib/actions/intake.test.ts',
    'lib/actions/cleaning-intake.test.ts',
    'lib/actions/checkout.test.ts',
    'lib/actions/release-contact.test.ts',
    'lib/actions/post-payment.test.ts',
    'lib/calls/engine.test.ts',
    'lib/cron/send-reports.test.ts',
    'lib/cron/retry-failed-calls.test.ts',
    'app/api/stripe/webhook/route.test.ts',
    'app/get-quotes/claim/route.test.ts',
    'scripts/test-e2e.ts',
    'lib/logger.test.ts',
    'supabase/migrations-drift.test.ts',
    'supabase/seed-category-slug-drift.test.ts',
    'lib/lib-reason-types.test.ts',
    'lib/actions/post-payment.ts',
    // Schema files themselves reference intake fields in header comments.
    'lib/forms/moving-intake.ts',
    'lib/forms/cleaning-intake.ts',
    // This audit file itself enumerates keys.
    'lib/actions/intake-read-path-drift.test.ts',
    // Migration files are DDL — intake_data column declaration only.
    'supabase/migrations/0001_initial_schema.sql',
    'supabase/migrations/0003_stripe_payments.sql',
    // Other test files referencing intake keys as fixture data.
    'supabase/rls-policy-drift.test.ts',
    'supabase/rls-policy-predicate-drift.test.ts',
  ]);

  it('coverage: every source file that reads intake_data is in READ_SITES or EXCLUDED', () => {
    const candidateDirs = [
      path.join(ROOT, 'app'),
      path.join(ROOT, 'lib'),
      path.join(ROOT, 'scripts'),
      path.join(ROOT, 'supabase'),
    ];
    const cataloged = new Set(READ_SITES.map((s) => s.path));
    function walk(dir: string, out: string[] = []): string[] {
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx|sql)$/.test(entry.name)) out.push(full);
      }
      return out;
    }
    const files = candidateDirs.flatMap((d) => walk(d));
    const unlisted: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      if (cataloged.has(rel) || EXCLUDED_FROM_READ_SITES.has(rel)) continue;
      const src = fs.readFileSync(f, 'utf8');
      // Heuristic: file MIGHT be a read site if it contains the pattern
      // `intake_data` AND also has `const intake = (...intake_data` OR
      // a direct `intake_data->>` read or `intake_data.contact_` etc.
      const looksLikeReadSite =
        /const\s+intake\s*=\s*\([\s\S]*?\.intake_data/.test(src) ||
        /intake_data\s*->>/.test(src) ||
        /intake_data\.(contact_|origin_|destination_|home_|move_|cleaning_|bathrooms|additional_|address\b|zip\b)/.test(
          src,
        );
      if (looksLikeReadSite) unlisted.push(rel);
    }
    expect(
      unlisted,
      `unlisted source files appear to read intake_data: ${JSON.stringify(unlisted)}. Add them to READ_SITES or EXCLUDED_FROM_READ_SITES.`,
    ).toEqual([]);
  });

  // Shared-key drift: `contact_*` fields are in BOTH moving & cleaning
  // schemas. A rename in only one vertical would silently break email
  // templates across the whole app.
  it('shared contact fields are present in BOTH moving and cleaning schemas', () => {
    for (const k of ['contact_name', 'contact_phone', 'contact_email']) {
      expect(moving.has(k), `moving schema missing ${k}`).toBe(true);
      expect(cleaning.has(k), `cleaning schema missing ${k}`).toBe(true);
    }
  });

  // FORBIDDEN read keys — these are historical drift that we've fixed
  // and never want to see come back. `notes` was once read by
  // release-contact.ts — it was a silent alias for additional_notes.
  it('no read site references historical-drift keys (`notes`, `bedrooms`)', () => {
    const forbidden = new Set(['notes', 'bedrooms']);
    for (const site of READ_SITES) {
      const src = fs.readFileSync(path.join(ROOT, site.path), 'utf8');
      const reads = extractAllReadKeys(src);
      const hits = [...reads].filter((k) => forbidden.has(k));
      expect(
        hits,
        `${site.path} reads a historical-drift key: ${JSON.stringify(hits)}`,
      ).toEqual([]);
    }
  });

  // Sanity: at least 10 distinct fields appear across the 2 verticals.
  it('parsed schemas expose a reasonable number of fields', () => {
    expect(KNOWN_FIELDS.size).toBeGreaterThanOrEqual(15);
  });
});
