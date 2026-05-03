// R38(b) — Per-route response-shape drift audit.
//
// Webhook, cron, and probe routes return JSON shapes that EXTERNAL
// clients depend on:
//
//   • Stripe's webhook retry logic inspects the 2xx body — a silent
//     rename of `received` → `acknowledged` or `eventId` → `event_id`
//     would break replay idempotency in Stripe's monitoring dashboards.
//   • `/api/health` + `/api/version` feed uptime monitors and the four
//     `Check *.command` shell scripts shipping to ops. Renaming
//     `commitShort` → `version` breaks `Check Version.command` silently.
//   • `/api/status` + `/api/cron/check-status` are polled by external
//     cron schedulers — their top-level `{ ok, checks }` shape is a
//     contract with whoever is reading the ok flag.
//   • `/api/cron/retry-failed-calls` + `/api/cron/send-reports`
//     return the inner handler's result verbatim on success and
//     `{ ok: false, error }` on failure — an outside scheduler may
//     parse both shapes.
//
// Why not Zod-validate at runtime? Because these routes already
// typed the response body (HealthResponse, VersionResponse, etc.)
// and the real gap is a deliberate rename by a well-meaning refactor
// that the TS compiler accepts. This audit is a source-level drift
// test: it greps every `NextResponse.json({...})` / `Response.json(...)`
// call in the file, extracts the top-level object-literal key set,
// and compares against a per-route EXPECTED_SHAPES lock. Forbidden
// key-drifts (e.g., `acknowledged` where `received` should be) are
// explicitly negative-asserted.
//
// This is the route-level counterpart to R37's `route-reason-audit`
// (which locked capture tag shapes) and R36's `migrations-drift`
// (which locked DDL column shapes).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentsPreservingPositions } from '../tests/helpers/source-walker';
import { ALL_ROUTES } from '../tests/helpers/route-catalog';

const APP_DIR = path.resolve(process.cwd(), 'app');

// ── Expected shapes per route ────────────────────────────────────────
//
// `requiredKeys` — every instance of the response envelope for this
// route MUST include at least one object literal containing all of
// these keys (other instances may be a subset like the error shape).
//
// `allowedKeys` — the union of keys across all response envelopes in
// the route. A key appearing in source that is NOT in this list
// fires the audit. Catches "silent new field added to webhook body"
// that external consumers haven't been informed about.
//
// `forbiddenKeys` — explicitly named drifts. These are keys a
// maintainer might reach for that break external consumers (e.g.,
// someone renames `received` → `acknowledged` or `eventId` → `event_id`).
//
// `minResponses` — lower-bound on count of `NextResponse.json({...})`
// or `Response.json({...})` call sites in the file. Catches a
// maintainer quietly removing a response path.

type ShapeLock = {
  file: string; // relative to app/
  requiredKeys: string[];
  allowedKeys: string[];
  forbiddenKeys: string[];
  // Minimum number of JSON response call sites in the file.
  minResponses: number;
};

