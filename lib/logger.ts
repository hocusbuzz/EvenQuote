// Minimal structured logger with PII redaction.
//
// Why not just console.log: our handlers (Stripe webhook, Vapi webhook,
// cron jobs) emit customer data into Vercel logs whenever they log an
// error object that contains an intake row. Email addresses and phone
// numbers landing in logs is a soft privacy incident and some
// jurisdictions (CCPA, parts of EU law) treat it as a reportable one.
//
// Strategy: thin wrapper over console that:
//   1. Serializes structured context as JSON-friendly shapes.
//   2. Runs any string or stringified object through a redaction regex
//      pass for emails and phone numbers before it ships to stdout.
//   3. Always tags the line with a namespace so log search is tractable.
//
// NOT a drop-in for pino/winston; we're staying zero-deps. If we need
// log correlation or shipping to Datadog later, swap the internal sink.

type LogContext = Record<string, unknown>;

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// E.164-ish / US 10-digit patterns, deliberately loose.
//
// The lookbehind `(?<![0-9A-Fa-f-])` and lookahead `(?![0-9A-Fa-f-])`
// guard against the regex matching inside a UUID like
// `11111111-1111-1111-1111-111111111111`. Before this guard, long digit
// runs hyphen-separated were being mis-tagged as phone numbers, which
// destroyed traceability for request ids in logs (a support ticket
// referencing a request id couldn't be grep'd out of the log stream
// because the id had been redacted). Real phone numbers are bookended
// by whitespace, punctuation, start/end-of-string, or letters like "tel:".
// Hex chars and hyphens adjacent to a phone-shaped run strongly imply
// the run is part of something bigger — skip it.
const PHONE_RE =
  /(?<![0-9A-Fa-f-])(\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}(?![0-9A-Fa-f-])/g;

