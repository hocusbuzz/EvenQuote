// R35 cross-module Reason-type allow-list audit.
//
// Several lib/ modules export a typed `XxxReason` union of string
// literals that constrain the value of the `reason:` Sentry tag at
// every capture site. Examples (R34 close, ~9 distinct types):
//
//   • lib/email/resend.ts            ResendReason
//   • lib/actions/checkout.ts        CheckoutReason
//   • lib/actions/admin.ts           AdminReason
//   • lib/actions/intake.ts          IntakeReason (vertical:'moving')
//   • lib/actions/cleaning-intake.ts IntakeReason (vertical:'cleaning')
//   • lib/actions/post-payment.ts    PostPaymentReason
//   • lib/calls/select-vapi-number.ts PickVapiNumberReason
//   • lib/cron/retry-failed-calls.ts CronRetryReason
//   • lib/cron/send-reports.ts       CronSendReportsReason
//
// The R32/R33/R34 capture-shape audits already lock that every
// captureException call carries a `reason:` tag and that the tag
// values are not PII. They do NOT lock that:
//
//   (1) Every declared union member is actually USED as a reason
//       value somewhere in the module ("ghost reason values" — type
//       widened past usage, leaving a stale member). A ghost member
//       silently signals "this site exists" to a future maintainer
//       reading the type; if no capture call actually emits it, the
//       ghost is misinformation that would fool a Sentry alert-rule
//       writer into expecting an event class that never fires.
//
//   (2) Every used reason value (string-literal `reason: 'x'` in a
//       capture site or a `tagsFor('x')` call within the same file)
//       is declared in the module's exported Reason union ("ad-hoc
//       reason values" — capture site drifted past the type,
//       producing a tag value that will surface in Sentry but won't
//       be discoverable from the type). An ad-hoc value typically
//       lands in production via a copy-paste typo or a partial-
//       refactor.
//
// This file enforces both invariants by:
//   • Discovering every `export type XxxReason = '...' | '...' ;`
//     declaration in lib/ (excluding test files).
//   • Parsing the union members.
//   • Grepping the SAME source file for `reason: 'literal'` and
//     `tagsFor('literal')` patterns (the two canonical use shapes
//     in this codebase per R32 + R34 memos).
//   • Asserting set-equality between declared and used literals
//     within each file.
//
// Cross-file callers of these reason values exist (e.g.
// `tagsFor('sendApiErrored')` in resend.ts, called from inside the
// same file). We deliberately keep the audit per-file: each module
// owns its own Reason type, and cross-file usage is by-type
// (ResendReason exported, imported, but never re-tagged with new
// string values from outside).
//
// If you need to break the invariant — e.g. a Reason member is
// declared but only emitted via a switch statement that's about to
// land in a follow-up PR — add it to ALLOWED_GHOST_MEMBERS below
// with a comment justifying the temporary exemption.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Knobs ────────────────────────────────────────────────────────────
// Members declared but not yet emitted at any capture site. Add an
// entry here ONLY when the upcoming capture site is in a tracked
// follow-up PR. Format: `'fileRelative:MemberLiteral'`. Empty by
// default — every declared member must be wired today.
const ALLOWED_GHOST_MEMBERS = new Set<string>();

// Reason values legitimately emitted at a capture site that are NOT
// declared in any exported Reason type — i.e. captured but ad-hoc.
// Empty by default. If you need to add an entry, you should almost
// certainly be widening the Reason union instead.
const ALLOWED_AD_HOC_MEMBERS = new Set<string>();

// ── File walker ──────────────────────────────────────────────────────
const LIB_DIR = path.resolve(__dirname);

function collectLibFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

const libFiles = collectLibFiles(LIB_DIR);

// ── Type-declaration parser ──────────────────────────────────────────
// Find `export type XxxReason =\s*'a' | 'b' | 'c';` (possibly multi-
// line). We accept up to ~20 union members per type — pathological,
// but cheap to scan.
type ReasonDecl = {
  file: string;
  typeName: string;
  members: string[];
  declStart: number;
  declEnd: number;
};

function parseReasonDecls(file: string, source: string): ReasonDecl[] {
  // Strip block + line comments before scanning the declaration
  // header — the comment block may contain `export type` text.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, (m) => ' '.repeat(m.length));

  const out: ReasonDecl[] = [];
  // Match `export type <Name>Reason = ...;` allowing newlines inside the body.
  const re = /export\s+type\s+([A-Za-z_$][\w$]*Reason)\s*=([^;]*);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const typeName = m[1];
    const body = m[2];
    // Pull all single-quoted string literals out of the body.
    const litRe = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
    const members: string[] = [];
    let lm: RegExpExecArray | null;
    while ((lm = litRe.exec(body)) !== null) {
      members.push(lm[1]);
    }
    if (members.length === 0) continue; // not a literal-union type
    out.push({
      file,
      typeName,
      members,
      declStart: m.index,
      declEnd: m.index + m[0].length,
    });
  }
  return out;
}