const EXPECTED_SHAPES: ShapeLock[] = [
  // ── Probe endpoints ────────────────────────────────────────────
  {
    file: 'api/health/route.ts',
    requiredKeys: ['ok', 'version', 'uptimeMs', 'checks', 'features', 'observability'],
    allowedKeys: [
      'ok',
      'version',
      'uptimeMs',
      'checks',
      'features',
      'observability',
    ],
    forbiddenKeys: [
      'status',
      'statusText',
      'commitShort', // version owns this field; health owns `version`
      'environment', // version's field
      'error',
      'reason',
      'stack',
    ],
    minResponses: 1,
  },
  {
    file: 'api/version/route.ts',
    requiredKeys: [
      'commit',
      'commitShort',
      'branch',
      'buildTime',
      'environment',
      'region',
    ],
    allowedKeys: [
      'commit',
      'commitShort',
      'branch',
      'buildTime',
      'environment',
      'region',
    ],
    forbiddenKeys: [
      'version', // health owns this alias
      'sha',
      'build',
      'ok',
      'status',
      'error',
    ],
    minResponses: 1,
  },
  {
    file: 'api/status/route.ts',
    requiredKeys: ['ok', 'checked_at', 'checks'],
    allowedKeys: ['ok', 'checked_at', 'checks', 'errors'],
    forbiddenKeys: [
      'checkedAt', // deliberate snake_case — the field is snake_case in the type
      'timestamp',
      'reason',
      'error',
      'integrations',
      'stack',
    ],
    minResponses: 1,
  },
  // ── Cron endpoints ────────────────────────────────────────────
  {
    file: 'api/cron/check-status/route.ts',
    requiredKeys: ['ok', 'checks'],
    allowedKeys: ['ok', 'checks', 'errors'],
    forbiddenKeys: ['error', 'reason', 'stack', 'checked_at', 'timestamp'],
    minResponses: 1,
  },
  {
    // R47.3: stuck-request watchdog. Success body forwards the
    // checkStuckRequests() result (ok + stuckCount + alertSent +
    // optional note). Failure body is the standard ok+error pair.
    file: 'api/cron/check-stuck-requests/route.ts',
    requiredKeys: ['ok'],
    allowedKeys: ['ok', 'stuckCount', 'alertSent', 'note', 'error'],
    forbiddenKeys: ['reason', 'stack', 'message', 'rows', 'requestIds'],
    minResponses: 1,
  },
  {
    // Vapi call-state reconciler. Success body forwards the
    // reconcileStuckCalls() ReconcileRunResult verbatim (ok, scanned,
    // reconciled, stillActive, notFound, rateLimited, failed, notes).
    // Failure leg returns { ok: false, error } from the route's catch.
    // External consumer: ops dashboards / shell scripts that tail the
    // cron output for `failed` and `rateLimited` to alert on backlog.
    file: 'api/cron/reconcile-calls/route.ts',
    requiredKeys: ['ok', 'error'],
    allowedKeys: ['ok', 'error'],
    forbiddenKeys: ['message', 'reason', 'stack', 'status'],
    minResponses: 1,
  },
  {
    // #117 dispatch-scheduled-requests cron — picks up requests whose
    // calls were deferred to local business hours and dials them now.
    // Success leg forwards dispatchScheduledRequests() verbatim;
    // failure leg returns { ok:false, error } from the route's catch.
    // Same shape contract as the other cron routes.
    file: 'api/cron/dispatch-scheduled-requests/route.ts',
    requiredKeys: ['ok', 'error'],
    allowedKeys: ['ok', 'error'],
    forbiddenKeys: ['message', 'reason', 'stack', 'status'],
    minResponses: 1,
  },
  {
    file: 'api/cron/retry-failed-calls/route.ts',
    // Success leg returns `retryFailedCalls()` result verbatim (forwarded);
    // failure leg returns `{ ok: false, error }`. The required keys
    // below reflect the failure-leg contract only; the success body
    // is the handler's own return type, validated at that layer.
    requiredKeys: ['ok', 'error'],
    allowedKeys: ['ok', 'error'],
    forbiddenKeys: ['message', 'reason', 'stack', 'status'],
    minResponses: 1,
  },
  {
    file: 'api/cron/send-reports/route.ts',
    requiredKeys: ['ok', 'error'],
    allowedKeys: ['ok', 'error'],
    forbiddenKeys: ['message', 'reason', 'stack', 'status'],
    minResponses: 1,
  },
  {
    // Win-back email cron — re-engages satisfied past customers 7-30
    // days after a completed request. Same shape contract as the
    // other cron routes: success forwards sendWinBacks() result;
    // failure leg returns { ok:false, error } from the route catch.
    file: 'api/cron/send-winbacks/route.ts',
    requiredKeys: ['ok', 'error'],
    allowedKeys: ['ok', 'error'],
    forbiddenKeys: ['message', 'reason', 'stack', 'status'],
    minResponses: 1,
  },
  // ── Webhook endpoints (JSON body) ──────────────────────────────
  {
    file: 'api/stripe/webhook/route.ts',
    requiredKeys: ['received', 'eventId'],
    allowedKeys: ['received', 'eventId', 'note', 'error'],
    forbiddenKeys: [
      'acknowledged', // renaming `received` would break Stripe retry
      'event_id', // snake_case drift
      'handled',
      'reason',
      'status',
      'ok',
      'stack',
    ],
    minResponses: 3,
  },
  // ── Google Places proxies ─────────────────────────────────────
  //
  // Response shape is consumed by first-party form components only,
  // but we still lock it: a rename here would silently break the
  // intake forms in production with no compile error (the consumer
  // accesses fields by string key from a fetch JSON parse).
  //
  // R46(a): EXPECTED_SHAPES lock added to take these off the
  // allowlisted exception list.
  {
    file: 'api/places/autocomplete/route.ts',
    // Success body: { predictions: [...] }. Error body: { predictions, error }.
    // Never both; never a different top-level key.
    requiredKeys: ['predictions'],
    allowedKeys: ['predictions', 'error'],
    forbiddenKeys: [
      'suggestions', // Google's raw key; we deliberately remap to `predictions`
      'results',
      'data',
      'ok',
      'status',
      'place_id', // belongs inside each prediction, not at top level
      'reason',
      'stack',
    ],
    minResponses: 4, // empty-q early return + missing-key + Google !ok + try/catch
  },
  {
    file: 'api/places/details/route.ts',
    // Success body: parsed address fields + formatted + lat/lng (optional,
    // captured for the on-demand business seeder + radius selector).
    // Error body: { error }.
    requiredKeys: ['address_line', 'city', 'state', 'zip_code', 'country', 'formatted'],
    allowedKeys: [
      'address_line',
      'city',
      'state',
      'zip_code',
      'country',
      'formatted',
      'latitude',
      'longitude',
      'error',
    ],
    forbiddenKeys: [
      'addressLine', // camelCase drift
      'zipCode',
      'zip', // alias drift — column is `zip_code`
      'addressComponents', // raw Google field; we deliberately parse it
      'formattedAddress', // raw Google field; we deliberately rename to `formatted`
      'place_id', // we don't echo place_id back (caller already has it)
      'ok',
      'status',
      'reason',
      'stack',
    ],
    minResponses: 3, // missing-place-id + Google !ok + try/catch + success
  },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
}

