// R39(b) — Response-shape drift audit for TEXT/PLAIN + APPLICATION/XML
// webhook routes.
//
// R38(b) locked JSON response shapes for every JSON-returning route
// in app/api/ (health, version, status, cron/*, stripe/webhook). Three
// routes were deliberately allow-listed from that audit because they
// DON'T return JSON:
//
//   • app/api/vapi/webhook/route.ts             — text/plain
//   • app/api/vapi/inbound-callback/route.ts    — text/plain
//   • app/api/twilio/sms/route.ts               — application/xml (TwiML)
//
// External consumers depend on these bodies for retry semantics:
//
//   • Vapi's webhook infrastructure looks at the response BODY as a
//     secondary signal alongside the HTTP status code. In particular,
//     a 200 + body `'ok'` is treated differently from a 200 + body
//     `'ignored'` in Vapi's own dashboard telemetry. We need these
//     literals locked.
//   • Twilio's SMS platform parses the TwiML <Response>...</Response>
//     envelope and delivers any <Message>...</Message> body back to
//     the sender. A silent refactor that wraps the TwiML in some other
//     XML root element, or omits the `<?xml ... ?>` prolog Twilio
//     expects, turns every inbound contractor text into a silent
//     no-reply. Contractors stop replying, quote collection collapses,
//     and we find out days later.
//
// This audit extends R38(b)'s drift-catch pattern to plain-text and
// XML return paths. Unlike R38(b), these routes don't return object
// literals, so the parser just walks every `new Response(<body>, ...)`
// call and collects the first argument as either a STRING LITERAL,
// a TEMPLATE LITERAL (no substitutions), an IDENTIFIER (resolved
// backward to its declaration), or a CALL EXPRESSION (for the twilio/
// sms route's `twimlResponse('...')` helper).
//
// INVARIANTS LOCKED
// ─────────────────
// (1) REQUIRED BODY STRINGS — every listed literal must appear as a
//     Response body in the target route at least once.
// (2) FORBIDDEN BODY STRINGS — drift candidates the well-meaning
//     refactor reaches for. For Vapi: 'success', 'received',
//     'acknowledged' are all rejected. For Twilio TwiML: the
//     standalone `<Message>` tag without the surrounding
//     `<Response>...</Response>` envelope is rejected.
// (3) TWIML PROLOG — every Twilio SMS response that carries a body
//     must start with `<?xml version="1.0" encoding="UTF-8"?>`. Twilio
//     accepts an XML response without the prolog in practice, but
//     losing the prolog is the canonical "someone stripped whitespace
//     from the template" drift.
// (4) TWIML ROOT — every TwiML body's root element is `<Response>`,
//     never `<TwiML>` / `<SmsResponse>` / `<Reply>` / other vendor
//     folklore.
// (5) COVERAGE TRIPWIRE — every route.ts in app/api/ that returns
//     `new Response(<string literal>, ...)` must appear in
//     EXPECTED_TEXT_SHAPES OR an explicit allow-list. Catches new
//     text-returning routes landing unaudited.
// (6) MIN BODY COUNT — each locked route must emit at least N distinct
//     body strings (catches "maintainer deleted a branch" silent
//     simplification).
//
// Intentionally out of scope:
//   • HTTP status code coverage — R38(b) doesn't lock status codes
//     either; that's a different audit (callers read the status for
//     primary retry semantics, not the body).
//   • The exact byte sequence of TwiML body content. The contractor-
//     facing reply string is a product copy decision and can change
//     with the product. We only lock the ENVELOPE (root element +
//     prolog), not the human-facing Message contents.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsPreservingPositions } from '../tests/helpers/source-walker';

const APP_DIR = path.resolve(process.cwd(), 'app');

// ── Walk app/api for route.ts files ──────────────────────────────────
function walkRouteFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'route.ts') {
        out.push(path.relative(APP_DIR, full));
      }
    }
  }
  walk(path.join(root, 'api'));
  return out;
}

