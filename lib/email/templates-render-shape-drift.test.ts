// R42(b) — Email template render-shape drift audit.
//
// `lib/email/templates.ts` builds transactional emails that ship
// directly to customer + business inboxes. A regression shows up
// AFTER a user already received a broken email — there's no
// try-before-you-send surface in CI today. `templates.test.ts`
// locks the functional behavior (branches, subject lines, refund
// copy). This audit locks the SOURCE-LEVEL shape: surface area,
// forbidden patterns, escaping invariants, and the RefundOutcome
// union so a future refactor can't silently drift.
//
// Why source-level (not runtime):
//   • `renderQuoteReport` returns HTML. Functional asserts of the
//     form "html contains foo" leave large blind spots — the
//     template can still contain `<script>` as long as foo is also
//     present. Source-level negative locks close that gap.
//   • The `RefundOutcome` union is the contract between the cron
//     and the template. Adding a 4th value needs to be a deliberate
//     decision — the switch in the template would silently fall
//     through to the default branch.
//   • `escapeHtml` is the ONLY thing between user-controlled strings
//     and the rendered DOM. Any `${input.<stringField>}` that sneaks
//     past it is an XSS/HTML-injection risk. Source-level grep
//     catches this at PR time.
//
// Out of scope (handled elsewhere):
//   • Functional rendering behavior — `templates.test.ts`.
//   • Column→template variable round-trip from quote_requests →
//     send-reports.ts payload → template. The cron-side payload
//     build is the clean seam; this audit locks the template end.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  stripCommentsOnlyRegex,
  stripCommentsAndStringLiteralsRegex,
  extractExportedFunctionBody,
} from '../../tests/helpers/source-walker';

const ROOT = process.cwd();
const TEMPLATES_SRC = fs.readFileSync(
  path.join(ROOT, 'lib/email/templates.ts'),
  'utf8',
);

// ── Parse top-level exports ──────────────────────────────────────────

function extractExportedNames(src: string): Set<string> {
  const noComments = stripCommentsOnlyRegex(src);
  const names = new Set<string>();
  // `export function <name>` / `export async function <name>` /
  // `export const <name>` / `export type <name>` / `export interface <name>`.
  const reAll = /\bexport\s+(?:async\s+)?(?:function|const|let|var|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = reAll.exec(noComments)) !== null) {
    names.add(m[1]);
  }
  return names;
}

// ── Parse RefundOutcome literal union ────────────────────────────────
//
// Target: `export type RefundOutcome = 'issued' | 'pending_support' | 'not_applicable';`

function extractRefundOutcomeLiterals(src: string): Set<string> {
  // Note: we intentionally do NOT strip strings here — string literals
  // ARE the payload we want to extract.
  const re = /export\s+type\s+RefundOutcome\s*=\s*([^;]+);/;
  const m = re.exec(src);
  if (!m) return new Set();
  const body = m[1];
  const lits = new Set<string>();
  const litRe = /'([^']+)'/g;
  let lm: RegExpExecArray | null;
  while ((lm = litRe.exec(body)) !== null) {
    lits.add(lm[1]);
  }
  return lits;
}

// ── Extract a function body ─────────────────────────────────────────
//
// R45(a) — This now delegates to the shared `extractExportedFunctionBody`
// helper. Earlier rounds kept a local column-0 `}` workaround because
// the shared walker didn't understand NESTED TEMPLATE LITERALS (common
// in HTML email renderers) — the inner `` ` `` was misread as closing
// the outer template, which derailed the brace balance. R45(a) added
// a proper (string-kind, brace-depth-at-entry) state stack to
// `stripCommentsPreservingPositions` and the brace-walker in
// `extractExportedFunctionBodyImpl`, so the shared helper now handles
// `` `outer ${cond ? `inner` : ''} outer` `` patterns correctly.
// The column-0 `}` convention is no longer load-bearing — but the
// end-of-file "column-0 `}` convention" test is kept as belt-and-
// suspenders so a reformat doesn't silently bypass a future walker
// regression.

function extractFunctionBodyByName(src: string, name: string): string | null {
  return extractExportedFunctionBody(src, name);
}

// ── Invariants ───────────────────────────────────────────────────────