// Find every `NextResponse.json(<obj>, …)` / `Response.json(<obj>, …)`
// call in the source and return the raw object-literal span of the
// first argument (if it's an inline object literal — we skip
// identifier-arg variants like `Response.json(result)` since those
// delegate to the handler's declared return type).
//
// Returns an array of `{ literalSrc, argPreview }` — `literalSrc`
// is the `{...}` substring, `argPreview` is the first ~60 chars
// of whatever was passed (for diagnostics + to recognize non-literal
// args like a bare identifier).
function extractJsonResponseLiterals(source: string): Array<{
  literalSrc: string;
  argPreview: string;
}> {
  const stripped = stripCommentsPreservingPositions(source);
  const callRe = /\b(?:NextResponse|Response)\.json\s*\(/g;
  const out: Array<{ literalSrc: string; argPreview: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(stripped)) !== null) {
    const callOpen = m.index + m[0].length - 1; // index of '('
    // Skip whitespace after '('.
    let i = callOpen + 1;
    while (i < stripped.length && /\s/.test(stripped[i])) i++;
    const argPreview = stripped.slice(i, i + 60);
    if (stripped[i] === '{') {
      // Inline object-literal arg — walk balanced braces.
      let depth = 0;
      let str: false | "'" | '"' | '`' = false;
      let j = i;
      for (; j < stripped.length; j++) {
        const ch = stripped[j];
        if (str) {
          if (ch === str && !isEscaped(stripped, j)) str = false;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          str = ch;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        out.push({ literalSrc: stripped.slice(i, j + 1), argPreview });
      }
      continue;
    }
    // Identifier arg — try to resolve `const <ident>: T = {...}` in
    // the same source. This catches the "build body then ship it"
    // pattern used by /api/health, /api/version, /api/status.
    const identMatch = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(i));
    if (identMatch) {
      const ident = identMatch[0];
      // Look for `const <ident>[: <Type>] = {` in the file.
      const declRe = new RegExp(
        `const\\s+${ident}(?:\\s*:[^=]+)?\\s*=\\s*\\{`,
      );
      const dm = declRe.exec(stripped);
      if (dm) {
        // Start at the `{` the regex ended on.
        const start = dm.index + dm[0].length - 1;
        let depth = 0;
        let str: false | "'" | '"' | '`' = false;
        let j = start;
        for (; j < stripped.length; j++) {
          const ch = stripped[j];
          if (str) {
            if (ch === str && !isEscaped(stripped, j)) str = false;
            continue;
          }
          if (ch === "'" || ch === '"' || ch === '`') {
            str = ch;
            continue;
          }
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth === 0) {
          out.push({
            literalSrc: stripped.slice(start, j + 1),
            argPreview: `(via const ${ident}) ` + argPreview,
          });
          continue;
        }
      }
    }
    // Non-resolvable arg (arrow-inline compute, ternary, etc.).
    out.push({ literalSrc: '', argPreview });
  }
  return out;
}