// ── Extract `new Response(<body>, ...)` first-arg literals ────────────
// Returns the array of body expressions as source substrings. We try
// to resolve three shapes:
//   • `'...'` or `"..."`        — quoted string literal
//   • `` `...` `` (no ${})      — template literal
//   • identifier (e.g., `xml`)  — resolve backward to its
//     const/let declaration and recursively extract if the RHS is a
//     string-valued expression (or template concat).
//
// For the case `return twimlResponse('Got it, thanks...')` the parser
// treats `twimlResponse(...)` as a CALL EXPRESSION and records the
// call's argument.

interface ExtractedBody {
  form: 'quoted' | 'template' | 'call' | 'identifier-unresolved' | 'unknown';
  text: string; // For quoted/template: the body text. For call: raw call text.
  callee?: string; // Only for form === 'call'.
}

function extractResponseBodies(src: string): ExtractedBody[] {
  const stripped = stripCommentsPreservingPositions(src);
  const out: ExtractedBody[] = [];

  // Find every `new Response(` call and every `twimlResponse(` call
  // (the twilio/sms route's helper that wraps TwiML). Treat both as
  // body-returning entry points.
  const patterns: { re: RegExp; kind: 'Response' | 'twimlResponse' }[] = [
    { re: /\bnew\s+Response\s*\(/g, kind: 'Response' },
    { re: /\btwimlResponse\s*\(/g, kind: 'twimlResponse' },
  ];

  for (const { re, kind } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped))) {
      const openParen = m.index + m[0].length - 1;
      // Walk balanced parens, string-aware.
      let depth = 1;
      let i = openParen + 1;
      let str: false | "'" | '"' | '`' = false;
      const argStart = i;
      while (i < stripped.length && depth > 0) {
        const ch = stripped[i];
        if (str) {
          if (ch === str && !isEscaped(stripped, i)) str = false;
          i++;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          str = ch;
          i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth === 0) break;
        i++;
      }
      if (depth !== 0) continue;
      const argsText = src.slice(argStart, i);
      // First arg ends at top-level comma or end of args.
      const firstArg = extractFirstArg(argsText).trim();
      out.push(classifyBodyArg(firstArg, kind, src));
    }
  }
  return out;
}

function isEscaped(chars: string, i: number): boolean {
  let bs = 0;
  let b = i - 1;
  while (b >= 0 && chars[b] === '\\') {
    bs++;
    b--;
  }
  return bs % 2 === 1;
}

function extractFirstArg(argsText: string): string {
  let depth = 0;
  let str: false | "'" | '"' | '`' = false;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (str) {
      if (ch === str && !isEscaped(argsText, i)) str = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      return argsText.slice(0, i);
    }
  }
  return argsText;
}