// ── Capture-site reason-value extractor ──────────────────────────────
// Every place in a file where a `reason:` Sentry tag value is emitted
// as a string literal. The `reason:` key appears in many non-Sentry
// contexts (Stripe refund-create params, ProcessingRequest result
// objects, simulation-mode return values), so the extraction is
// scoped to:
//   (1) `reason:` literals INSIDE the argument list of a
//       `captureException(...)` call (balanced-paren walked).
//   (2) `tagsFor('literal')` helper calls. The R32 spread/helper memo
//       documents this as the canonical shape when a file factors
//       its tag construction (e.g. lib/email/resend.ts).
// Everything else — `reason:` keys on result objects, on Stripe API
// params, etc. — is correctly excluded.
function extractCaptureExceptionCallBodies(source: string): string[] {
  // Reuses the balanced-paren walker pattern from
  // lib/lib-capture-sites.test.ts (R34), pared down for this audit.
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

function extractUsedReasonLiterals(source: string): string[] {
  // Strip block comments before scanning the captureException bodies
  // — an inline `/* reason: 'x' */` comment inside a call would
  // otherwise false-positive.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

  const out: string[] = [];

  // Pattern 1: `reason: 'literal'` INSIDE a captureException(...) call
  // body. The capture call body is the argument list including any
  // nested ctx object — `reason:` keys here go straight into Sentry
  // tags, which is exactly what we want to lock against the declared
  // Reason union.
  for (const body of extractCaptureExceptionCallBodies(stripped)) {
    const inlineRe = /\breason\s*:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(body)) !== null) {
      out.push(m[1]);
    }
  }

  // Pattern 2: `tagsFor('literal')` helper calls (anywhere in the
  // file). The helper is itself a Reason → tag-bag builder; if a
  // file uses tagsFor() at all, every literal arg is a Reason-typed
  // value by construction.
  const helperRe = /\btagsFor\s*\(\s*'([^'\\]*(?:\\.[^'\\]*)*)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = helperRe.exec(stripped)) !== null) {
    out.push(m[1]);
  }

  return out;
}

// ── Pre-compute ──────────────────────────────────────────────────────
// One pass over lib/ — index of all reason declarations + the used-
// literal set per file containing one.
type FileAnalysis = {
  file: string;
  decls: ReasonDecl[];
  usedReasonLiterals: Set<string>;
};

const analyses: FileAnalysis[] = [];
for (const file of libFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const decls = parseReasonDecls(file, source);
  if (decls.length === 0) continue;
  const used = new Set(extractUsedReasonLiterals(source));
  analyses.push({ file, decls, usedReasonLiterals: used });
}

