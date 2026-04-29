// R38(a) — Shared source-walker helpers for source-level audit tests.
//
// Multiple audit tests in this codebase walk TypeScript / SQL source
// trees and assert on positions, tokens, or extracted function bodies.
// Three distinct implementations of "strip comments" and "balanced-
// brace walk" had grown up independently by R37 close
// (`lib/actions/actions-return-convention-audit.test.ts`,
// `lib/actions/actions-rate-limit-audit.test.ts`,
// `supabase/rpc-args-drift.test.ts`). R37's close memo flagged the
// third use-site as the DRY trigger.
//
// This file is the canonical home for:
//
//   1. `stripCommentsPreservingPositions(src)` — blanks out JS/TS
//      `//`-line + `/* */`-block comments with space characters of
//      equal length. Position-preserving: a regex match index into
//      the stripped output still maps 1:1 to the same character in
//      the original source. String-aware so `//` inside a quoted
//      string doesn't count as a line comment.
//
//   2. `stripCommentsAndStringsPreservingPositions(src)` — additionally
//      blanks out string/template literal bodies (keeping the
//      delimiters and length). Used by token-position audits where
//      `'safeParse('` inside an error message string would otherwise
//      false-match a code-level `safeParse(` index lookup.
//
//   3. `extractExportedAsyncFunctionBody(src, fnName)` — finds
//      `export async function <fnName>(` in `src`, walks the paren-
//      balanced signature, then the brace-balanced body, and returns
//      the exact source span (including the signature). String-aware
//      so apostrophes / template strings inside the function body
//      don't throw off the balance walk. Returns `null` if the
//      function isn't found or braces never balance.
//
//   4. `stripCommentsAndStringLiteralsRegex(src)` — regex-based
//      pass that blanks line+block comments and replaces single/
//      double-quoted string bodies with `''`/`""`. INTENTIONALLY
//      leaves template literals intact (so `${intake.foo}` reads
//      are still visible to downstream regex walkers). Not
//      position-preserving. See R42(a) header block below.
//
//   5. `stripCommentsOnlyRegex(src)` — lighter pass: comments
//      only. Use when the caller needs string-literal bodies intact
//      (e.g. detecting `intake['key']` where the key IS the string).
//
//   6. `parseZodObjectFields(src)` — extracts field names from Zod
//      schema source (`<key>: z.<...>` and `<key>: SharedSchema`
//      patterns). Whitespace-tolerant between `z` and `.` — matches
//      multi-line chains like `foo: z\n  .string()`. See R42(a).
//
// ── Escape-handling rule (critical) ─────────────────────────────────
// A quote character closes a string iff the number of consecutive
// preceding backslashes is EVEN (zero counts). The naive
// `chars[i-1] !== '\\'` check gets this WRONG for `'\\'` (a literal
// single-backslash string) — the closing `'` has ONE preceding `\`
// but THAT `\` is part of the `\\` escape pair, not an escape on the
// quote itself. Counting backslashes handles `'\\'`, `'\\\\'`, etc.
//
// This file is imported by test files only. It has no runtime
// dependencies on app code (the app's import graph stays clean).

// ── 1. Strip comments (position + length preserving) ────────────────
//
// R43(a) — Regex-literal awareness added. Prior to R43, this walker
// treated a regex literal like `.replace(/'/g, ...)` as raw characters;
// the apostrophe inside `/'/` was interpreted as opening a
// single-quoted string that then extended to the next real `'` further
// down the file, erasing real tokens in between.
//
// R45(a) — Nested template literal awareness added. Prior to R45, the
// walker's string state was a single scalar (`false | "'" | '"' | '`').
// That worked for flat strings but got confused by nested template
// literals:
//
//     `outer ${cond ? `inner` : ''} outer`
//                     ^— the inner backtick was treated as CLOSING the
//                         outer template, so everything from the first
//                         `inner` through the next outer `` ` `` was
//                         read as code (bracketing into random source).
//
// The fix uses a STATE STACK where each frame is one of:
//
//   { kind: 'file' }                    — top-level code, parses
//                                         comments / regex / strings
//   { kind: 'string'; quote: "'" | '"' } — inside a '...' / "..." string
//   { kind: 'template' }                — inside a `...` template
//   { kind: 'sub'; braceDepth: number } — inside a ${...} substitution
//                                         of a template, code context;
//                                         pops when we see a `}` at
//                                         braceDepth 0
//
// Transitions:
//   file/sub + `'` or `"`  →  push 'string'
//   file/sub + `` ` ``     →  push 'template'
//   template + `` ` ``     →  pop (template closes)
//   template + `${`        →  push 'sub'
//   sub      + `{`         →  braceDepth++
//   sub      + `}`         →  braceDepth-- if >0 else pop (sub closes)
//
// Comments and regex literals only fire in 'file' / 'sub' frames.
// Positions and lengths are preserved; only comment characters are
// rewritten.