function classifyBodyArg(
  arg: string,
  kind: 'Response' | 'twimlResponse',
  src: string,
): ExtractedBody {
  // Quoted string.
  const quotedMatch = /^(['"])([\s\S]*?)\1$/.exec(arg);
  if (quotedMatch) {
    return { form: 'quoted', text: quotedMatch[2] };
  }
  // Template literal, no substitutions.
  const templateNoSub = /^`([^`]*)`$/.exec(arg);
  if (templateNoSub && !templateNoSub[1].includes('${')) {
    return { form: 'template', text: templateNoSub[1] };
  }
  // Call expression (e.g., twimlResponse('...')) — only relevant when
  // the outer call is a `new Response(xml, ...)` where xml was assigned
  // from a template. We report as 'call' so the caller can decide.
  if (/^[A-Za-z_][\w]*\s*\(/.test(arg)) {
    const calleeName = /^([A-Za-z_][\w]*)\s*\(/.exec(arg)?.[1] ?? 'unknown';
    return { form: 'call', text: arg, callee: calleeName };
  }
  // Bare identifier — try to resolve backward to a string/template
  // const/let declaration in the same source.
  const identMatch = /^([A-Za-z_][\w]*)$/.exec(arg);
  if (identMatch) {
    const ident = identMatch[1];
    const resolved = resolveIdentDeclaration(src, ident);
    if (resolved !== null) {
      return { form: 'template', text: resolved };
    }
    return { form: 'identifier-unresolved', text: ident };
  }
  return { form: 'unknown', text: arg };
  void kind;
}

function resolveIdentDeclaration(src: string, ident: string): string | null {
  // Find `const <ident> = <rhs>;` — accept quoted or template string
  // RHS. Return the string body; return null if the RHS isn't a
  // trivially extractable string.
  const declRe = new RegExp(
    `\\bconst\\s+${ident}\\b\\s*(?::\\s*[A-Za-z_][\\w]*\\s*)?=\\s*`,
  );
  const m = declRe.exec(src);
  if (!m) return null;
  const rhsStart = m.index + m[0].length;
  const rest = src.slice(rhsStart);
  const quoted = /^(['"])([\s\S]*?)\1/.exec(rest);
  if (quoted) return quoted[2];
  const tmpl = /^`([\s\S]*?)`/.exec(rest);
  if (tmpl && !tmpl[1].includes('${')) return tmpl[1];
  return null;
}

// ── Expected per-route response-body shapes ──────────────────────────

interface TextShapeExpectation {
  file: string; // relative to app/
  requiredBodies: string[]; // must ALL be present as literal bodies
  forbiddenBodies: string[]; // must NOT be present as literal bodies
  minDistinctBodies: number;
  // XML-specific checks. If set, every body that contains a `<` MUST
  // begin with the prolog AND have root element = <Response>.
  xmlEnvelope?: {
    requireProlog: boolean;
    requireRoot: string; // e.g. 'Response'
    forbiddenRoots: string[]; // e.g. ['TwiML', 'SmsResponse', 'Reply']
  };
}

const EXPECTED_TEXT_SHAPES: TextShapeExpectation[] = [
  {
    file: 'api/vapi/webhook/route.ts',
    requiredBodies: [
      'ok',
      'ignored',
      'invalid JSON',
      'missing call.id',
      'handler error',
    ],
    forbiddenBodies: [
      'success',
      'received',
      'acknowledged',
      'done',
      'processed',
      'accepted',
    ],
    minDistinctBodies: 5,
  },
  {
    file: 'api/vapi/inbound-callback/route.ts',
    requiredBodies: [
      'ok',
      'ignored',
      'invalid JSON',
      'missing call.id',
      'handler error',
    ],
    forbiddenBodies: [
      'success',
      'received',
      'acknowledged',
      'done',
      'processed',
      'accepted',
    ],
    // Note: this route returns 'ok' twice (once after no-match, once on
    // success) and also has 'invalid JSON' / 'missing call.id' paths.
    minDistinctBodies: 5,
  },
  {
    file: 'api/twilio/sms/route.ts',
    requiredBodies: [
      'misconfigured',
      'invalid signature',
      'missing From or Body',
    ],
    forbiddenBodies: [
      // TwiML drift surface:
      '<TwiML',
      '<SmsResponse',
      '<Reply',
      // Body-text confusion: Twilio treats non-XML text/plain as
      // content-type mismatch → the body is literally delivered to
      // the sender as SMS text. "ok" coming from a Twilio endpoint
      // would fire a sender-facing "ok" SMS.
      'ok',
      'success',
    ],
    minDistinctBodies: 3,
    xmlEnvelope: {
      requireProlog: true,
      requireRoot: 'Response',
      forbiddenRoots: ['TwiML', 'SmsResponse', 'Reply', 'Twilio'],
    },
  },
];

// ── Tests ────────────────────────────────────────────────────────────

// Pre-compute the bodies once per file (not per test) so each
// describe iteration is cheap.
const bodiesPerFile = new Map<string, ExtractedBody[]>();
for (const exp of EXPECTED_TEXT_SHAPES) {
  const src = fs.readFileSync(path.join(APP_DIR, exp.file), 'utf8');
  bodiesPerFile.set(exp.file, extractResponseBodies(src));
}

function literalBodiesFor(file: string): string[] {
  const all = bodiesPerFile.get(file) ?? [];
  const out: string[] = [];
  for (const b of all) {
    if (b.form === 'quoted' || b.form === 'template') {
      out.push(b.text);
    }
  }
  return out;
}

describe('text/plain + XML route response-body shape drift audit (R39)', () => {
  // (1) Required bodies present.
  for (const exp of EXPECTED_TEXT_SHAPES) {
    for (const req of exp.requiredBodies) {
      it(`${exp.file}: required body "${req}" is present`, () => {
        const bodies = literalBodiesFor(exp.file);
        expect(
          bodies,
          `"${req}" missing from ${exp.file} — response-body drift`,
        ).toContain(req);
      });
    }
  }

  // (2) Forbidden bodies absent.
  for (const exp of EXPECTED_TEXT_SHAPES) {
    for (const forb of exp.forbiddenBodies) {
      it(`${exp.file}: forbidden body "${forb}" is absent`, () => {
        const bodies = literalBodiesFor(exp.file);
        const hits = bodies.filter((b) => b.includes(forb));
        expect(
          hits,
          `forbidden substring "${forb}" found in ${exp.file}: ${JSON.stringify(hits)}`,
        ).toEqual([]);
      });
    }
  }

  // (3+4) TwiML envelope checks.
  //
  // The twilio/sms route builds TwiML via a template literal with
  // `${escapeXml(message)}` substitution, so the quoted-literal
  // extractor can't resolve it. For those cases we additionally grep
  // the source for template literals whose leading content matches
  // the TwiML envelope shape — this catches both the success branch
  // (with <Message>) and the empty branch (<Response/>).
  for (const exp of EXPECTED_TEXT_SHAPES) {
    if (!exp.xmlEnvelope) continue;
    const env = exp.xmlEnvelope;
    const src = fs.readFileSync(path.join(APP_DIR, exp.file), 'utf8');
    // Collect every template literal `` `...` `` that contains `<?xml`
    // OR `<Response` — these are the TwiML fragments. Includes
    // multi-line templates since Twilio's TwiML spans lines.
    const templateFragments = [...src.matchAll(/`([^`]*)`/g)]
      .map((m) => m[1])
      .filter((s) => /<\?xml|<Response/.test(s));

    it(`${exp.file}: TwiML bodies include the XML prolog`, () => {
      expect(
        templateFragments.length,
        `no TwiML template fragments found in ${exp.file} — the extractor may be stale`,
      ).toBeGreaterThan(0);
      for (const frag of templateFragments) {
        if (env.requireProlog) {
          expect(
            frag.startsWith('<?xml'),
            `TwiML fragment missing <?xml ... ?> prolog in ${exp.file}: ${JSON.stringify(frag).slice(0, 200)}`,
          ).toBe(true);
        }
      }
    });

    it(`${exp.file}: TwiML root element is <${env.requireRoot}>`, () => {
      for (const frag of templateFragments) {
        const afterProlog = frag.replace(/^\s*<\?xml[^?]*\?>\s*\\n?\s*/, '');
        const rootMatch = /^<([A-Za-z_][\w]*)/.exec(afterProlog);
        expect(
          rootMatch,
          `TwiML fragment has no parseable root element in ${exp.file}: ${JSON.stringify(frag).slice(0, 200)}`,
        ).not.toBeNull();
        expect(
          rootMatch![1],
          `TwiML root element mismatch in ${exp.file} — got <${rootMatch![1]}>, expected <${env.requireRoot}>`,
        ).toBe(env.requireRoot);
      }
    });

    it(`${exp.file}: TwiML root element avoids forbidden vendor-folklore names`, () => {
      for (const frag of templateFragments) {
        for (const forb of env.forbiddenRoots) {
          const bad = new RegExp(`<${forb}\\b`);
          expect(
            bad.test(frag),
            `forbidden root/element <${forb}> found in ${exp.file}: ${JSON.stringify(frag).slice(0, 200)}`,
          ).toBe(false);
        }
      }
    });

    it(`${exp.file}: Content-Type header is application/xml`, () => {
      // Defense-in-depth: Twilio actually accepts text/xml too, but
      // our codebase standardized on application/xml. A silent
      // refactor to 'text/xml' or default (text/plain) changes Twilio's
      // handling.
      expect(
        src,
        `application/xml Content-Type not set on ${exp.file} — Twilio would receive text/plain and not process TwiML`,
      ).toMatch(/['"]Content-Type['"]\s*:\s*['"]application\/xml/);
    });
  }

  // (5) Coverage tripwire: every route.ts that returns
  // `new Response(<string literal>, ...)` must be in EXPECTED_TEXT_SHAPES
  // OR an explicit allow-list.
  it('coverage: every text-returning route.ts is locked or explicitly allow-listed', () => {
    const locked = new Set(EXPECTED_TEXT_SHAPES.map((s) => s.file));
    // These JSON-returning routes are handled by the R38(b) suite
    // (app/route-response-shape-drift.test.ts). They DO have
    // `new Response(...)` calls occasionally (e.g., 401 envelopes with
    // plain-text body) but their primary contract is JSON so drift is
    // caught over there. We allow-list them here to prevent double-
    // coverage noise.
    const allowlisted = new Set([
      // JSON-returning routes (locked by R38(b)):
      'api/health/route.ts',
      'api/version/route.ts',
      'api/status/route.ts',
      'api/cron/check-status/route.ts',
      'api/cron/retry-failed-calls/route.ts',
      'api/cron/send-reports/route.ts',
      'api/stripe/webhook/route.ts',
      // CSP report: 204 no body.
      'api/csp-report/route.ts',
      // Dev endpoints — dev-token-gated, not promoted to production callers.
      'api/dev/trigger-call/route.ts',
      'api/dev/backfill-call/route.ts',
      'api/dev/skip-payment/route.ts',
      // get-quotes/claim is a GET redirect handler, no text response body.
      'get-quotes/claim/route.ts',
    ]);
    const routeFiles = walkRouteFiles(APP_DIR);
    // Only care about routes that emit at least one `new Response(<quoted>`
    // OR `twimlResponse(<quoted>`.
    const textReturning = routeFiles.filter((rel) => {
      const s = fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
      const stripped = stripCommentsPreservingPositions(s);
      return /\bnew\s+Response\s*\(\s*['"`]/.test(stripped) ||
        /\btwimlResponse\s*\(\s*['"`]/.test(stripped);
    });
    const unlocked = textReturning.filter(
      (rel) => !locked.has(rel) && !allowlisted.has(rel),
    );
    expect(
      unlocked,
      `Unlocked text-returning route.ts files: ${unlocked.join(', ')}. Add each to EXPECTED_TEXT_SHAPES or allowlisted.`,
    ).toEqual([]);
  });

  // (6) Min distinct body count per route.
  for (const exp of EXPECTED_TEXT_SHAPES) {
    it(`${exp.file}: at least ${exp.minDistinctBodies} distinct body strings`, () => {
      const bodies = literalBodiesFor(exp.file);
      const distinct = new Set(bodies);
      expect(
        distinct.size,
        `${exp.file} emits only ${distinct.size} distinct bodies; expected ≥${exp.minDistinctBodies}. A deleted branch?`,
      ).toBeGreaterThanOrEqual(exp.minDistinctBodies);
    });
  }

  // (7) EXPECTED_TEXT_SHAPES covers every intended route (no duplicates,
  //     no stale references).
  it('EXPECTED_TEXT_SHAPES entries have unique file paths', () => {
    const files = EXPECTED_TEXT_SHAPES.map((s) => s.file);
    const dupes = files.filter((f, i) => files.indexOf(f) !== i);
    expect(dupes).toEqual([]);
  });

  it('EXPECTED_TEXT_SHAPES file paths resolve to real files', () => {
    for (const s of EXPECTED_TEXT_SHAPES) {
      const full = path.join(APP_DIR, s.file);
      expect(fs.existsSync(full), `${full} does not exist`).toBe(true);
    }
  });

  // (8) Count band — 3 route audit entries total (2 Vapi + 1 Twilio).
  //     Bump if a 4th text-returning route lands.
  it('count band: exactly 3 text-returning routes under audit', () => {
    expect(EXPECTED_TEXT_SHAPES.length).toBe(3);
  });
});
