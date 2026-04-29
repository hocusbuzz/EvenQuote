// R49(c) — Vapi webhook event-type allow-list drift audit.
//
// Stripe's webhook (R41(c) / R47(c) / R48(c)) is a switch over `event.type`,
// so its audit walks `case '<literal>':` cases. Vapi's webhook is shaped
// differently: it accepts `payload.message.type` and short-circuits on
// anything other than `end-of-call-report`. The route is intentionally
// minimal — Vapi only needs the end-of-call payload, and every other
// message type is acked with a 200 so Vapi stops retrying.
//
// What this audit locks:
//
//   1. The set of handled `msg.type` literals is EXACTLY {end-of-call-report}.
//      A future PR that silently adds `else if (msg.type === 'tool-calls')`
//      and starts processing would land without review pressure today —
//      no other test catches a NEW handled type. This audit fails loudly.
//
//   2. A FORBIDDEN list of Vapi message types we must not start handling
//      without explicit thought. Vapi ships many event families
//      (`function-call`, `assistant-request`, `tool-calls`, `transcript`,
//      `hang`, `speech-update`, `status-update`, `conversation-update`,
//      `user-interrupted`, `voice-input`, `model-output`, `phone-call-control`).
//      Most of these are streaming events fired tens of times per call —
//      handling any of them on a webhook handler is almost certainly a bug.
//      A maintainer must remove the literal from FORBIDDEN here BEFORE
//      shipping a handler for it (a deliberate, reviewable change).
//
//   3. Lexical structure of the route:
//        - `verifyVapiWebhook(req)` is called BEFORE `req.json()` (so a
//          flooder can't burn body-parse cycles against an unauthed request).
//        - `req.json()` is wrapped in try/catch returning 400.
//        - The non-handled branch returns 200 (Vapi will retry on non-2xx).
//        - The handler-error path returns 500 (Vapi MUST retry — we want
//          the redrive when the post-call extraction fails transiently).
//        - `captureException` is invoked on the handler-error branch
//          (the silent-failure case Antonio explicitly flagged in route.ts:
//          "a paid user gets an empty report").
//        - `dynamic = 'force-dynamic'` and `runtime = 'nodejs'` exports.
//
// Scope — this audit is lexical only; behavior is locked by route.test.ts.
// The audits are complementary: route.test.ts asserts what HAPPENS;
// this file asserts the SET OF EVENTS that can possibly cause anything
// to happen and the ORDERING of the early-rejects.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_PATH = path.join(
  process.cwd(),
  'app/api/vapi/webhook/route.ts',
);

// EXPECTED_HANDLED — `msg.type` literals the route is allowed to act on.
// The route processes exactly one type today; the only reason this is a
// Set is to keep the future-extensibility shape mirroring R41(c).
const EXPECTED_HANDLED = new Set<string>([
  'end-of-call-report',
]);

// FORBIDDEN — Vapi message types that MUST NOT trigger a handler.
//
// Vapi documents these in its server-message reference. Every entry is a
// deliberate "do not start handling without thinking" lock:
//
//   • function-call, tool-calls       — assistant tool invocations; would
//                                       require a tool registry & RPC layer
//                                       we have not built. Wrong place to
//                                       handle them.
//   • assistant-request               — request for assistant config, fired
//                                       per call start. Belongs in a
//                                       dedicated config endpoint, not here.
//   • transcript                      — streamed mid-call. Persisting these
//                                       would mean dozens of writes per
//                                       call vs. one at end-of-call.
//   • speech-update                   — VAD events, very high frequency.
//   • status-update                   — call state transitions, very high
//                                       frequency. End-of-call-report is
//                                       the canonical terminal signal.
//   • conversation-update             — message-by-message updates; same
//                                       reasoning as `transcript`.
//   • user-interrupted, voice-input   — UX events, never a webhook concern.
//   • model-output                    — token-stream debugging events.
//   • phone-call-control              — outbound call routing control;
//                                       not a webhook surface.
//   • hang                            — bare disconnect; superseded by
//                                       end-of-call-report which always
//                                       follows.
const FORBIDDEN_MESSAGE_TYPES = new Set<string>([
  'function-call',
  'tool-calls',
  'assistant-request',
  'transcript',
  'speech-update',
  'status-update',
  'conversation-update',
  'user-interrupted',
  'voice-input',
  'model-output',
  'phone-call-control',
  'hang',
]);

// Lock the canonical Vapi message-type shape: lower-kebab-case
// identifier, no leading/trailing dash, no underscores, no dots.
// Mirrors `tests/helpers/rate-limit-prefixes.ts` PREFIX_SHAPE_RE so the
// idiom is consistent across our drift audits.
const VAPI_TYPE_SHAPE_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