type WalkerFrame =
  | { kind: 'file' }
  | { kind: 'string'; quote: "'" | '"' }
  | { kind: 'template' }
  | { kind: 'sub'; braceDepth: number };

function isCodeFrame(f: WalkerFrame): boolean {
  return f.kind === 'file' || f.kind === 'sub';
}

export function stripCommentsPreservingPositions(src: string): string {
  const chars = src.split('');
  const stack: WalkerFrame[] = [{ kind: 'file' }];
  let i = 0;
  while (i < chars.length) {
    const top = stack[stack.length - 1];
    const ch = chars[i];

    if (top.kind === 'string') {
      if (ch === top.quote && !isEscaped(chars, i)) {
        stack.pop();
      }
      i++;
      continue;
    }

    if (top.kind === 'template') {
      if (ch === '`' && !isEscaped(chars, i)) {
        stack.pop();
        i++;
        continue;
      }
      if (ch === '$' && chars[i + 1] === '{' && !isEscaped(chars, i)) {
        stack.push({ kind: 'sub', braceDepth: 0 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // top is 'file' or 'sub' — code context
    if (top.kind === 'sub') {
      if (ch === '{') {
        top.braceDepth++;
        i++;
        continue;
      }
      if (ch === '}') {
        if (top.braceDepth === 0) {
          stack.pop();
          i++;
          continue;
        }
        top.braceDepth--;
        i++;
        continue;
      }
    }

    // Line comment.
    if (ch === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    // Block comment.
    if (ch === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < chars.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    // String opener.
    if (ch === "'" || ch === '"') {
      stack.push({ kind: 'string', quote: ch });
      i++;
      continue;
    }
    // Template opener.
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i++;
      continue;
    }
    // Regex literal (only if the preceding token permits one).
    if (ch === '/' && canStartRegex(chars, i)) {
      i = skipRegexLiteral(chars, i);
      continue;
    }
    i++;
  }
  // If the walker runs to EOF with an unclosed string/template, we
  // still return the processed chars — the caller treats the stripped
  // output as best-effort. Comment-stripping up to that point is valid.
  void isCodeFrame;
  return chars.join('');
}

// ── 2. Strip comments + string literal bodies (positions preserved) ─
//
// Unlike (1), this blanks out the INSIDE of string/template literals
// too — the delimiters themselves stay, so offsets relative to the
// surrounding code are unchanged. Useful for token-position audits
// where a string literal like `'createAdminClient('` would otherwise
// false-match a real `createAdminClient(` token.
//
// R43(a): Inherits regex-literal awareness from (1). Additionally,
// the second pass skips over regex literals explicitly so that an
// apostrophe-looking character inside a regex body (e.g. `/'/g`) is
// not mistaken for a string opener.

export function stripCommentsAndStringsPreservingPositions(src: string): string {
  // First pass: replace comments with spaces (position-preserving).
  const withoutComments = stripCommentsPreservingPositions(src);
  // Second pass: walk again with a STATE STACK (R45(a) upgrade) so
  // nested templates and `${...}` substitutions are handled correctly.
  // String and template literal CONTENTS are blanked to spaces; the
  // delimiters (`'`, `"`, `` ` ``) are preserved so offsets stay stable.
  // Inside a `${...}` substitution, characters are left as-is so
  // downstream regex can still see the code (e.g. `${intake.foo}` —
  // the `intake.foo` span stays visible).
  const chars = withoutComments.split('');
  const stack: WalkerFrame[] = [{ kind: 'file' }];
  let i = 0;
  while (i < chars.length) {
    const top = stack[stack.length - 1];
    const ch = chars[i];

    if (top.kind === 'string') {
      if (ch === top.quote && !isEscaped(chars, i)) {
        stack.pop();
        i++;
        continue;
      }
      // Blank the body but preserve newlines.
      if (ch !== '\n') chars[i] = ' ';
      i++;
      continue;
    }

    if (top.kind === 'template') {
      if (ch === '`' && !isEscaped(chars, i)) {
        stack.pop();
        i++;
        continue;
      }
      if (ch === '$' && chars[i + 1] === '{' && !isEscaped(chars, i)) {
        stack.push({ kind: 'sub', braceDepth: 0 });
        // DO NOT blank the `${` — and the code inside the sub is
        // intentionally left visible.
        i += 2;
        continue;
      }
      // Template literal body: blank the character (preserve newlines).
      if (ch !== '\n') chars[i] = ' ';
      i++;
      continue;
    }

    // top is 'file' or 'sub' — code context; parse tokens.
    if (top.kind === 'sub') {
      if (ch === '{') {
        top.braceDepth++;
        i++;
        continue;
      }
      if (ch === '}') {
        if (top.braceDepth === 0) {
          stack.pop();
          i++;
          continue;
        }
        top.braceDepth--;
        i++;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      stack.push({ kind: 'string', quote: ch });
      i++;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i++;
      continue;
    }
    // Regex literal — skip opaquely so `/'/` et al. don't flip state.
    if (ch === '/' && canStartRegex(chars, i)) {
      i = skipRegexLiteral(chars, i);
      continue;
    }
    i++;
  }
  return chars.join('');
}

// ── 3. Extract exported async function body ─────────────────────────
//
// Returns the full source span from `export async function <fn>(`
// through the matching closing `}`. The body is returned from the
// ORIGINAL source (comments + string contents intact) so the caller
// can regex-match against real tokens. Internal walk uses a
// comment-stripped, string-aware copy so comments and string contents
// don't confuse the balance.

export function extractExportedAsyncFunctionBody(
  src: string,
  fnName: string,
): string | null {
  return extractExportedFunctionBodyImpl(src, fnName, { requireAsync: true });
}

// R44(e): General-case variant — accepts `export function`, `export
// async function`, and `export default function`. Use when the
// function you're looking for isn't guaranteed to be async (e.g. the
// synchronous email template renderers in `lib/email/templates.ts`).
// Behavior is otherwise identical to `extractExportedAsyncFunctionBody`:
// comment-stripped, string-aware, regex-aware (via R43(a)) brace walk,
// returns the ORIGINAL source span so downstream regex sees real tokens.
export function extractExportedFunctionBody(
  src: string,
  fnName: string,
): string | null {
  return extractExportedFunctionBodyImpl(src, fnName, { requireAsync: false });
}

function extractExportedFunctionBodyImpl(
  src: string,
  fnName: string,
  opts: { requireAsync: boolean },
): string | null {
  const stripped = stripCommentsPreservingPositions(src);
  const asyncPart = opts.requireAsync ? 'async\\s+' : '(?:async\\s+)?';
  const headerRe = new RegExp(
    `export\\s+${asyncPart}function\\s+${escapeRegex(fnName)}\\s*\\(`,
  );
  const m = headerRe.exec(stripped);
  if (!m) return null;
  const openParenIdx = m.index + m[0].length - 1;
  let depth = 1;
  let i = openParenIdx + 1;
  for (; i < stripped.length && depth > 0; i++) {
    const ch = stripped[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  if (depth !== 0) return null;
  // Advance to the function body's opening `{`.
  let j = i;
  while (j < stripped.length && stripped[j] !== '{') j++;
  if (stripped[j] !== '{') return null;
  // Balanced-brace walk with FULL string/template/substitution
  // awareness (R45(a)). A nested template literal inside the body
  // (common in email renderers) no longer derails the brace count:
  // braces inside a string / template body don't change depth, and
  // `${...}` substitution braces are tracked separately via a state
  // stack — so the outer `}` that closes the exported function is
  // identified unambiguously.
  let bdepth = 1;
  let k = j + 1;
  const bstack: WalkerFrame[] = [{ kind: 'file' }];
  // Precompute chars array once for canStartRegex / skipRegexLiteral
  // (R46(c)). Both helpers expect string[] for indexed access.
  const strippedChars = stripped.split('');
  for (; k < stripped.length && bdepth > 0; k++) {
    const top = bstack[bstack.length - 1];
    const ch = stripped[k];

    if (top.kind === 'string') {
      if (ch === top.quote && !isEscaped(stripped, k)) bstack.pop();
      continue;
    }
    if (top.kind === 'template') {
      if (ch === '`' && !isEscaped(stripped, k)) {
        bstack.pop();
        continue;
      }
      if (ch === '$' && stripped[k + 1] === '{' && !isEscaped(stripped, k)) {
        bstack.push({ kind: 'sub', braceDepth: 0 });
        k += 1; // consume `$`; loop will advance past `{`
        continue;
      }
      continue;
    }

    // Code frame — either 'file' or 'sub'.
    if (top.kind === 'sub') {
      if (ch === '{') {
        top.braceDepth++;
        continue;
      }
      if (ch === '}') {
        if (top.braceDepth === 0) {
          bstack.pop();
          continue;
        }
        top.braceDepth--;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      bstack.push({ kind: 'string', quote: ch });
      continue;
    }
    if (ch === '`') {
      bstack.push({ kind: 'template' });
      continue;
    }
    // R46(c) — Regex-literal awareness in the brace-walker.
    //
    // R43(a) added regex-literal awareness to
    // `stripCommentsPreservingPositions` so a regex like `/'/g`
    // wouldn't be misread as opening a single-quoted string. That
    // fix was NEVER propagated to this brace-walker, which walks
    // `stripped` (the comment-stripped source) directly. Result:
    // an exported function body containing both a regex-with-
    // apostrophe AND a nested template literal would still derail
    // the walker (the apostrophe inside `/'/g` opened a fake string,
    // which then consumed everything up to the next real apostrophe
    // — typically inside the nested template — and the brace count
    // got wrong).
    //
    // Templates.ts didn't trip this because `replace(/'/g, ...)`
    // lives in the (un-exported) `escapeHtml` helper, NOT in the
    // exported renderer bodies that the brace-walker visits. R46(c)
    // surfaced the blind spot via a synthetic combined-fixture test;
    // see `source-walker.test.ts` for the regression lock.
    //
    // We only check for regex when in a code frame — inside string/
    // template bodies, `/` is just a character. The check is the
    // same precision-over-recall preceding-token heuristic from
    // `canStartRegex`; if it returns false (rare division case), the
    // walker falls through to the `i++` default.
    if (ch === '/' && canStartRegex(strippedChars, k)) {
      const after = skipRegexLiteral(strippedChars, k);
      if (after > k + 1) {
        // skipRegexLiteral returned start+1 to bail (e.g. unterminated
        // or newline). Otherwise it returned the index AFTER the
        // closing slash + flags. Advance k accordingly.
        k = after - 1; // -1 because the for-loop increments k++
        continue;
      }
    }
    if (ch === '{') bdepth++;
    else if (ch === '}') bdepth--;
  }
  if (bdepth !== 0) return null;
  // Return the ORIGINAL source between the header and the matching
  // closing `}`.
  return src.slice(m.index, k);
}

// ── 4. Regex-based strip (comments + single/double-quoted strings) ──
//
// R42(c) — lifted from `lib/actions/intake-read-path-drift.test.ts`
// which was the FOURTH use-site of this pattern (R38→R39→R41→R42).
// Different from (2) `stripCommentsAndStringsPreservingPositions`:
//
//   • This is REGEX-BASED (one pass per rule). Faster for short audit
//     loops that don't need position preservation.
//   • It INTENTIONALLY LEAVES TEMPLATE LITERALS INTACT — so a real
//     `${intake.<key>}` substitution inside a template string is
//     still visible to downstream regex walkers. The two char-based
//     helpers above strip template bodies too.
//   • String bodies are REPLACED (not blanked) — `''`/`""` remain as
//     empty-string literal tokens. Positions are NOT preserved.
//
// ── JS string grammar anchoring (why `\n` sits in the negated class) ─
// JS string literals cannot contain an unescaped newline — an
// unescaped newline is a syntax error. Anchoring the negated
// character class with `\n` matches the spec exactly:
//
//   '(\\.|[^'\\\n])*'      — closing `'` is on the same line.
//   "(\\.|[^"\\\n])*"      — closing `"` is on the same line.
//
// The old pattern `[^'\\]` matched across newlines, so an apostrophe
// inside an UNSTRIPPED template literal (e.g. `can't be paid for.`)
// opened a fake single-quoted string that extended to the next `'`
// much further down the file, erasing real `intake.<key>` reads in
// between. This was a real bug — 3 defects found in a single
// intake-read-path-drift.test.ts run (R41(a)).
//
// Line-comments must be stripped BEFORE block-comments so a line like
// `// foo /* bar` can't trick the block-comment regex into swallowing
// half the file.

export function stripCommentsAndStringLiteralsRegex(src: string): string {
  let out = src.replace(/\/\/[^\n]*/g, ' ');
  out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out.replace(/"(\\.|[^"\\\n])*"/g, '""');
  out = out.replace(/'(\\.|[^'\\\n])*'/g, "''");
  return out;
}

// Strip just line+block comments — keep ALL string/template literals
// intact. Useful when the caller wants to detect `intake['key']`
// bracket patterns where the key is itself a string literal.
export function stripCommentsOnlyRegex(src: string): string {
  return src.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// ── 5. Parse Zod object fields from a schema source ─────────────────
//
// R42(c) — lifted from `intake-read-path-drift.test.ts`. Walks a Zod
// schema source file and returns the set of field names declared in
// `z.object({...})` bodies. Two distinct patterns are recognized:
//
//   Pattern A — direct zod primitive:
//     `<key>: z.<...>`                 e.g. `email: z.string()`
//     `<key>: z\n   .string()`         multi-line chain (whitespace
//                                       between `z` and `.` allowed —
//                                       this is the R41(a) fix)
//
//   Pattern B — identifier reference to a sibling schema:
//     `<key>: <UpperCamelSchema>`      e.g. `state: UsStateSchema`
//
// The `z\s*\.` variant is critical — without it, multi-line chains
// like `additional_notes: z\n    .string()` silently go missing and
// downstream audits pass while the READ-path drift lives on.

export function parseZodObjectFields(src: string): Set<string> {
  const fields = new Set<string>();
  // Pattern A: `<key>: z.<...>` — whitespace tolerant between `z` and `.`.
  const zRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*z\s*\./g;
  let m: RegExpExecArray | null;
  while ((m = zRe.exec(src)) !== null) {
    fields.add(m[1]);
  }
  // Pattern B: `<key>: <UpperCamelSchema>` — shared zod primitives.
  const refRe = /\b([a-z][a-zA-Z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_]*Schema)\b/g;
  while ((m = refRe.exec(src)) !== null) {
    fields.add(m[1]);
  }
  return fields;
}

// ── Shared internals ────────────────────────────────────────────────

function isEscaped(chars: string[] | string, i: number): boolean {
  // True iff the character at index `i` is escaped by an ODD number
  // of preceding backslashes.
  let bs = 0;
  let b = i - 1;
  while (b >= 0 && chars[b] === '\\') {
    bs++;
    b--;
  }
  return bs % 2 === 1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Regex-literal helpers (R43(a)) ──────────────────────────────────
//
// Deciding whether a `/` starts a regex literal vs. a division
// operator requires context — JS has no grammar-free disambiguator.
// `canStartRegex` inspects the last non-whitespace character before
// `/`. If that character is punctuation or a keyword that cannot be
// followed by division (e.g. `(`, `,`, `=`, `return`, `typeof`),
// treat the `/` as a regex opener. Otherwise treat as division.
//
// Precision over recall: if this returns FALSE for a real regex,
// the walker falls through to the `i++` default case — i.e. the
// regex body is treated as normal code, and the old blind spot
// returns. So the allowed-preceding list errs on the side of
// accepting regex. The known edge case is post-increment
// (`x++ / re /`) — vanishingly rare in this codebase.

const REGEX_PRECEDING_PUNCT = new Set<string>([
  '(', '[', '{', ',', ';', ':', '!', '&', '|', '?', '+', '-', '*', '%',
  '<', '>', '=', '~', '^',
]);

const REGEX_PRECEDING_KEYWORDS = new Set<string>([
  'return', 'typeof', 'instanceof', 'new', 'void', 'delete', 'throw',
  'in', 'of', 'await', 'yield', 'do', 'else', 'case',
]);

function canStartRegex(chars: string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /[ \t\n\r]/.test(chars[j])) j--;
  if (j < 0) return true; // start of file
  const prev = chars[j];
  if (REGEX_PRECEDING_PUNCT.has(prev)) return true;
  if (/[A-Za-z_$]/.test(prev)) {
    // Walk back through identifier/keyword chars.
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(chars[k])) k--;
    const word = chars.slice(k + 1, j + 1).join('');
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  return false;
}

// Advance past a regex literal that begins at position `i` (the `/`
// character). Handles escape sequences (`\/`, `\\`) and character
// classes (`[/]` — `/` inside `[...]` does NOT close the regex).
// Stops at a newline as a safety valve — JS regex literals cannot
// span lines, so a newline mid-regex indicates our regex-detection
// was wrong (division, or a malformed file) and we should bail out
// without having mutated any characters.
function skipRegexLiteral(chars: string[], start: number): number {
  let i = start + 1; // past opening `/`
  let inClass = false;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\n') {
      // Regex can't span newlines. Back out: treat the original `/`
      // as a lone char and continue the outer walk one char ahead.
      return start + 1;
    }
    if (c === '\\' && i + 1 < chars.length) {
      i += 2;
      continue;
    }
    if (!inClass && c === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (inClass && c === ']') {
      inClass = false;
      i++;
      continue;
    }
    if (!inClass && c === '/') {
      i++;
      // Skip regex flags (g, i, m, s, u, y, d).
      while (i < chars.length && /[a-z]/i.test(chars[i])) i++;
      return i;
    }
    i++;
  }
  // Unterminated regex — bail the same way as the newline case.
  return start + 1;
}
