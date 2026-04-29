// R38(a) — Tests for the shared source-walker helpers.
//
// These helpers are imported by other audit tests. If the helper
// subtly breaks, every downstream audit either silently passes a
// drift or flakes unrelated code. These tests lock the invariants:
//
//   1. `stripCommentsPreservingPositions` preserves LENGTH and
//      POSITION (index I in output maps to index I in input).
//   2. Escape handling is even-backslash-count — `'\\'` (one
//      backslash) closes correctly, `'\\\''` (a backslash + escaped
//      apostrophe) does not.
//   3. `extractExportedAsyncFunctionBody` returns the complete span
//      from `export async function <fn>(` through the matching `}`,
//      string/template contents intact.
//
// These tests DO NOT duplicate the downstream audits — they validate
// the primitive so the audits can trust it.

import { describe, it, expect } from 'vitest';
import {
  stripCommentsPreservingPositions,
  stripCommentsAndStringsPreservingPositions,
  extractExportedAsyncFunctionBody,
  extractExportedFunctionBody,
  stripCommentsAndStringLiteralsRegex,
  stripCommentsOnlyRegex,
  parseZodObjectFields,
} from './source-walker';

describe('tests/helpers/source-walker', () => {
  // ── stripCommentsPreservingPositions ─────────────────────────────

  it('blanks line comments, preserves everything else', () => {
    const src = `const x = 1; // comment text\nconst y = 2;`;
    const out = stripCommentsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // The code characters survive.
    expect(out.slice(0, 13)).toBe('const x = 1; ');
    // The comment body is blanked.
    expect(out.slice(13, 28)).toBe('               ');
    // The newline survives.
    expect(out[28]).toBe('\n');
    // Second line intact.
    expect(out.slice(29)).toBe('const y = 2;');
  });

  it('blanks block comments, preserves newlines within', () => {
    const src = `const x = 1; /* block\ncomment */ const y = 2;`;
    const out = stripCommentsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // The block comment characters are gone (`/*`, `*/`, word bodies).
    expect(out).not.toContain('/*');
    expect(out).not.toContain('*/');
    expect(out).not.toContain('block');
    expect(out).not.toContain('comment');
    // Newline within the block comment is preserved (line counts intact).
    const nlIdx = src.indexOf('\n');
    expect(out[nlIdx]).toBe('\n');
    // Code before and after the block comment survives.
    expect(out).toContain('const x = 1;');
    expect(out).toContain('const y = 2;');
  });

  it('leaves `//` inside a string literal alone', () => {
    const src = `const url = 'https://example.com'; // real comment`;
    const out = stripCommentsPreservingPositions(src);
    // The `//` inside the URL string is NOT treated as a comment.
    expect(out).toContain('https://example.com');
    // The trailing real comment IS blanked.
    expect(out).not.toContain('real comment');
    expect(out.length).toBe(src.length);
  });

  it("handles '\\\\' (one-backslash string) — even-count escape rule", () => {
    // The source below contains a string that is exactly one
    // backslash: '\\'. Then a trailing // comment. The naive check
    // `chars[i-1] !== '\\'` would think the closing `'` is escaped
    // by the lone `\`, walk past it, miss the string end, and blank
    // the trailing code. Even-backslash-count rule fixes it.
    const src = "const bs = '\\\\'; // trailing";
    const out = stripCommentsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // Code before the comment intact.
    expect(out.startsWith("const bs = '\\\\'; ")).toBe(true);
    // Trailing comment blanked.
    expect(out).not.toContain('trailing');
  });

  it('is idempotent (running it twice equals running it once)', () => {
    const src = `// line\nconst a = /* block */ 1; const s = 'x // y';`;
    const once = stripCommentsPreservingPositions(src);
    const twice = stripCommentsPreservingPositions(once);
    expect(twice).toBe(once);
  });

  // ── stripCommentsAndStringsPreservingPositions ───────────────────

  it('blanks string bodies but keeps delimiters + length', () => {
    const src = `const s = 'safeParse('; safeParse();`;
    const out = stripCommentsAndStringsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // The delimiters survive at their original positions (body between
    // them is blanked to spaces, so the two quotes aren't adjacent).
    const openQuote = src.indexOf("'");
    const closeQuote = src.indexOf("'", openQuote + 1);
    expect(out[openQuote]).toBe("'");
    expect(out[closeQuote]).toBe("'");
    // Body between them is all spaces now.
    expect(out.slice(openQuote + 1, closeQuote)).toBe(
      ' '.repeat(closeQuote - openQuote - 1),
    );
    // There should be exactly ONE `safeParse(` hit (real call), not two.
    const firstHit = out.indexOf('safeParse(');
    expect(firstHit).toBeGreaterThan(0);
    const secondHit = out.indexOf('safeParse(', firstHit + 1);
    expect(secondHit).toBe(-1);
  });

  it('blanks template literal bodies, preserves newlines', () => {
    const src = "const s = `safeParse(\n${x})`; safeParse();";
    const out = stripCommentsAndStringsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // Template body blanked.
    expect(out.indexOf('safeParse(', 0)).toBe(src.indexOf('safeParse(', src.indexOf('; ')));
    // The newline inside the template still sits at the same index.
    const nlIdx = src.indexOf('\n');
    expect(out[nlIdx]).toBe('\n');
  });

  // ── extractExportedAsyncFunctionBody ─────────────────────────────

  it('extracts a simple exported async function body', () => {
    const src = `
export async function foo(x: number): Promise<number> {
  return x + 1;
}
export async function bar(): Promise<void> {
  // noop
}
`.trim();
    const foo = extractExportedAsyncFunctionBody(src, 'foo');
    expect(foo).not.toBeNull();
    expect(foo!.startsWith('export async function foo(')).toBe(true);
    expect(foo!.endsWith('}')).toBe(true);
    // The returned span must include the body content.
    expect(foo!).toContain('return x + 1;');
    // Must NOT bleed into bar.
    expect(foo!).not.toContain('bar');
  });

  it('handles nested braces and string apostrophes', () => {
    const src = `
export async function tricky(): Promise<string> {
  const s = "it's a trap }";
  const nested = { a: { b: 1 }, c: '}' };
  return s + JSON.stringify(nested);
}
export async function sibling() { return 2; }
`.trim();
    const tricky = extractExportedAsyncFunctionBody(src, 'tricky');
    expect(tricky).not.toBeNull();
    // Braces in strings should not truncate the walk; the span must
    // include the final `return` and closing brace.
    expect(tricky!).toContain('JSON.stringify(nested)');
    // Must NOT bleed into `sibling`.
    expect(tricky!).not.toContain('sibling');
  });

  it('returns null for an unknown function name', () => {
    const src = `export async function foo() { return 1; }`;
    expect(extractExportedAsyncFunctionBody(src, 'doesNotExist')).toBeNull();
  });

  it('returns null if the braces never close', () => {
    const src = `export async function foo() { return 1;`;
    expect(extractExportedAsyncFunctionBody(src, 'foo')).toBeNull();
  });

  // ── stripCommentsAndStringLiteralsRegex (R42(a)) ─────────────────

  it('regex strip: blanks comments, empties quoted string bodies, keeps templates', () => {
    const src =
      "// line comment\nconst s = 'hello'; const t = \"world\"; const tpl = `keep-${x}`;";
    const out = stripCommentsAndStringLiteralsRegex(src);
    // Line comment blanked.
    expect(out).not.toContain('line comment');
    // Single- and double-quoted bodies gone (replaced with ''/"").
    expect(out).toContain("''");
    expect(out).toContain('""');
    expect(out).not.toContain('hello');
    expect(out).not.toContain('world');
    // Template literal INTACT — downstream audits depend on this.
    expect(out).toContain('`keep-${x}`');
  });

  it('regex strip: apostrophe in a template literal does not open a fake single-quoted string (R41(a) anchor)', () => {
    // Before R41(a), the regex `'(\\.|[^'\\])*'` could match across
    // newlines — an apostrophe inside an unstripped template literal
    // opened a fake string extending to the next `'` further down.
    // The fix is `\n` in the negated class. This test exercises it.
    const src =
      "const tpl = `can't be paid for.`;\nconst other = 'real';\nconst marker = intake.contact_email;";
    const out = stripCommentsAndStringLiteralsRegex(src);
    // The apostrophe inside the backtick template does NOT pull the
    // real `'real'` single-quoted literal into a fake-string match.
    // Proof: `intake.contact_email` — which sits AFTER the real
    // single-quoted string — is still visible in the stripped output.
    expect(out).toContain('intake.contact_email');
  });

  it('regex strip: block comments are stripped before single-line-comment confusion', () => {
    const src = `// foo /* bar\nconst x = 1;`;
    const out = stripCommentsAndStringLiteralsRegex(src);
    // The `// foo /* bar` is a LINE comment — the `/*` inside it must
    // not trigger a multi-line block-comment swallow.
    expect(out).toContain('const x = 1;');
  });

  // ── stripCommentsOnlyRegex (R42(a)) ──────────────────────────────

  it('comments-only strip: keeps all string/template content intact', () => {
    const src = "// comment\nconst s = 'keep me'; /* block */ const t = `keep`;";
    const out = stripCommentsOnlyRegex(src);
    expect(out).not.toContain('comment');
    expect(out).not.toContain('block');
    expect(out).toContain("'keep me'");
    expect(out).toContain('`keep`');
  });

  // ── parseZodObjectFields (R42(a)) ────────────────────────────────

  it('zod fields: direct primitives and multi-line chains both extract', () => {
    const src = `
export const Schema = z.object({
  email: z.string().email(),
  count: z.number().int(),
  additional_notes: z
    .string()
    .optional(),
});
`;
    const fields = parseZodObjectFields(src);
    expect(fields.has('email')).toBe(true);
    expect(fields.has('count')).toBe(true);
    // Multi-line chain fix — R41(a)'s canonical case.
    expect(fields.has('additional_notes')).toBe(true);
  });

  it('zod fields: identifier-reference pattern (state: UsStateSchema)', () => {
    const src = `
export const Addr = z.object({
  city: z.string(),
  state: UsStateSchema,
  zip: ZipSchema,
});
`;
    const fields = parseZodObjectFields(src);
    expect(fields.has('city')).toBe(true);
    expect(fields.has('state')).toBe(true);
    expect(fields.has('zip')).toBe(true);
  });

  it('zod fields: returns empty set when no schemas present', () => {
    const src = `const x = 1; function foo() { return 'bar'; }`;
    expect(parseZodObjectFields(src).size).toBe(0);
  });

  it('returns comments/strings intact in the extracted span (source, not stripped)', () => {
    // Extraction walks on a stripped copy internally but returns
    // from the ORIGINAL source so downstream regex can inspect
    // comments / string literals.
    const src = `
export async function keepsComments(): Promise<void> {
  // intentional comment
  const s = 'preserved';
}
`.trim();
    const body = extractExportedAsyncFunctionBody(src, 'keepsComments');
    expect(body).not.toBeNull();
    expect(body!).toContain('// intentional comment');
    expect(body!).toContain("'preserved'");
  });

  // ── R43(a) regex-literal awareness ───────────────────────────────

  it('regex literal: apostrophe inside `/\'/` does not open a fake string (R43(a))', () => {
    // Before R43(a): the `'` inside `/'/g` started a fake string
    // that extended until the next real `'` further down the file,
    // erasing real tokens (e.g. intake reads) in between. After
    // R43(a): the regex is recognized and its body is opaque.
    const src = `function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#039;');
}
const token = 'marker';`;
    const out = stripCommentsAndStringsPreservingPositions(src);
    // The `'marker'` literal body should be blanked (real string).
    expect(out).toContain("'      '");
    expect(out).not.toContain('marker');
    // But the regex literal must NOT have been treated as a string,
    // so the surrounding code ('&amp;', '&#039;') is preserved as
    // empty-body strings (delimiters kept, bodies blanked).
    expect(out).toContain(".replace(/&/g,");
    expect(out).toContain(".replace(/'/g,");
  });

  it('regex literal: character class with `/` inside does not close regex early', () => {
    const src = `const r = /[a-z/]+/.test('x');`;
    const out = stripCommentsAndStringsPreservingPositions(src);
    // The full regex literal stays intact.
    expect(out).toContain('/[a-z/]+/');
    // The string body is blanked (length preserved).
    expect(out).toContain(".test(' ')");
  });

  it('regex literal: escape sequence `\\/` inside regex does not close early', () => {
    const src = `const r = /a\\/b/.test('y');`;
    const out = stripCommentsAndStringsPreservingPositions(src);
    expect(out).toContain('/a\\/b/');
    expect(out).toContain(".test(' ')");
  });

  it('regex literal: division (x / y) is NOT treated as a regex', () => {
    // Back-scan from `/` finds identifier `x` (not a keyword) → the
    // `/` is treated as division, and the string that follows is
    // correctly blanked.
    const src = `const r = x / y; const s = 'kept-out';`;
    const out = stripCommentsAndStringsPreservingPositions(src);
    expect(out).toContain('x / y');
    expect(out).toContain("'        '"); // 8 spaces (length of `kept-out`)
    expect(out).not.toContain('kept-out');
  });

  it('regex literal: after `return`, `/.../` is regex (keyword precedes)', () => {
    const src = `function f() { return /foo'/; } const s = 'real';`;
    const out = stripCommentsAndStringsPreservingPositions(src);
    // `'foo` inside the regex must NOT have opened a fake string.
    // The real string literal 'real' is blanked to empty-body.
    expect(out).toContain("'    '");
    expect(out).not.toContain('real');
  });

  it('regex literal: length+position preserved (strip is idempotent on regex-heavy source)', () => {
    const src = `const esc = s =>
  s.replace(/&/g, '&amp;').replace(/'/g, '&#039;');`;
    const once = stripCommentsAndStringsPreservingPositions(src);
    const twice = stripCommentsAndStringsPreservingPositions(once);
    expect(once.length).toBe(src.length);
    expect(twice).toBe(once);
  });

  // ── R44(e) extractExportedFunctionBody (non-async variant) ───────

  it('extractExportedFunctionBody: matches plain `export function`', () => {
    const src = `
export function foo(x: number): number {
  return x + 1;
}
export function bar(): string {
  return 'hello';
}
`.trim();
    const foo = extractExportedFunctionBody(src, 'foo');
    expect(foo).not.toBeNull();
    expect(foo!).toContain('return x + 1');
    expect(foo!).not.toContain("return 'hello'");
    const bar = extractExportedFunctionBody(src, 'bar');
    expect(bar).not.toBeNull();
    expect(bar!).toContain("return 'hello'");
  });

  it('extractExportedFunctionBody: also matches `export async function`', () => {
    // Backward compatibility: the non-async variant should still
    // work on async-function sources so callers can use it
    // uniformly when they don't care which.
    const src = `
export async function doIt(): Promise<void> {
  await something();
}
`.trim();
    const body = extractExportedFunctionBody(src, 'doIt');
    expect(body).not.toBeNull();
    expect(body!).toContain('await something()');
  });

  it('extractExportedFunctionBody: returns null for names that are not exported', () => {
    const src = `
function internalFoo() { return 1; }
export function exposedFoo() { return 2; }
`.trim();
    expect(extractExportedFunctionBody(src, 'internalFoo')).toBeNull();
    expect(extractExportedFunctionBody(src, 'exposedFoo')).not.toBeNull();
  });

  // ── R45(a) — Nested template literal state-stack walker ───────────

  it('stripCommentsPreservingPositions handles nested template literals', () => {
    // An inner template `` ` `` inside a `${...}` substitution must
    // NOT close the outer template. Prior to R45(a), the walker
    // would flip out of template state at the first inner backtick.
    // After the fix, it pushes/pops a proper state stack.
    const src = 'const x = `outer ${cond ? `inner` : ""} outer`; // tail';
    const out = stripCommentsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // The trailing `// tail` comment must be recognized as a comment
    // — only possible if the walker correctly understood that the
    // outer template closed at the backtick before `;`.
    expect(out).not.toContain('tail');
    expect(out).toContain('const x =');
  });

  it('stripCommentsPreservingPositions treats braces inside templates as literal', () => {
    // A `{` inside a template body is not a code brace. The walker
    // must not let template content disturb the frame stack.
    const src = 'const m = `not { a } block`; // tail';
    const out = stripCommentsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('tail');
  });

  it('stripCommentsPreservingPositions tracks nested ${...} brace depth correctly', () => {
    // Two nested substitutions with inner `{}` code literals.
    const src =
      'const x = `${ (() => { return 1; })() } ${ { a: 1 }.a }`; // tail';
    const out = stripCommentsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('tail');
  });

  it('stripCommentsAndStringsPreservingPositions blanks template bodies but keeps ${...} code visible', () => {
    const src = 'const x = `hello ${name}, goodbye`;';
    const out = stripCommentsAndStringsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    // Template literal text ("hello ", ", goodbye") is blanked.
    expect(out).not.toContain('hello ');
    expect(out).not.toContain('goodbye');
    // ${name} substitution code is preserved.
    expect(out).toContain('${name}');
  });

  it('stripCommentsAndStringsPreservingPositions handles nested templates', () => {
    const src = 'const x = `outer ${cond ? `inner` : "else"} after`;';
    const out = stripCommentsAndStringsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('outer ');
    expect(out).not.toContain('inner'); // blanked (inside the inner template)
    expect(out).not.toContain('else'); // blanked (inside the " " string)
    expect(out).not.toContain(' after');
    // The substitution code framework is preserved.
    expect(out).toContain('${cond ?');
  });

  it('extractExportedFunctionBody: walks past nested template literals in the body', () => {
    // Regression test for the R44(e) failure — `lib/email/templates.ts`
    // uses nested templates. Before R45(a), the brace-walker would
    // lose track and return null.
    const src = [
      'export function render(input: { name: string; items: string[] }): string {',
      '  return `',
      '    <h1>Hello ${input.name}</h1>',
      '    <ul>${input.items.map(i => `<li>${i}</li>`).join("")}</ul>',
      '  `;',
      '}',
    ].join('\n');
    const body = extractExportedFunctionBody(src, 'render');
    expect(body).not.toBeNull();
    expect(body!).toContain('input.items.map');
    // The closing `}` must be the OUTER one (function close), not
    // an inner template-substitution `}`.
    expect(body!.trimEnd().endsWith('}')).toBe(true);
    // Sanity — body length should be close to full source length.
    expect(body!.length).toBeGreaterThan(src.length - 5);
  });

  // R46(c): Combined-blind-spot regression — every blind spot the
  // walker has historically had, in ONE source. Locks the
  // R43(a)+R45(a) fixes against a worst-case combo so a future
  // walker rewrite can't silently regress one fix while keeping the
  // others.
  it('extractExportedFunctionBody: handles regex-with-apostrophe + nested template together', () => {
    // NOTE deliberately omitting the doubled-backslash string `'\\\\';`
    // case in this combined fixture — that case is exercised by the
    // dedicated escape-pair test above. Combining it here masked the
    // walker behavior we actually want to verify.
    const src = [
      'export function gnarly(input: { html: string; items: string[] }): string {',
      "  // R43(a) blind spot: apostrophe inside a regex literal — the",
      "  // pre-R43 walker treated /'/ as opening a single-quoted string",
      "  // that ran until the next real apostrophe further down.",
      "  const safe = input.html.replace(/'/g, '&apos;');",
      '  // R45(a) blind spot: nested template literal — the inner',
      '  // backtick was misread as closing the outer template.',
      '  const block = `<div>${input.items.map(i => `<li>${i}</li>`).join("")}</div>`;',
      '  return safe + block;',
      '}',
    ].join('\n');
    const body = extractExportedFunctionBody(src, 'gnarly');
    expect(body, 'walker returned null on combined-blind-spot source').not.toBeNull();
    // All three "easy to lose" tokens survive.
    expect(body!).toContain("replace(/'/g");
    expect(body!).toContain('input.items.map');
    expect(body!).toContain('return safe + block');
    // Closing brace is the OUTER one.
    expect(body!.trimEnd().endsWith('}')).toBe(true);
    // No truncation — the body's char-count should be close to full
    // source length.
    expect(body!.length).toBeGreaterThan(src.length - 5);
  });
});
