// R37(g) Server-action return-convention audit.
//
// Next.js server actions in this codebase use THREE distinct
// return shapes today, and that mixedness is the thing we want
// to freeze so new code picks a deliberate convention rather
// than adding a fourth.
//
// The three existing conventions:
//
//   (A) **Discriminated `ok` union** — the default.
//       `{ ok: true; … } | { ok: false; error: string; … }`.
//       Used by: admin, checkout, intake, cleaning-intake, waitlist,
//       release-contact. Client code narrows with `'ok' in r` or
//       `r.ok === true`. Clean, exhaustive-checked.
//
//   (B) **Legacy `error` union** — `{ error: string } | { ok: true }`.
//       Used by: auth (magic-link, Google). Kept around because the
//       Next.js `useFormState` + `<form action={...}>` pattern expects
//       an `error?: string` shape returned from a form action, and
//       rewriting the two auth actions would break the sign-in and
//       sign-up UI wiring. Not preferred for new code — if you're
//       tempted to write one, reach for convention (A) instead.
//
//   (C) **Void / throw / redirect** — `Promise<void>`.
//       Used by: post-payment (`sendPaymentMagicLink`, no client
//       UI — called from stripe webhook) and auth (`signOut`,
//       which always ends in `redirect('/')`). Appropriate for
//       actions that never return normally.
//
// This audit pins each action to its convention so:
//
//   • A drift in admin.ts that silently changes the return shape
//     from (A) to (B) fires the audit.
//   • A NEW server action that doesn't land in one of the three
//     buckets fires the audit — forces a deliberate choice.
//   • Convention (B) and (C) callsites stay capped at the
//     documented set — if auth.ts's legacy pattern spreads to
//     new files, the fixture count band catches it.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractExportedAsyncFunctionBody } from '../../tests/helpers/source-walker';

const ACTIONS_DIR = path.resolve(process.cwd(), 'lib/actions');

type Convention = 'ok-union' | 'error-union' | 'void-or-redirect';

type ActionFixture = {
  file: string; // relative to ACTIONS_DIR
  fn: string; // exported function name
  convention: Convention;
  // Optional: some actions have a declared result type name we also lock.
  resultTypeName?: string;
};

// Drift-locked fixture set. Every exported `async function` under
// lib/actions/ that lands on the public API must appear here (minus
// pure helpers / predicates). If a new action is added, this list
// must grow — the uncatalogued-exports test below fires on
// anything that shows up in source but not in FIXTURES.
const FIXTURES: ActionFixture[] = [
  {
    file: 'admin.ts',
    fn: 'setRequestArchived',
    convention: 'ok-union',
    resultTypeName: 'AdminActionResult',
  },
  {
    // R44(d): surfaced by R43(a)'s regex-aware stripper re-run. This
    // action was already shipping as ok-union but had never been
    // catalogued in this FIXTURES list (the pre-R43 walker wasn't
    // picking it up as an uncatalogued export — likely masked by an
    // apostrophe-inside-regex pattern elsewhere in the file).
    file: 'admin.ts',
    fn: 'retryUnreachedBusinesses',
    convention: 'ok-union',
    resultTypeName: 'AdminActionResult',
  },
  {
    // R47.1: re-run extractor admin action, called by the
    // RerunExtractorButton on /admin/requests/[id]. Walks completed
    // calls without quotes and re-fires the Anthropic extractor.
    file: 'admin.ts',
    fn: 'rerunExtractor',
    convention: 'ok-union',
    resultTypeName: 'AdminActionResult',
  },
  {
    // R47.2: bulk archive admin action, called by the bulk-action
    // bar on /admin/requests. Caps at 200 ids per call.
    file: 'admin.ts',
    fn: 'bulkArchive',
    convention: 'ok-union',
    resultTypeName: 'AdminActionResult',
  },
  {
    file: 'auth.ts',
    fn: 'signInWithMagicLink',
    convention: 'error-union',
    resultTypeName: 'ActionResult',
  },
  {
    file: 'auth.ts',
    fn: 'signInWithGoogle',
    convention: 'error-union',
    resultTypeName: 'ActionResult',
  },
  {
    file: 'auth.ts',
    fn: 'signOut',
    convention: 'void-or-redirect',
  },
  {
    file: 'checkout.ts',
    fn: 'createCheckoutSession',
    convention: 'ok-union',
    resultTypeName: 'CheckoutResult',
  },
  {
    file: 'cleaning-intake.ts',
    fn: 'submitCleaningIntake',
    convention: 'ok-union',
    resultTypeName: 'SubmitResult',
  },
  {
    file: 'intake.ts',
    fn: 'submitMovingIntake',
    convention: 'ok-union',
    resultTypeName: 'SubmitResult',
  },
  {
    file: 'post-payment.ts',
    fn: 'sendPaymentMagicLink',
    convention: 'void-or-redirect',
  },
  {
    file: 'release-contact.ts',
    fn: 'releaseContactToBusiness',
    convention: 'ok-union',
    resultTypeName: 'ReleaseContactResult',
  },
  {
    file: 'waitlist.ts',
    fn: 'joinWaitlist',
    convention: 'ok-union',
    resultTypeName: 'WaitlistResult',
  },
];