function isEscaped(s: string, i: number): boolean {
  let bs = 0;
  let b = i - 1;
  while (b >= 0 && s[b] === '\\') {
    bs++;
    b--;
  }
  return bs % 2 === 1;
}

// Extract top-level keys from an object-literal source span.
//
// Walks the literal with a KEY/VALUE state machine:
//   • Start in KEY state right after the opening `{`.
//   • In KEY state, read an identifier / quoted string / spread and
//     capture it, then transition to VALUE state after consuming the
//     trailing `:` (or back to KEY if it was a shorthand property
//     followed directly by `,`/`}`).
//   • In VALUE state, scan until a top-level `,` — any `{` / `[` / `(`
//     bumps a nested-depth counter that must return to 0 before a
//     `,` counts as end-of-value. Skip past string literals entirely.
//   • After a top-level `,`, return to KEY state.
//
// This avoids the bug where value tokens like `true`, `false`, or
// identifier values (`err.message`, `err instanceof Error ? ...`) were
// being read as if they were keys.
//
// Supports: bare ident keys, quoted keys, shorthand (`{ ok }`),
// spread (`...rest` captured as the token), object/array/call-expr
// values. Skips computed `[expr]:` keys (too rare + complex).
function extractTopLevelKeys(literalSrc: string): string[] {
  const keys: string[] = [];
  let i = 1; // skip opening '{'
  type Mode = 'key' | 'value';
  let mode: Mode = 'key';
  while (i < literalSrc.length) {
    // Skip whitespace + comments.
    while (i < literalSrc.length && /\s/.test(literalSrc[i])) i++;
    if (i >= literalSrc.length) break;
    const ch = literalSrc[i];
    if (ch === '}') break; // end of the outer literal
    if (mode === 'key') {
      // Spread.
      if (ch === '.' && literalSrc[i + 1] === '.' && literalSrc[i + 2] === '.') {
        let k = i + 3;
        while (k < literalSrc.length && /[\w$]/.test(literalSrc[k])) k++;
        keys.push(literalSrc.slice(i, k));
        i = k;
        // Skip to the next `,` at depth 0 (or `}`).
        i = skipToCommaOrBraceClose(literalSrc, i);
        if (literalSrc[i] === ',') i++;
        continue;
      }
      // Quoted key.
      if (ch === "'" || ch === '"') {
        const quote = ch;
        let k = i + 1;
        while (k < literalSrc.length && !(literalSrc[k] === quote && !isEscaped(literalSrc, k))) {
          k++;
        }
        const key = literalSrc.slice(i + 1, k);
        i = k + 1;
        // Expect `:` after whitespace; else treat as malformed + skip.
        while (i < literalSrc.length && /\s/.test(literalSrc[i])) i++;
        if (literalSrc[i] === ':') {
          keys.push(key);
          i++;
          mode = 'value';
          continue;
        }
        // Otherwise advance past whatever this was.
        continue;
      }
      // Computed `[expr]:` — skip.
      if (ch === '[') {
        i = skipBalanced(literalSrc, i, '[', ']');
        while (i < literalSrc.length && /\s/.test(literalSrc[i])) i++;
        if (literalSrc[i] === ':') {
          i++;
          mode = 'value';
        }
        continue;
      }
      // Bare identifier.
      if (/[A-Za-z_$]/.test(ch)) {
        let k = i;
        while (k < literalSrc.length && /[\w$]/.test(literalSrc[k])) k++;
        const ident = literalSrc.slice(i, k);
        i = k;
        while (i < literalSrc.length && /\s/.test(literalSrc[i])) i++;
        if (literalSrc[i] === ':') {
          keys.push(ident);
          i++;
          mode = 'value';
          continue;
        }
        if (literalSrc[i] === ',' || literalSrc[i] === '}') {
          // Shorthand property.
          keys.push(ident);
          if (literalSrc[i] === ',') i++;
          continue;
        }
        // Malformed (computed via bare call, ternary in key position,
        // etc.) — bail this pair.
        i = skipToCommaOrBraceClose(literalSrc, i);
        if (literalSrc[i] === ',') i++;
        continue;
      }
      // Comma (empty pair / double comma). Skip.
      if (ch === ',') {
        i++;
        continue;
      }
      // Unknown in key position. Skip one char to avoid infinite loop.
      i++;
      continue;
    }
    // mode === 'value'
    i = skipToCommaOrBraceClose(literalSrc, i);
    if (literalSrc[i] === ',') i++;
    mode = 'key';
  }
  return keys;
}