// ── Tests ────────────────────────────────────────────────────────────
describe('lib/ Reason-type ↔ capture-site allow-list audit (R35)', () => {
  it('discovers at least 7 exported XxxReason types across lib/', () => {
    // Sanity check on the parser. R34 close count: 9 distinct exports
    // across 9 files (intake.ts and cleaning-intake.ts both export
    // `IntakeReason`, distinct file-local declarations). We assert a
    // floor of 7 so a future consolidation that legitimately drops a
    // few types doesn't false-positive — but a parser regression that
    // suddenly finds zero will still trip.
    expect(analyses.length).toBeGreaterThanOrEqual(7);
  });

  it('every declared Reason union member is emitted at a capture site in the same file (no ghost members)', () => {
    const violations: string[] = [];
    for (const { file, decls, usedReasonLiterals } of analyses) {
      const rel = path.relative(LIB_DIR, file);
      for (const decl of decls) {
        for (const member of decl.members) {
          if (usedReasonLiterals.has(member)) continue;
          if (ALLOWED_GHOST_MEMBERS.has(`${rel}:${member}`)) continue;
          violations.push(
            `${rel}: ${decl.typeName} declares '${member}' but no capture site emits it`,
          );
        }
      }
    }
    expect(
      violations,
      `ghost Reason members detected:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every emitted reason literal is declared in the file\'s Reason union (no ad-hoc values)', () => {
    const violations: string[] = [];
    for (const { file, decls, usedReasonLiterals } of analyses) {
      const rel = path.relative(LIB_DIR, file);
      const declared = new Set<string>();
      for (const decl of decls) for (const m of decl.members) declared.add(m);
      for (const used of usedReasonLiterals) {
        if (declared.has(used)) continue;
        if (ALLOWED_AD_HOC_MEMBERS.has(`${rel}:${used}`)) continue;
        violations.push(
          `${rel}: capture site emits reason: '${used}' but it's not in any declared Reason union in this file`,
        );
      }
    }
    expect(
      violations,
      `ad-hoc reason values detected:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every Reason union has at least one member (no empty-union accidents)', () => {
    // Defends against a refactor that drops the only member but
    // leaves the `export type XxxReason = ;` shell behind. The
    // parser would skip such a declaration (members.length===0), so
    // re-derive the count from grep over the raw source.
    const violations: string[] = [];
    for (const { file } of analyses) {
      const source = fs.readFileSync(file, 'utf8');
      const headers = source.match(/export\s+type\s+[A-Za-z_$][\w$]*Reason\s*=/g) ?? [];
      // Re-walk and count parsed members — must be ≥ headers count.
      const decls = parseReasonDecls(file, source);
      if (decls.length < headers.length) {
        violations.push(
          `${path.relative(LIB_DIR, file)}: ${
            headers.length - decls.length
          } empty Reason union(s) — declaration without literal members`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('every Reason union member is unique within its declaration (no duplicate literals)', () => {
    // A typo like `'sendFailed' | 'sendFailed' | 'finalStampFailed'`
    // would compile fine and pass the ghost/ad-hoc audits but
    // signals a copy-paste error in the type. Fail loudly.
    const violations: string[] = [];
    for (const { file, decls } of analyses) {
      const rel = path.relative(LIB_DIR, file);
      for (const decl of decls) {
        const seen = new Set<string>();
        for (const m of decl.members) {
          if (seen.has(m)) {
            violations.push(`${rel}: ${decl.typeName} declares '${m}' more than once`);
          }
          seen.add(m);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('Reason union member casing is camelCase (drift guard against snake_case / kebab-case)', () => {
    // The audited lib modules all use camelCase for reason values
    // (sendApiErrored, archiveUpdateFailed, etc.) — Sentry tag values
    // sort and group cleanly when the casing is consistent. A new
    // member added with snake_case ('send_api_errored') or kebab-case
    // ('send-api-errored') would not be caught by the ghost/ad-hoc
    // audits but would silently fragment Sentry alerts.
    const violations: string[] = [];
    for (const { file, decls } of analyses) {
      const rel = path.relative(LIB_DIR, file);
      for (const decl of decls) {
        for (const m of decl.members) {
          // Allow camelCase: starts lower, alphanumeric only.
          if (!/^[a-z][A-Za-z0-9]*$/.test(m)) {
            violations.push(
              `${rel}: ${decl.typeName} member '${m}' violates camelCase`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the ALLOWED_GHOST_MEMBERS allow-list is empty in steady state (drift guard)', () => {
    // Tripwire: if this list grows past zero, a future cleanup pass
    // should evaluate whether the ghost members can be removed
    // outright. Steady-state should always be empty; the entry is a
    // temporary exemption tied to a follow-up PR. We allow the
    // failure to land but flag it visibly so it's never forgotten.
    expect(
      ALLOWED_GHOST_MEMBERS.size,
      `ALLOWED_GHOST_MEMBERS should be empty in steady state — current entries: ${[...ALLOWED_GHOST_MEMBERS].join(', ')}`,
    ).toBe(0);
  });

  it('the ALLOWED_AD_HOC_MEMBERS allow-list is empty in steady state (drift guard)', () => {
    // Same pattern as the ghost-members drift guard — ad-hoc reason
    // values almost always indicate the Reason union should be
    // widened instead. If the count grows, that's a signal to do
    // type cleanup, not just bury the entry in the allow-list.
    expect(
      ALLOWED_AD_HOC_MEMBERS.size,
      `ALLOWED_AD_HOC_MEMBERS should be empty in steady state — current entries: ${[...ALLOWED_AD_HOC_MEMBERS].join(', ')}`,
    ).toBe(0);
  });

  it('count band: between 7 and 30 declared Reason types across lib/', () => {
    // Count tripwire — catches "10 new Reason types appeared
    // overnight" drift. Current R34 close: 9 file-distinct
    // declarations. Band is generous to allow legitimate growth
    // without retuning every round, but tight enough that a
    // refactor adding 20+ types at once would trip.
    expect(analyses.length).toBeGreaterThanOrEqual(7);
    expect(analyses.length).toBeLessThanOrEqual(30);
  });

  it('every analyzed file contains at least one captureException call (declared Reason types must be wired)', () => {
    // A file that exports a XxxReason type but contains no
    // captureException call is dead infrastructure. Parsed literals
    // would all show up as ghosts (since extractUsedReasonLiterals
    // depends on `reason:` patterns inside capture call args) — but
    // we surface this as its own assertion for a clearer error
    // message.
    const violations: string[] = [];
    for (const { file } of analyses) {
      const source = fs.readFileSync(file, 'utf8');
      // Strip comments before scanning so a documentation block
      // that names captureException doesn't false-positive.
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, ' ');
      if (!/\bcaptureException\s*\(/.test(codeOnly)) {
        violations.push(
          `${path.relative(LIB_DIR, file)}: declares a Reason type but contains no captureException call`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