describe('vapi webhook event-type allow-list drift (R49(c))', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');

  // Strip ONLY comments — string literals are preserved because the
  // audit needs to find `msg.type === 'end-of-call-report'` and friends.
  function stripCommentsOnly(source: string): string {
    return source
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
  }

  const stripped = stripCommentsOnly(src);

  // Extract every `msg.type === 'X'` and `msg.type !== 'X'` comparison.
  // The route's gating shape today is `if (!msg || msg.type !== 'end-of-call-report')`,
  // so an inverted comparison still pins the literal.
  function extractMsgTypeLiterals(source: string): string[] {
    const re = /msg\.type\s*[!=]==\s*['"]([a-z][a-z0-9-]*)['"]/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
    return out;
  }

  const literals = extractMsgTypeLiterals(stripped);
  const literalsSet = new Set(literals);

  it('extracts at least one msg.type literal from the route source', () => {
    // Parser sanity — if this fails, the regex drifted, not the source.
    expect(literals.length).toBeGreaterThanOrEqual(1);
  });

  it('every msg.type literal is a syntactically valid Vapi type', () => {
    const bad = literals.filter((t) => !VAPI_TYPE_SHAPE_RE.test(t));
    expect(
      bad,
      `msg.type literals with invalid Vapi shape: ${JSON.stringify(bad)}`,
    ).toEqual([]);
  });

  it('handled events: every EXPECTED_HANDLED appears as a msg.type literal', () => {
    const missing = [...EXPECTED_HANDLED].filter((k) => !literalsSet.has(k));
    expect(
      missing,
      `EXPECTED_HANDLED type missing from route source: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it('source contains exactly the EXPECTED_HANDLED set (no drift)', () => {
    const unexpected = [...literalsSet].filter((k) => !EXPECTED_HANDLED.has(k));
    expect(
      unexpected,
      `unexpected msg.type literals — add to EXPECTED_HANDLED or remove from source: ${JSON.stringify(unexpected)}`,
    ).toEqual([]);
  });

  it('no FORBIDDEN message type appears in the route source', () => {
    const present = [...FORBIDDEN_MESSAGE_TYPES].filter((k) => literalsSet.has(k));
    expect(
      present,
      `FORBIDDEN Vapi message types present in source: ${JSON.stringify(present)}. If you genuinely need to handle one, remove it from FORBIDDEN_MESSAGE_TYPES first as a separate, reviewable change.`,
    ).toEqual([]);
  });

  it('FORBIDDEN_MESSAGE_TYPES has no duplicates and no overlap with EXPECTED_HANDLED', () => {
    const arr = [...FORBIDDEN_MESSAGE_TYPES];
    const dupes = arr.filter((k, i) => arr.indexOf(k) !== i);
    expect(dupes, `duplicate FORBIDDEN entries: ${JSON.stringify(dupes)}`).toEqual([]);

    const conflicts = [...EXPECTED_HANDLED].filter((k) =>
      FORBIDDEN_MESSAGE_TYPES.has(k),
    );
    expect(
      conflicts,
      `events listed both HANDLED and FORBIDDEN: ${JSON.stringify(conflicts)}`,
    ).toEqual([]);
  });

  it('every FORBIDDEN entry is a syntactically valid Vapi type', () => {
    // A typo in the FORBIDDEN list would silently match nothing, weakening
    // the audit. Lock the shape so a misspelled entry surfaces here.
    const bad = [...FORBIDDEN_MESSAGE_TYPES].filter(
      (t) => !VAPI_TYPE_SHAPE_RE.test(t),
    );
    expect(
      bad,
      `FORBIDDEN entries with invalid Vapi shape: ${JSON.stringify(bad)}`,
    ).toEqual([]);
  });

  it('FORBIDDEN entries are not mentioned in commented-out msg.type comparisons', () => {
    // Even commented-out comparisons should not exist for a forbidden
    // type — a future PR could uncomment one without reviewing the audit.
    // If you need to document a forbidden type, do it in docs/, not in
    // a `// msg.type === 'X'` comment.
    const re = /msg\.type\s*[!=]==\s*['"]([a-z][a-z0-9-]*)['"]/g;
    const commentedOut: string[] = [];
    for (const line of src.split('\n')) {
      const commentIdx = line.indexOf('//');
      if (commentIdx === -1) continue;
      const commentBody = line.slice(commentIdx);
      const re2 = new RegExp(re.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re2.exec(commentBody)) !== null) {
        if (FORBIDDEN_MESSAGE_TYPES.has(m[1])) commentedOut.push(m[1]);
      }
    }
    expect(
      commentedOut,
      `FORBIDDEN message types appear in commented-out comparisons: ${JSON.stringify(commentedOut)}`,
    ).toEqual([]);
  });

  // ── Source-shape locks ──────────────────────────────────────────────

  it('verifyVapiWebhook is called BEFORE req.json (auth-before-parse ordering)', () => {
    // A flooder must not be able to make us parse 1MB request bodies
    // against an unauthed request. R44(c) and R48(h) lock the same idea
    // for Cache-Control and dev-token; here it's auth-before-body-read.
    const verifyIdx = stripped.indexOf('verifyVapiWebhook(');
    const jsonIdx = stripped.indexOf('req.json(');
    expect(verifyIdx, 'verifyVapiWebhook(...) call missing from route').toBeGreaterThan(-1);
    expect(jsonIdx, 'req.json(...) call missing from route').toBeGreaterThan(-1);
    expect(
      verifyIdx,
      `verifyVapiWebhook (idx=${verifyIdx}) must appear before req.json (idx=${jsonIdx}) in source order`,
    ).toBeLessThan(jsonIdx);
  });

  it('req.json() is wrapped in try/catch returning 400', () => {
    // Malformed JSON should never throw to the framework default 500 —
    // Vapi would retry forever. Lock try { req.json } catch { 400 }.
    expect(stripped).toMatch(/try\s*\{[\s\S]*?req\.json\(/);
    // Some catch block in the file returns status 400 — paired with the
    // try/json above, this is the early-reject path. Permissive — a
    // future refactor may put try/catch around a wider scope as long
    // as the 400 path stays.
    expect(stripped).toMatch(/catch[\s\S]*?status:\s*400/);
  });

  it('non-handled branch returns 200 (Vapi must not retry on a known-ignored type)', () => {
    // The `if (!msg || msg.type !== 'end-of-call-report') { return new Response(..., { status: 200 }); }`
    // shape. A future maintainer who flips this to 4xx by mistake would
    // cause Vapi retry storms.
    expect(stripped).toMatch(/msg\.type\s*!==\s*['"]end-of-call-report['"][\s\S]*?status:\s*200/);
  });

  it('missing call.id branch returns 400 (malformed payload, not a retry trigger)', () => {
    expect(stripped).toMatch(/(?:vapiCallId|call\.id|callId)[\s\S]*?status:\s*400/);
  });

  it('handler error branch returns 500 (Vapi MUST retry — applyEndOfCall is idempotent)', () => {
    // applyEndOfCall short-circuits on terminal status, so a retry is
    // always safe. We need 500 (not 200) so Vapi redrives a transient
    // failure and the paid user actually gets their report.
    expect(stripped).toMatch(/catch[\s\S]*?status:\s*500/);
  });

  it('handler error branch invokes captureException (silent failure tracker)', () => {
    // route.ts comment is explicit: "a silent failure here means a paid
    // user gets an empty report." Lock that captureException is wired
    // even though Sentry's DSN is still inert (item #1).
    expect(stripped).toMatch(/captureException\(/);
    // And it appears under a `route: 'vapi/webhook'` tag so the events
    // are pivotable in Sentry once the DSN lands.
    expect(stripped).toMatch(/route:\s*['"]vapi\/webhook['"]/);
  });

  it("exports dynamic = 'force-dynamic'", () => {
    expect(stripped).toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/);
  });

  it("exports runtime = 'nodejs'", () => {
    // Vapi's verification path uses Node crypto primitives via
    // `verifyVapiWebhook`; a future refactor must not flip this to
    // 'edge' without re-auditing that primitive.
    expect(stripped).toMatch(/export\s+const\s+runtime\s*=\s*['"]nodejs['"]/);
  });

  // ── Cross-source consistency lock ───────────────────────────────────

  it('VapiEndOfCallReport.type literal in lib/calls/apply-end-of-call.ts matches EXPECTED_HANDLED', () => {
    // The type discriminant on the persisted contract MUST be the same
    // string the route checks against. If apply-end-of-call.ts is
    // refactored to a different literal, downstream code would still
    // compile but the gate in route.ts would silently exclude every
    // valid payload. Cross-source equality lock.
    const TYPE_DEF_PATH = path.join(
      process.cwd(),
      'lib/calls/apply-end-of-call.ts',
    );
    const tsrc = fs.readFileSync(TYPE_DEF_PATH, 'utf8');
    const m = /type:\s*['"]([a-z][a-z0-9-]*)['"]/m.exec(tsrc);
    expect(m, 'no `type: "..."` literal found in VapiEndOfCallReport').not.toBeNull();
    const literal = m![1];
    expect(
      EXPECTED_HANDLED.has(literal),
      `apply-end-of-call.ts declares type literal '${literal}' but EXPECTED_HANDLED has ${JSON.stringify([...EXPECTED_HANDLED])}`,
    ).toBe(true);
  });
});