// Advance index past a balanced `open`/`close` pair starting at `start`
// (where literalSrc[start] === open). Handles nested + string-aware.
function skipBalanced(
  literalSrc: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let str: false | "'" | '"' | '`' = false;
  let i = start;
  for (; i < literalSrc.length; i++) {
    const ch = literalSrc[i];
    if (str) {
      if (ch === str && !isEscaped(literalSrc, i)) str = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

// Scan forward until a top-level (nested-depth-0, not in string) `,`
// or `}`. Returns the index OF the comma or closing brace.
function skipToCommaOrBraceClose(literalSrc: string, start: number): number {
  let depth = 0;
  let str: false | "'" | '"' | '`' = false;
  let i = start;
  for (; i < literalSrc.length; i++) {
    const ch = literalSrc[i];
    if (str) {
      if (ch === str && !isEscaped(literalSrc, i)) str = false;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      str = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) return i; // found closing outer '}'
      depth--;
    } else if (ch === ',' && depth === 0) {
      return i;
    }
  }
  return i;
}

describe('R38(b) — route response-shape drift audit', () => {
  for (const lock of EXPECTED_SHAPES) {
    describe(lock.file, () => {
      const source = read(lock.file);
      const responses = extractJsonResponseLiterals(source);
      const literalResponses = responses.filter((r) => r.literalSrc !== '');
      const keySets = literalResponses.map((r) => extractTopLevelKeys(r.literalSrc));
      const unionKeys = new Set(keySets.flat().filter((k) => !k.startsWith('...')));

      it('has at least the minimum documented JSON responses', () => {
        expect(
          responses.length,
          `${lock.file}: expected ≥ ${lock.minResponses} JSON responses, found ${responses.length}. Previews: ${responses
            .map((r) => r.argPreview.slice(0, 40))
            .join(' | ')}`,
        ).toBeGreaterThanOrEqual(lock.minResponses);
      });

      it('has at least one response literal covering every requiredKey', () => {
        // Every required key must appear in AT LEAST ONE response
        // literal. (The error envelope legitimately omits business
        // keys; the success envelope legitimately omits error keys.
        // The requirement is that SOMEWHERE in the file, a response
        // body carries the key.)
        for (const key of lock.requiredKeys) {
          expect(
            unionKeys.has(key),
            `${lock.file}: required key '${key}' not found in any NextResponse.json({...}) literal`,
          ).toBe(true);
        }
      });

      it('every emitted key is in allowedKeys (no ad-hoc drift)', () => {
        for (const key of unionKeys) {
          expect(
            lock.allowedKeys.includes(key),
            `${lock.file}: key '${key}' is not in allowedKeys. Either add it to the lock (and document the consumer contract change) or rename it back.`,
          ).toBe(true);
        }
      });

      it('no forbidden drifted key is present in any response literal', () => {
        for (const key of lock.forbiddenKeys) {
          expect(
            unionKeys.has(key),
            `${lock.file}: forbidden key '${key}' found — this would break an external consumer contract. See EXPECTED_SHAPES for rationale.`,
          ).toBe(false);
        }
      });

      it('response literals contain no PII-tagged keys', () => {
        // Defense-in-depth: even if a future maintainer adds a key
        // that happens to pass the forbidden-list, these bags of
        // PII tokens are never legitimate to include in a webhook /
        // cron / probe response body.
        const pii = [
          'email',
          'phone',
          'address',
          'full_name',
          'password',
          'token',
          'apiKey',
          'api_key',
          'ssn',
          'creditCard',
        ];
        for (const key of unionKeys) {
          for (const p of pii) {
            expect(
              key === p || key === p.toLowerCase() || key === p.toUpperCase(),
              `${lock.file}: response body contains PII-adjacent key '${key}'`,
            ).toBe(false);
          }
        }
      });
    });
  }

  // ── Cross-file tripwires ───────────────────────────────────────

  it('EXPECTED_SHAPES covers every JSON-returning route in app/api', () => {
    // Any `route.ts` file under app/api/ that calls NextResponse.json
    // or Response.json with an INLINE OBJECT LITERAL should be locked
    // here (or explicitly allow-listed). This forces future
    // maintainers to decide per-route whether their response is
    // contract-bound or not.
    const locked = new Set(EXPECTED_SHAPES.map((s) => s.file));
    // Routes that legitimately return non-JSON (or return JSON but
    // don't have an external consumer contract — dev endpoints under
    // /api/dev are allow-listed because they're behind DEV_TRIGGER_TOKEN
    // and not promoted to production callers).
    const allowlisted = new Set([
      'api/twilio/sms/route.ts', // XML TwiML body
      'api/vapi/webhook/route.ts', // text/plain
      'api/vapi/inbound-callback/route.ts', // text/plain
      'api/csp-report/route.ts', // 204 no body
      'api/dev/trigger-call/route.ts', // dev-token-gated
      'api/dev/backfill-call/route.ts', // dev-token-gated
      'api/dev/skip-payment/route.ts', // dev-token-gated
      // R46(a): Google Places proxies are now LOCKED in EXPECTED_SHAPES
      // above (no longer allowlisted).
    ]);
    const routeFiles = walkRouteFiles(APP_DIR);
    const jsonReturning = routeFiles.filter((rel) => {
      const s = fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
      return /\b(?:NextResponse|Response)\.json\s*\(\s*\{/.test(
        stripCommentsPreservingPositions(s),
      );
    });
    const unlocked = jsonReturning.filter(
      (rel) => !locked.has(rel) && !allowlisted.has(rel),
    );
    expect(
      unlocked,
      `Unlocked JSON-returning route.ts files: ${unlocked.join(', ')}. Add each to EXPECTED_SHAPES or allowlisted.`,
    ).toEqual([]);
  });

  it('EXPECTED_SHAPES entry count is within documented band', () => {
    // Band guards against silent deletion or explosive addition.
    // If a new route lands, raise the upper bound deliberately.
    expect(EXPECTED_SHAPES.length).toBeGreaterThanOrEqual(5);
    expect(EXPECTED_SHAPES.length).toBeLessThanOrEqual(15);
  });

  it('no duplicate file entries in EXPECTED_SHAPES', () => {
    const files = EXPECTED_SHAPES.map((s) => s.file);
    const unique = new Set(files);
    expect(unique.size).toBe(files.length);
  });

  it('every EXPECTED_SHAPES file is a known route in route-catalog ALL_ROUTES (R47(b))', () => {
    // EXPECTED_SHAPES uses path-inside-app/ format ('api/health/route.ts').
    // ALL_ROUTES uses catalog format ('app/api/health/route.ts'). Map
    // and verify membership: a typo'd path in EXPECTED_SHAPES would
    // silently slip past per-route tests because the file existed
    // (and per-route iteration would just not run for the bad path).
    // This check pins membership against the catalog.
    const ghostShapes: string[] = [];
    for (const lock of EXPECTED_SHAPES) {
      const catalogPath = `app/${lock.file}`;
      if (!ALL_ROUTES.has(catalogPath)) ghostShapes.push(lock.file);
    }
    expect(
      ghostShapes,
      `EXPECTED_SHAPES has files not in route-catalog.ts ALL_ROUTES (typo or stale entry): ${ghostShapes.join(', ')}`,
    ).toEqual([]);
  });
});

function walkRouteFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkRouteFiles(full, rel));
    } else if (entry.isFile() && entry.name === 'route.ts') {
      out.push(rel);
    }
  }
  return out;
}