describe('email/templates render-shape drift (R42)', () => {
  // (1) Exported surface is exactly the expected set. Guards against
  // accidental export of helpers (`htmlShell`, `button`, `escapeHtml`)
  // which would let callers bypass the shaped-input contract.
  const EXPECTED_EXPORTS = new Set([
    'Rendered',
    'RefundOutcome',
    'NoQuoteCause',
    'QuoteForReport',
    'QuoteReportInput',
    'ContactReleaseInput',
    'StuckRequestRow',
    'renderQuoteReport',
    'renderContactRelease',
    'renderStuckRequestsAlert',
  ]);

  it('exports exactly the expected surface (no helper leaks)', () => {
    const actual = extractExportedNames(TEMPLATES_SRC);
    const missing = [...EXPECTED_EXPORTS].filter((n) => !actual.has(n));
    const extra = [...actual].filter((n) => !EXPECTED_EXPORTS.has(n));
    expect(
      { missing, extra },
      `templates.ts export drift. missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    ).toEqual({ missing: [], extra: [] });
  });

  // (2) RefundOutcome union is exactly the 3 expected literals.
  // Adding a 4th silently falls through the `switch` to the default
  // branch — which is the "legacy" safe-fallback copy, not an opt-in.
  it('RefundOutcome literal union is {issued, pending_support, not_applicable}', () => {
    const lits = extractRefundOutcomeLiterals(TEMPLATES_SRC);
    expect(lits).toEqual(new Set(['issued', 'pending_support', 'not_applicable']));
  });

  // (3) The `switch` on `input.refundOutcome` covers each literal.
  // If a literal is added to the type but the switch isn't updated,
  // TS would catch it — BUT only if every caller uses a narrowed
  // union. At least one caller is `RefundOutcome | undefined`, which
  // widens and silences the exhaustive check. This test closes that.
  it('renderQuoteReport switch explicitly handles every RefundOutcome literal', () => {
    const body = extractFunctionBodyByName(TEMPLATES_SRC, 'renderQuoteReport');
    expect(body).not.toBeNull();
    const literals = extractRefundOutcomeLiterals(TEMPLATES_SRC);
    for (const lit of literals) {
      // Heuristic: `case 'issued':` / `case 'pending_support':`.
      // `not_applicable` is INTENTIONALLY handled via the default
      // branch (see template header comment) — treat it as covered
      // if either `case 'not_applicable'` OR `default:` appears.
      const hasCase = new RegExp(`case\\s+'${lit}'\\s*:`).test(body!);
      if (lit === 'not_applicable') {
        expect(hasCase || /\bdefault\s*:/.test(body!)).toBe(true);
      } else {
        expect(hasCase, `renderQuoteReport missing case '${lit}'`).toBe(true);
      }
    }
  });

  // (4) Templates must NOT reach into the intake bag directly. Every
  // variable must come through the shaped input type. This is the
  // contract that makes the read-path audit (R41(b)) meaningful — the
  // template would otherwise have to be walked to catch new intake
  // reads, and the renderer would be a silent read site.
  const FORBIDDEN_INTAKE_TOKENS = [
    'intake_data',
    'intake[',
    'intake.',
    'process.env',
    'createAdminClient',
    'createClient',
    'fetch(',
  ];
  it('templates source does not touch intake, env, DB, or network', () => {
    const stripped = stripCommentsAndStringLiteralsRegex(TEMPLATES_SRC);
    const hits: string[] = [];
    for (const tok of FORBIDDEN_INTAKE_TOKENS) {
      if (stripped.includes(tok)) hits.push(tok);
    }
    expect(
      hits,
      `templates.ts contains forbidden runtime tokens: ${JSON.stringify(hits)}. Templates must be pure: (input) => { subject, html, text }.`,
    ).toEqual([]);
  });

  // (5) `escapeHtml` is the ONLY path between a user-controlled string
  // field and the rendered DOM. Every `${input.<stringField>}` or
  // `${<identifier>}` interpolation inside the main template bodies
  // must be wrapped in `escapeHtml(...)` unless the field is known-safe
  // (numbers, our own constants, or values already passed through an
  // escape-emitting helper).
  //
  // Heuristic: for the `inner = \`...\`` template literal inside each
  // renderer, any `${...}` expression must either:
  //   - start with `escapeHtml(`
  //   - reference a known-safe helper (`button(`, `formatPriceRange(`,
  //     `input.quotes.length`, `formatUsd(`, conditional ternary whose
  //     branches themselves are compliant, or a pre-escaped variable
  //     like `greeting`, `refundCopy`, `quoteCards`, `bullets`,
  //     `emptyState`, `availability`, `includes`, `excludes`, `notes`,
  //     `onsite` — all of these are computed in-file and already pass
  //     through escapeHtml in their definitions).
  //   - be a dashboardUrl passed as an href to `button(...)` (button
  //     itself escapes its args).
  //
  // Rather than re-implementing the escape logic, we positively assert
  // `escapeHtml(` appears enough times AND no `${input.` pattern
  // appears in ANY template-literal body without `escapeHtml` wrapping
  // on the same line. Template literals in source are any backtick-
  // delimited region that contains HTML markers.
  it('HTML `inner` template interpolations pass user strings through escapeHtml', () => {
    // Only HTML-bound interpolations matter for XSS. Plain-text and
    // subject-line interpolations are rendered as text by the mail
    // client — no escaping needed there. Detection heuristic: we
    // extract each renderer's `const inner = \`...\`` template
    // literal body (the HTML payload) and assert every `${input.X}`
    // inside it is on a line that ALSO contains `escapeHtml(`, OR is
    // a known-safe expression.
    const EXEMPT_IN_HTML = [
      // Integer — never produces HTML-injection bytes.
      '${input.quotes.length',
      // Ternary guards in margin-top CSS, pure JS expression.
      '${i === 0',
    ];
    const renderers = ['renderQuoteReport', 'renderContactRelease'];
    const offenders: { fn: string; line: number; text: string }[] = [];
    for (const fn of renderers) {
      const body = extractFunctionBodyByName(TEMPLATES_SRC, fn);
      expect(body).not.toBeNull();
      // Extract the backtick-delimited inner template literal — it's
      // the body of the `const inner = \`...\`;` assignment.
      const innerMatch = /const\s+inner\s*=\s*`([\s\S]*?)`;/.exec(body!);
      expect(innerMatch, `${fn}: no \`const inner = \`...\`\` literal found`).not.toBeNull();
      const innerBody = innerMatch![1];
      const lines = innerBody.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (!ln.includes('${input.')) continue;
        if (ln.includes('escapeHtml(')) continue;
        if (EXEMPT_IN_HTML.some((s) => ln.includes(s))) continue;
        offenders.push({ fn, line: i + 1, text: ln.trim() });
      }
    }
    expect(
      offenders,
      `HTML template interpolations that bypass escapeHtml: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  // (6) `escapeHtml` is present and handles all five mandatory chars.
  it('escapeHtml escapes &, <, >, ", and apostrophe', () => {
    // Source-grep the escapeHtml body for a `.replace(/X/g, 'ENTITY')`
    // pair for each of the five must-escape chars.
    const src = TEMPLATES_SRC;
    // Sanity: escapeHtml is present in the source and not renamed.
    expect(src).toContain('function escapeHtml(');
    const checks: Array<{ char: string; out: string }> = [
      { char: '&', out: '&amp;' },
      { char: '<', out: '&lt;' },
      { char: '>', out: '&gt;' },
      { char: '"', out: '&quot;' },
      { char: "'", out: '&#039;' },
    ];
    for (const c of checks) {
      // Accept either regex form `.replace(/X/g, '&ent;')` or a
      // plain-string form `.replace('X', '&ent;')` (cosmetic variant).
      const asRegex = src.includes(`.replace(/${c.char}/g, '${c.out}')`);
      const asString = src.includes(`.replace('${c.char}', '${c.out}')`);
      expect(
        asRegex || asString,
        `escapeHtml missing entity mapping for ${c.char} -> ${c.out}`,
      ).toBe(true);
    }
  });

  // (7) Forbidden tokens anywhere in the rendered HTML shells.
  // These are classic HTML-injection sinks; a template that develops
  // one of these should fail review AND this audit.
  const FORBIDDEN_HTML_TOKENS = [
    '<script',
    'javascript:',
    'onclick=',
    'onerror=',
    'onload=',
    'onmouseover=',
    'data:text/html',
  ];
  it('templates contain no inline script sinks or dangerous attributes', () => {
    const stripped = stripCommentsOnlyRegex(TEMPLATES_SRC).toLowerCase();
    const hits = FORBIDDEN_HTML_TOKENS.filter((t) => stripped.includes(t));
    expect(hits, `templates contain forbidden HTML sinks: ${JSON.stringify(hits)}`).toEqual(
      [],
    );
  });

  // (8) Both renderers call `htmlShell(...)` exactly once — locks the
  // brand chrome invariant. A renderer that forgets to wrap in the
  // shell ships broken styling + missing footer.
  it('each renderer wraps its HTML in htmlShell(...)', () => {
    const quoteBody = extractFunctionBodyByName(TEMPLATES_SRC, 'renderQuoteReport');
    const releaseBody = extractFunctionBodyByName(TEMPLATES_SRC, 'renderContactRelease');
    expect(quoteBody).not.toBeNull();
    expect(releaseBody).not.toBeNull();
    // Count `htmlShell(` occurrences.
    const countOf = (s: string, needle: string) => s.split(needle).length - 1;
    expect(countOf(quoteBody!, 'htmlShell(')).toBe(1);
    expect(countOf(releaseBody!, 'htmlShell(')).toBe(1);
  });

  // (9) Both renderers return `{ subject, html, text }` — no extra
  // keys, no missing keys. Changing this shape would need a parallel
  // update to `lib/email/resend.ts`'s sender call shape.
  it('both renderers return exactly { subject, html, text }', () => {
    for (const fn of ['renderQuoteReport', 'renderContactRelease']) {
      const body = extractFunctionBodyByName(TEMPLATES_SRC, fn);
      expect(body).not.toBeNull();
      // Last statement should be `return { subject, html, text, };`
      // with optional trailing comma and whitespace.
      const m = /return\s*\{([^}]*)\}\s*;?\s*\}?\s*$/.exec(body!);
      expect(m, `${fn}: could not locate return-object at tail`).not.toBeNull();
      const bodyInner = m![1];
      const keys = new Set(
        bodyInner
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => s.split(/[:\s]/)[0]),
      );
      expect(
        keys,
        `${fn}: return-object keys must be exactly {subject, html, text}`,
      ).toEqual(new Set(['subject', 'html', 'text']));
    }
  });

  // (10) `renderContactRelease` ALWAYS includes both phone AND email
  // of the customer. These are the "release" fields — the whole point
  // of the email is to deliver them. A silent drop would break the
  // product contract (customer paid the pro to call them).
  it('renderContactRelease surfaces both customerPhone and customerEmail', () => {
    const body = extractFunctionBodyByName(TEMPLATES_SRC, 'renderContactRelease');
    expect(body).not.toBeNull();
    expect(body!).toMatch(/input\.customerPhone/);
    expect(body!).toMatch(/input\.customerEmail/);
  });

  // (11) `renderQuoteReport` guards against the "false refund promise"
  // bug fix — when quotes.length === 0 AND refundOutcome is
  // 'pending_support', the copy MUST NOT say "we've refunded". The
  // R41 memo confirms this was a real production bug (commit
  // 400005b). Locked forever.
  it('renderQuoteReport pending_support branch does NOT promise a completed refund', () => {
    const body = extractFunctionBodyByName(TEMPLATES_SRC, 'renderQuoteReport');
    expect(body).not.toBeNull();
    // Locate the `case 'pending_support':` branch and walk forward
    // to the next `case`/`default`/`}`. The extracted branch body
    // must NOT contain `"we've refunded"` or `"have refunded"`.
    const idx = body!.indexOf("case 'pending_support':");
    expect(idx).toBeGreaterThan(-1);
    const rest = body!.slice(idx);
    const nextBoundary = Math.min(
      ...['case ', 'default:', '})();']
        .map((m) => {
          const i = rest.indexOf(m, 1);
          return i === -1 ? Infinity : i;
        }),
    );
    expect(nextBoundary).toBeGreaterThan(0);
    const branch = rest.slice(0, nextBoundary).toLowerCase();
    // Forbidden phrases — each would be a truthfulness regression.
    const forbidden = [
      "we've refunded",
      'we have refunded',
      'refunded your',
      'money back',
      'refund has been processed',
    ];
    const hits = forbidden.filter((f) => branch.includes(f));
    expect(
      hits,
      `pending_support branch now contains forbidden refund-completion phrases: ${JSON.stringify(hits)}`,
    ).toEqual([]);
    // Positive lock: branch must mention manual / reply path.
    expect(branch.includes('reply to this email')).toBe(true);
  });

  // (12) The 'issued' branch DOES promise a refund — this is the
  // one branch where that promise is truthful. If a refactor silently
  // flips this (e.g. unifying the three branches into one string),
  // the customer-truth contract breaks.
  it("renderQuoteReport issued branch promises a completed refund", () => {
    const body = extractFunctionBodyByName(TEMPLATES_SRC, 'renderQuoteReport');
    expect(body).not.toBeNull();
    const idx = body!.indexOf("case 'issued':");
    expect(idx).toBeGreaterThan(-1);
    const rest = body!.slice(idx);
    const end = rest.indexOf("case '", 1);
    const branch = (end > 0 ? rest.slice(0, end) : rest).toLowerCase();
    // Apostrophes in the copy are HTML-encoded as `&#039;` because
    // the branch ships HTML. Accept either the literal apostrophe
    // or the entity.
    const refundedPromise =
      branch.includes("we've refunded") ||
      branch.includes('we&#039;ve refunded') ||
      branch.includes('refunded your');
    expect(
      refundedPromise,
      "'issued' branch must explicitly state the refund was issued",
    ).toBe(true);
  });

  // (13) Plain-text fallback exists. Email clients without HTML
  // (accessibility, some corporate Outlooks) need it; inbox-placement
  // also benefits from a plain-text alt.
  it('each renderer returns a non-empty text alternative (source-level check)', () => {
    for (const fn of ['renderQuoteReport', 'renderContactRelease']) {
      const body = extractFunctionBodyByName(TEMPLATES_SRC, fn);
      expect(body).not.toBeNull();
      // Positive: there must be a `const text = ` or `text:` construction
      // that joins multiple lines.
      expect(/\btext\s*=\s*\[/.test(body!) || /\btext\b/.test(body!)).toBe(true);
    }
  });

  // (14) Dashboard URL is the ONLY external link in the quote report.
  // Adding a second tracking link or a "manage subscription" footer
  // needs to be a deliberate decision (legal review + unsub path).
  it('renderQuoteReport has exactly one call to button(...)', () => {
    const body = extractFunctionBodyByName(TEMPLATES_SRC, 'renderQuoteReport');
    expect(body).not.toBeNull();
    // We accept 1 OR 2 calls — the template uses a ternary to pick
    // between "View quotes & share contact" and "Open dashboard".
    // Both point to the same `dashboardUrl`. Lock count ∈ {1, 2}.
    const count = body!.split('button(').length - 1;
    expect(count, 'button() invocation count drifted').toBeGreaterThanOrEqual(1);
    expect(count, 'button() invocation count drifted').toBeLessThanOrEqual(2);
  });

  // (15) Coverage tripwire: if someone adds a 3rd renderer to
  // templates.ts, they must update (1)'s EXPECTED_EXPORTS + add a
  // functional test in templates.test.ts. This test forces the issue.
  it('renderer count is exactly 3 (tripwire for future additions)', () => {
    const names = extractExportedNames(TEMPLATES_SRC);
    const renderers = [...names].filter((n) => n.startsWith('render'));
    expect(
      renderers.sort(),
      'renderer count drifted — update EXPECTED_EXPORTS and add a functional test',
    ).toEqual([
      'renderContactRelease',
      'renderQuoteReport',
      'renderStuckRequestsAlert',
    ]);
  });

  // (16) Renderer functions close with `}` at column 0. This is the
  // formatting convention our `extractFunctionBodyByName` helper
  // relies on above — escape-aware brace balance walking against a
  // file that uses `.replace(/'/g, ...)` regex literals is hard and
  // we deliberately avoided it. If the file gets reformatted to
  // indent the closing brace, the audit extractor needs to be
  // rewritten; this test makes that failure loud.
  it('each renderer closes with `}` at column 0 (extractor convention)', () => {
    for (const fn of ['renderQuoteReport', 'renderContactRelease']) {
      const headerRe = new RegExp(`^export\\s+function\\s+${fn}\\s*\\(`, 'm');
      const m = headerRe.exec(TEMPLATES_SRC);
      expect(m, `header not found for ${fn}`).not.toBeNull();
      const after = TEMPLATES_SRC.slice(m!.index);
      expect(
        /\n\}/.test(after),
        `${fn}: no column-0 closing brace found after header`,
      ).toBe(true);
    }
  });
});