/** Mask emails and phone numbers in a string. Safe to call on any string. */
export function redactPII(input: string): string {
  if (!input) return input;
  return input
    .replace(EMAIL_RE, (_m, first, domain) => `${first}***@${domain}`)
    .replace(PHONE_RE, '[phone]');
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactPII(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactPII(value.message),
      stack: value.stack ? redactPII(value.stack) : undefined,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Drop obviously-secret keys outright. Redaction is defense-in-depth;
    // dropping is stronger.
    if (/(password|secret|token|authorization|service_role|api[-_]?key)/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = redactDeep(v);
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Decide whether an `err` value is substantive enough to fingerprint.
 *
 * We want to auto-fingerprint real error objects and error-shaped plain
 * objects (for errors that crossed a Promise.reject boundary and lost
 * their prototype). We explicitly skip `null` / `undefined` / empty
 * strings because fingerprinting those produces the same degenerate
 * hash across unrelated call sites and adds noise to log grouping.
 *
 * Strings are fingerprinted — a fingerprint on a plain string err
 * isn't useful for stack-shape grouping (the string has no stack)
 * but staying consistent is less surprising than silent omission.
 */
function shouldFingerprint(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err === 'string' && err.length === 0) return false;
  return true;
}

function emit(level: Level, ns: string, msg: string, ctx?: LogContext): void {
  // Auto-fingerprint: if ctx has a substantive `err` and no explicit
  // `fingerprint` was set, compute one and lift it to the top-level
  // payload. Top-level so monitors can grep a single key; not nested
  // so it survives even if someone later spreads `ctx` into something.
  // Respects explicit `fingerprint` overrides (callers that know
  // better can keep their own ids).
  let autoFingerprint: string | undefined;
  if (ctx && 'err' in ctx && shouldFingerprint(ctx.err)) {
    const explicit = ctx.fingerprint;
    if (typeof explicit === 'string' && explicit.length > 0) {
      autoFingerprint = explicit;
    } else {
      autoFingerprint = fingerprintError(ctx.err);
    }
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    ns,
    msg: redactPII(msg),
    ...(autoFingerprint ? { fingerprint: autoFingerprint } : {}),
    ...(ctx ? { ctx: redactDeep(ctx) as LogContext } : {}),
  };
  // Send to stdout/stderr via console. Vercel picks that up as-is.
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'debug') console.debug(line);
  else console.log(line);
}

export function createLogger(namespace: string) {
  return {
    debug: (msg: string, ctx?: LogContext) => emit('debug', namespace, msg, ctx),
    info: (msg: string, ctx?: LogContext) => emit('info', namespace, msg, ctx),
    warn: (msg: string, ctx?: LogContext) => emit('warn', namespace, msg, ctx),
    error: (msg: string, ctx?: LogContext) => emit('error', namespace, msg, ctx),
  };
}

export type Logger = ReturnType<typeof createLogger>;

// ---------------------------------------------------------------------------
// Error fingerprinting — stable hash of a normalized call stack so duplicate
// error reports collapse upstream (Sentry, Datadog, logs search).
//
// Why we're not just using `err.message`: messages often contain dynamic
// data — user ids, URLs, timestamps, db row ids. Two identical bugs firing
// under different inputs produce different messages and therefore don't
// group. Stack structure, in contrast, is a stable shape of *where* the
// bug lives. Hashing a cleaned-up stack gives us the same id across
// different invocations of the same failure.
//
// Design constraints:
// - Zero deps. FNV-1a 32-bit → 8-char hex. Plenty of entropy for a
//   within-app error catalog (we aren't indexing the web).
// - Normalize before hashing so tiny source edits (a blank line insert,
//   a path prefix change in a build environment) don't churn the id:
//     • Strip absolute paths down to basenames
//     • Strip trailing :line:col numbers
//     • Collapse webpack/bundler prefixes like `webpack-internal:///`
//     • Keep only the top N frames (default 5) — callers vary, the top
//       of the stack doesn't.
// - Include error.name — `TypeError` and `RangeError` thrown from the
//   same line should fingerprint differently.
// - Deliberately exclude err.message. If you want message-level grouping,
//   use a monitoring tool.
// ---------------------------------------------------------------------------

const DEFAULT_STACK_FRAMES = 5;
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

function fnv1a32Hex(input: string): string {
  // Classic FNV-1a over UTF-16 code units — deterministic, no allocs per
  // char. 32-bit variant is plenty for a bounded error corpus.
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul keeps the multiply 32-bit; >>> 0 coerces to unsigned.
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Normalize a single stack-frame line for hashing. */
function normalizeFrame(frame: string): string {
  let f = frame.trim();
  // Strip typical bundler / loader prefixes.
  f = f.replace(/webpack-internal:\/{2,3}/g, '');
  f = f.replace(/file:\/{2,3}/g, '');
  // Strip absolute paths down to the basename (plus any node_modules hint).
  // `at foo (/Users/a/p/lib/x.ts:12:3)` → `at foo (x.ts)`
  f = f.replace(/\(([^)]*?)([^/\\)]+?)(?::\d+:\d+)?\)/g, (_all, _prefix, file) => `(${file})`);
  // Bare-file form without parens: `at /abs/lib/x.ts:12:3` → `at x.ts`
  f = f.replace(/(\s)(?:[^\s(]*[/\\])?([^\s(:]+)(?::\d+:\d+)?$/, (_all, pre, file) => `${pre}${file}`);
  return f;
}

/**
 * Produce a stable short hex fingerprint for an error. Two errors with the
 * same error name and same top-of-stack shape will share a fingerprint,
 * even if their messages / user inputs differ.
 *
 * @param err     The error (or error-shaped value) to fingerprint.
 * @param frames  How many top stack frames to include. Default 5.
 */
export function fingerprintError(
  err: unknown,
  frames: number = DEFAULT_STACK_FRAMES,
): string {
  const name =
    err instanceof Error
      ? err.name
      : typeof err === 'object' && err && 'name' in err && typeof (err as { name: unknown }).name === 'string'
        ? (err as { name: string }).name
        : 'Error';

  const stack =
    err instanceof Error
      ? err.stack ?? ''
      : typeof err === 'object' && err && 'stack' in err && typeof (err as { stack: unknown }).stack === 'string'
        ? (err as { stack: string }).stack
        : '';

  // Grab only the "at ..." lines — the first line is usually
  // `ErrorName: message` which we deliberately skip to avoid message churn.
  const atLines = stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '));

  const topN = atLines.slice(0, Math.max(0, frames)).map(normalizeFrame);
  const payload = `${name}\n${topN.join('\n')}`;
  return fnv1a32Hex(payload);
}