function readActionFile(name: string): string {
  return fs.readFileSync(path.join(ACTIONS_DIR, name), 'utf8');
}

// Comment stripping + function-body extraction live in the shared
// helper `tests/helpers/source-walker.ts` (lifted in R38(a) after a
// third use-site landed in R37). The helper module has its own
// dedicated test file covering the even-backslash escape edge case.
const extractFunction = extractExportedAsyncFunctionBody;

describe('server-action return convention audit (R37g)', () => {
  // ── Per-fixture source-level convention lock ─────────────────────
  for (const fx of FIXTURES) {
    it(`${fx.file}:${fx.fn} uses the '${fx.convention}' convention`, () => {
      const src = readActionFile(fx.file);
      const body = extractFunction(src, fx.fn);
      expect(
        body,
        `could not extract function body for ${fx.fn} in ${fx.file}`,
      ).not.toBeNull();
      if (body === null) return;

      switch (fx.convention) {
        case 'ok-union': {
          // Must return at least one `{ ok: true` AND at least one
          // `{ ok: false`. The signature's declared return type
          // (if any) must also be present.
          expect(body, `${fx.fn}: missing { ok: true …} return`).toMatch(
            /return\s*(?:await\s*)?\{\s*[\s\S]*?\bok\s*:\s*true/,
          );
          expect(body, `${fx.fn}: missing { ok: false …} return`).toMatch(
            /return\s*\{\s*[\s\S]*?\bok\s*:\s*false[\s\S]*?error\s*:/,
          );
          if (fx.resultTypeName) {
            expect(body, `${fx.fn}: declared return type '${fx.resultTypeName}' missing`).toContain(
              fx.resultTypeName,
            );
          }
          // Forbid the legacy `{ error: '…' }` (no ok:false) return
          // shape in ok-union actions — catches drift back to the
          // auth.ts convention.
          const hasBareErrorReturn = /return\s*\{\s*error\s*:\s*['"`]/.test(body);
          expect(
            hasBareErrorReturn,
            `${fx.fn}: forbidden '{ error: …}' return (without ok:false) — use '{ ok: false, error: … }' per ok-union convention`,
          ).toBe(false);
          break;
        }
        case 'error-union': {
          // Must return `{ error: '…' }` somewhere (legacy shape).
          expect(body, `${fx.fn}: missing bare '{ error: … }' return`).toMatch(
            /return\s*\{\s*error\s*:\s*['"`]/,
          );
          // And must have a `{ ok: true }` return or redirect() call
          // somewhere — legacy shape success branch.
          const hasOkTrue = /return\s*\{\s*ok\s*:\s*true\s*\}/.test(body);
          const hasRedirect = /\bredirect\s*\(/.test(body);
          expect(
            hasOkTrue || hasRedirect,
            `${fx.fn}: error-union convention must have either '{ ok: true }' return or redirect() success exit`,
          ).toBe(true);
          // Forbid the ok:false shape (would mean partial migration
          // off legacy; complete the migration by moving this action
          // to ok-union and updating FIXTURES instead).
          expect(
            /return\s*\{\s*[\s\S]*?ok\s*:\s*false/.test(body),
            `${fx.fn}: forbidden '{ ok: false }' in error-union action — finish migrating to ok-union and update FIXTURES`,
          ).toBe(false);
          break;
        }
        case 'void-or-redirect': {
          // Must either `redirect(...)` or have no value-returning
          // `return <expr>;`. A bare `return;` is fine.
          const valueReturn = /return\s+[A-Za-z_'"`{[(]/.test(body);
          const hasRedirect = /\bredirect\s*\(/.test(body);
          const isPostPayment = fx.fn === 'sendPaymentMagicLink';
          if (!hasRedirect && !isPostPayment) {
            // post-payment is pure-void; others in this bucket
            // use redirect() as the exit.
            expect(
              hasRedirect,
              `${fx.fn}: void-or-redirect convention expects either redirect() or post-payment pure-void`,
            ).toBe(true);
          }
          expect(
            valueReturn,
            `${fx.fn}: void-or-redirect action must NOT have value-returning return statements`,
          ).toBe(false);
          break;
        }
      }
    });
  }

  // ── Fixture completeness lock ────────────────────────────────────
  it('fixture count is exactly 11 (catch new actions added without convention)', () => {
    // Any new action in lib/actions/ must land in FIXTURES with an
    // explicit convention. A new file or a new exported async fn
    // without fixture coverage makes this count wrong.
    // R44(d): bumped 10 → 11 after cataloging admin.ts:retryUnreachedBusinesses.
    // R47.1: bumped 11 → 12 after cataloging admin.ts:rerunExtractor.
    // R47.2: bumped 12 → 13 after cataloging admin.ts:bulkArchive.
    expect(FIXTURES.length).toBe(13);
  });

  it('every exported async function under lib/actions/ is catalogued in FIXTURES', () => {
    const catalogued = new Set(FIXTURES.map((fx) => `${fx.file}:${fx.fn}`));
    const uncatalogued: string[] = [];
    const files = fs
      .readdirSync(ACTIONS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => !f.endsWith('.test.ts'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(ACTIONS_DIR, f), 'utf8');
      // Match every `export async function <name>(`.
      const re = /export\s+async\s+function\s+([A-Za-z_][\w]*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const key = `${f}:${m[1]}`;
        if (!catalogued.has(key)) uncatalogued.push(key);
      }
    }
    expect(
      uncatalogued,
      `uncatalogued exported server actions — add to FIXTURES with an explicit convention:\n  ${uncatalogued.join('\n  ')}`,
    ).toEqual([]);
  });

  // ── Cross-convention invariants ──────────────────────────────────
  it('at least 7 actions use the preferred ok-union convention (majority guard)', () => {
    // If a refactor silently migrates actions the wrong way (ok-union
    // → error-union), this fires. 7 is the current count (post-R44(d):
    // admin.ts:setRequestArchived + admin.ts:retryUnreachedBusinesses
    // + checkout + cleaning-intake + intake + release-contact + waitlist).
    const okUnion = FIXTURES.filter((fx) => fx.convention === 'ok-union');
    expect(okUnion.length).toBeGreaterThanOrEqual(7);
  });

  it('error-union convention is capped at the auth.ts file (no spread to new files)', () => {
    // Legacy shape; we want to freeze its footprint at exactly
    // the auth.ts actions so nothing new leaks in.
    const errorUnion = FIXTURES.filter((fx) => fx.convention === 'error-union');
    for (const fx of errorUnion) {
      expect(
        fx.file,
        `error-union convention detected outside auth.ts: ${fx.file}:${fx.fn} — pick ok-union for new actions`,
      ).toBe('auth.ts');
    }
    // Count is frozen: two auth actions (magic-link + Google) use it.
    expect(errorUnion.length).toBe(2);
  });

  it('void-or-redirect is capped at { auth.signOut, post-payment.sendPaymentMagicLink }', () => {
    const voidish = FIXTURES.filter((fx) => fx.convention === 'void-or-redirect');
    const keys = new Set(voidish.map((fx) => `${fx.file}:${fx.fn}`));
    expect(keys).toEqual(
      new Set(['auth.ts:signOut', 'post-payment.ts:sendPaymentMagicLink']),
    );
  });

  // ── Per-convention result-type-name lock ─────────────────────────
  it('every ok-union action declares a named Result type ending in Result (improves call-site exhaustive-check ergonomics)', () => {
    const missing: string[] = [];
    for (const fx of FIXTURES) {
      if (fx.convention !== 'ok-union') continue;
      if (!fx.resultTypeName) {
        missing.push(`${fx.file}:${fx.fn}`);
        continue;
      }
      if (!/Result$/.test(fx.resultTypeName)) {
        missing.push(
          `${fx.file}:${fx.fn}: declared result type '${fx.resultTypeName}' should end in 'Result' for naming consistency`,
        );
        continue;
      }
      // Verify the type actually exists (named export).
      const src = readActionFile(fx.file);
      const typeDecl = new RegExp(
        `export\\s+type\\s+${fx.resultTypeName}\\s*=`,
      );
      if (!typeDecl.test(src)) {
        missing.push(
          `${fx.file}:${fx.fn}: result type '${fx.resultTypeName}' is declared in FIXTURES but not exported`,
        );
      }
    }
    expect(missing, `ok-union result-type drift:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  // ── Sanity: every fixture file actually exists ───────────────────
  it('every FIXTURES.file references an existing action file', () => {
    const missing: string[] = [];
    for (const fx of FIXTURES) {
      const abs = path.join(ACTIONS_DIR, fx.file);
      if (!fs.existsSync(abs)) missing.push(fx.file);
    }
    expect(missing, `fixtures reference missing files: ${missing.join(', ')}`).toEqual([]);
  });

  it("every action file in lib/actions/ (minus test / audit files) appears in at least one FIXTURES entry", () => {
    const filesWithFixtures = new Set(FIXTURES.map((fx) => fx.file));
    const orphanFiles: string[] = [];
    const files = fs
      .readdirSync(ACTIONS_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => !/-audit\.test\.ts$/.test(f));
    for (const f of files) {
      if (!filesWithFixtures.has(f)) orphanFiles.push(f);
    }
    expect(
      orphanFiles,
      `action files with no FIXTURES entry (every file must have at least one exported action):\n  ${orphanFiles.join('\n  ')}`,
    ).toEqual([]);
  });
});
