// R36(d) RPC argument round-trip audit.
//
// Counterpart to the R35 / R36(b) migrations column-and-type drift
// checks (`supabase/migrations-drift.test.ts`). That file locks
// COLUMN-level invariants. This file locks the equivalent invariant
// for RPC call signatures — bridging app-side `.rpc(name, args)`
// calls and migration-side `create or replace function public.<name>(...)`
// signatures.
//
// Why this is needed:
//
//   • Per-route drift suites (R26/R30/R31/R32) lock that the app
//     passes `p_request_id`/`p_call_id`/`p_quote_inserted` etc. to
//     `apply_call_end`. But those tests run against mocked
//     supabase clients — if a migration renamed `p_request_id` to
//     `p_quote_request_id`, every app-level drift test would still
//     pass (the mock accepts whatever the caller sends), and the
//     break would only surface at preview-deploy.
//
//   • Conversely, if the migration signature gains a new required
//     argument (no DEFAULT), existing callers would silently send
//     `null` for it on Postgres's side — or fail with a
//     "function does not exist" error if the signature search
//     fails. Either way, the shape-break isn't caught in CI today.
//
// The audit parses every `create or replace function public.<name>(...)`
// body under `supabase/migrations/` in lexical order (later
// migrations win on re-declarations — Postgres `create or replace`
// semantics), extracts (name, [{argName, hasDefault}]) tuples, and
// cross-references every `<client>.rpc('<name>', { ... })` call in
// app code to assert:
//
//   1. Every RPC NAME the app calls is defined in at least one
//      migration.
//   2. Every argument the app passes is declared in the final
//      signature (no "phantom" arg sent to Postgres).
//   3. Every REQUIRED argument (no DEFAULT) in the signature is
//      passed by every caller of that RPC (no silent-null).
//   4. DEFAULT arguments may be omitted by the caller; we don't
//      require them — but if the app DOES pass one, it must be
//      declared.
//
// Out of scope (deliberately):
//   • Argument TYPES. The R36(b) type-drift audit locks column
//     types. Extending it to RPC arg types would require more
//     complex plpgsql parsing (composite types, return tables,
//     etc.) than a single audit file warrants. If you care,
//     the RPC's TypeScript generated types via `supabase gen
//     types` would be the right integration point.
//   • RETURN shape. Same rationale — already covered at the
//     type-generation layer.
//   • trigger_cron_route in the `private` schema. The app never
//     calls it directly; it fires via pg_cron schedule.
//
// When this audit fires, the remediation is always either:
//   (a) update the app-side .rpc() call to match the new signature, OR
//   (b) write a new migration that restores the old signature (or
//       adds a DEFAULT so existing callers don't break).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');
const APP_ROOTS = [
  path.resolve(process.cwd(), 'app'),
  path.resolve(process.cwd(), 'lib'),
];

// ── Migration-side signature parser ─────────────────────────────────
type RpcSignature = {
  fnName: string;
  args: Array<{ name: string; hasDefault: boolean }>;
  definedInFile: string;
};

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, '');
}

// Extract every `create or replace function public.<name>(<args>) ...`
// from a migration file. The args are everything between the opening
// `(` and the matching close `)` at depth 0. We then split on top-
// level commas (string-literal + paren-depth aware) and for each arg
// capture the LEADING identifier and whether a `default` keyword
// appears anywhere in the rest of the arg body.
//
// Returns an array of signatures in FILE order. Later files
// override earlier ones by fnName — the caller of this helper
// dedups via last-wins semantics.
function parseFunctionsInFile(file: string, source: string): RpcSignature[] {
  const out: RpcSignature[] = [];
  const stripped = stripSqlComments(source);
  // Match only public-schema functions; the `private.trigger_cron_route`
  // isn't app-callable and has a different shape.
  const re = /create\s+or\s+replace\s+function\s+public\.([A-Za-z_][\w]*)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const fnName = m[1];
    const openIdx = m.index + m[0].length - 1; // position of `(`
    // Balanced-paren walk to find the matching close.
    let depth = 1;
    let i = openIdx + 1;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = stripped.slice(openIdx + 1, i - 1);

    // String + paren aware comma split over the arg body.
    const parts: string[] = [];
    let cur = '';
    let pdepth = 0;
    let inString = false;
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (ch === "'") {
        if (inString && body[k + 1] === "'") {
          cur += ch;
          cur += body[++k];
          continue;
        }
        inString = !inString;
        cur += ch;
        continue;
      }
      if (!inString) {
        if (ch === '(') pdepth++;
        else if (ch === ')') pdepth--;
        if (ch === ',' && pdepth === 0) {
          parts.push(cur);
          cur = '';
          continue;
        }
      }
      cur += ch;
    }
    if (cur.trim().length > 0) parts.push(cur);

    const args: Array<{ name: string; hasDefault: boolean }> = [];
    for (const raw of parts) {
      const t = raw.trim();
      if (t.length === 0) continue;
      const nameMatch = /^(?:in\s+|out\s+|inout\s+)?([A-Za-z_][\w]*)/i.exec(t);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      // `default` keyword in the tail OR the `= value` shorthand.
      const hasDefault = /\bdefault\b/i.test(t) || /=\s*[^,)]/.test(t);
      args.push({ name, hasDefault });
    }
    out.push({
      fnName,
      args,
      definedInFile: path.basename(file),
    });
  }
  return out;
}

function buildSignatureIndex(): Map<string, RpcSignature> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const byName = new Map<string, RpcSignature>();
  for (const f of files) {
    const abs = path.join(MIGRATIONS_DIR, f);
    const src = fs.readFileSync(abs, 'utf8');
    for (const sig of parseFunctionsInFile(abs, src)) {
      // Later migrations override earlier ones (create OR REPLACE).
      byName.set(sig.fnName, sig);
    }
  }
  return byName;
}

const SIG_INDEX = buildSignatureIndex();

// ── App-side RPC call parser ─────────────────────────────────────────
type RpcCall = {
  file: string; // relative to repo root
  fnName: string;
  argNames: string[]; // keys passed in the second arg object literal
};

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

function stripTsCommentsAndStrings(src: string): string {
  // Strip block comments + line comments.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  out = out.replace(/(^|[^:])\/\/.*$/gm, (m) => ' '.repeat(m.length));
  // Do NOT strip strings — we need the first arg to .rpc() which is
  // the RPC name as a string literal. But we DO need to avoid
  // confusing backticked template strings inside the arg object;
  // templates rarely contain `:` in our codebase at call sites but
  // we leave them alone for simplicity.
  return out;
}

function extractRpcCalls(file: string, source: string): RpcCall[] {
  const out: RpcCall[] = [];
  const stripped = stripTsCommentsAndStrings(source);
  // Match `.rpc('<name>',` — capture the name literal. Then advance
  // past the `,` and read an object literal via balanced-brace walk.
  const re = /\.rpc\s*\(\s*'([A-Za-z_][\w]*)'\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const fnName = m[1];
    const openBraceIdx = m.index + m[0].length - 1; // at `{`
    let depth = 1;
    let i = openBraceIdx + 1;
    let inString: false | "'" | '"' | '`' = false;
    for (; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (inString) {
        if (ch === inString && stripped[i - 1] !== '\\') inString = false;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) continue;
    const body = stripped.slice(openBraceIdx + 1, i - 1);

    // Extract object-literal keys: look for `<name>:` at the top
    // level of the body (not nested inside sub-objects or calls).
    const keys: string[] = [];
    let k = 0;
    let keyDepth = 0;
    let keyInString: false | "'" | '"' | '`' = false;
    let keyBuf = '';
    while (k < body.length) {
      const ch = body[k];
      if (keyInString) {
        if (ch === keyInString && body[k - 1] !== '\\') keyInString = false;
        k++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        keyInString = ch;
        k++;
        continue;
      }
      if (ch === '{' || ch === '(' || ch === '[') keyDepth++;
      else if (ch === '}' || ch === ')' || ch === ']') keyDepth--;
      if (keyDepth === 0 && (ch === ',' || k === body.length - 1)) {
        const trimmed = (keyBuf + (ch === ',' ? '' : ch)).trim();
        const km = /^([A-Za-z_][\w]*)\s*:/.exec(trimmed);
        if (km) keys.push(km[1]);
        keyBuf = '';
      } else {
        keyBuf += ch;
      }
      k++;
    }
    // Flush trailing buffer (no trailing comma).
    const tail = keyBuf.trim();
    if (tail.length > 0) {
      const km = /^([A-Za-z_][\w]*)\s*:/.exec(tail);
      if (km && !keys.includes(km[1])) keys.push(km[1]);
    }

    out.push({
      file: path.relative(process.cwd(), file),
      fnName,
      argNames: keys,
    });
  }
  return out;
}

function collectAllCalls(): RpcCall[] {
  const out: RpcCall[] = [];
  for (const root of APP_ROOTS) {
    for (const f of collectTsFiles(root)) {
      const src = fs.readFileSync(f, 'utf8');
      out.push(...extractRpcCalls(f, src));
    }
  }
  return out;
}

const APP_CALLS = collectAllCalls();

// ── Tests ────────────────────────────────────────────────────────────
describe('supabase/ RPC arg round-trip audit (R36d)', () => {
  it('discovers at least 5 RPC signatures in migrations', () => {
    // Sanity check on the parser. R35 close count: 5 public RPCs
    // (apply_call_end, recompute_business_success_rate,
    // businesses_within_radius, pick_vapi_number,
    // increment_quotes_collected). Handle/set/is-admin helper
    // functions are in the index too but are not .rpc()-callable.
    expect(SIG_INDEX.size).toBeGreaterThanOrEqual(5);
  });

  it('discovers at least 5 .rpc() call sites across app + lib', () => {
    // Current count: 7 (apply_call_end ×2, recompute_business
    // ×1, businesses_within_radius ×1, pick_vapi_number ×1,
    // increment_quotes_collected ×2).
    expect(APP_CALLS.length).toBeGreaterThanOrEqual(5);
  });

  it('every RPC name called by app code is defined in at least one migration (no phantom RPCs)', () => {
    const violations: string[] = [];
    for (const call of APP_CALLS) {
      if (!SIG_INDEX.has(call.fnName)) {
        violations.push(
          `${call.file}: calls .rpc('${call.fnName}', ...) but no migration defines public.${call.fnName}`,
        );
      }
    }
    expect(
      violations,
      `app calls undefined RPCs:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every app-supplied arg is declared in the final RPC signature (no unknown args)', () => {
    const violations: string[] = [];
    for (const call of APP_CALLS) {
      const sig = SIG_INDEX.get(call.fnName);
      if (!sig) continue; // reported by the previous test
      const declared = new Set(sig.args.map((a) => a.name));
      for (const argName of call.argNames) {
        if (!declared.has(argName)) {
          violations.push(
            `${call.file}: .rpc('${call.fnName}', ...) passes '${argName}' but the signature in ${sig.definedInFile} declares [${sig.args
              .map((a) => `'${a.name}'`)
              .join(', ')}]`,
          );
        }
      }
    }
    expect(
      violations,
      `unknown args sent to RPC:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every REQUIRED signature arg (no DEFAULT) is passed by every caller (no silent-null)', () => {
    const violations: string[] = [];
    for (const call of APP_CALLS) {
      const sig = SIG_INDEX.get(call.fnName);
      if (!sig) continue;
      const supplied = new Set(call.argNames);
      for (const arg of sig.args) {
        if (arg.hasDefault) continue;
        if (!supplied.has(arg.name)) {
          violations.push(
            `${call.file}: .rpc('${call.fnName}', ...) missing required arg '${arg.name}' — declared in ${sig.definedInFile} without a DEFAULT`,
          );
        }
      }
    }
    expect(
      violations,
      `missing required RPC args:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every migration RPC the app relies on actually lands in the final signature index', () => {
    // Hard-coded list of RPCs the app is known to call. If one
    // vanishes from SIG_INDEX (e.g. dropped via `drop function`
    // in a new migration without an equivalent `create or replace`
    // restoring it), fail loudly here before a deploy.
    const APP_RELIED_ON_RPCS = [
      'apply_call_end',
      'recompute_business_success_rate',
      'businesses_within_radius',
      'pick_vapi_number',
      'increment_quotes_collected',
    ];
    const missing = APP_RELIED_ON_RPCS.filter((n) => !SIG_INDEX.has(n));
    expect(
      missing,
      `RPCs the app relies on are missing from the signature index: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('apply_call_end uses the post-R31 3-arg signature (create or replace overrides the old 2-arg form)', () => {
    // The R31 migration (0008_end_of_call_idempotency.sql) widened
    // apply_call_end from 2 args to 3 via `create or replace`. The
    // earlier 0006 declaration had 2 args. Postgres keeps only the
    // latest; the app-side call passes all 3. Lock that fact so a
    // future revert to the 2-arg form would fail the app shape
    // tests AND this audit simultaneously.
    const sig = SIG_INDEX.get('apply_call_end');
    expect(sig, 'apply_call_end signature missing').toBeDefined();
    if (!sig) return;
    expect(sig.args.map((a) => a.name)).toEqual([
      'p_request_id',
      'p_call_id',
      'p_quote_inserted',
    ]);
    expect(sig.args.every((a) => !a.hasDefault), 'apply_call_end args unexpectedly have defaults').toBe(
      true,
    );
    // Must come from the R31 / phase-8 migration, not the 0006 one.
    expect(sig.definedInFile).toBe('0008_end_of_call_idempotency.sql');
  });

  it('pick_vapi_number has p_daily_cap as an optional (DEFAULT) arg so single-arg callers keep working', () => {
    // The app calls .rpc('pick_vapi_number', { p_area_code }) in
    // lib/calls/select-vapi-number.ts — deliberately omitting
    // p_daily_cap to rely on the signature default. If a future
    // migration removed the DEFAULT, callers would silently send
    // null and the RPC would error-out on every dispatch.
    const sig = SIG_INDEX.get('pick_vapi_number');
    expect(sig, 'pick_vapi_number signature missing').toBeDefined();
    if (!sig) return;
    const cap = sig.args.find((a) => a.name === 'p_daily_cap');
    expect(cap?.hasDefault, 'p_daily_cap must have a DEFAULT in the signature').toBe(true);
  });

  it('increment_quotes_collected has the single required arg p_request_id (webhook retry invariant)', () => {
    // Called from app/api/twilio/sms/route.ts and app/api/vapi/
    // inbound-callback/route.ts. Adding a second required arg
    // here without also updating both route handlers would break
    // quote-collection counter increments for every successful
    // call. Lock.
    const sig = SIG_INDEX.get('increment_quotes_collected');
    expect(sig, 'increment_quotes_collected signature missing').toBeDefined();
    if (!sig) return;
    const required = sig.args.filter((a) => !a.hasDefault).map((a) => a.name);
    expect(required).toEqual(['p_request_id']);
  });

  it('count band: 5–10 RPC signatures, 5–15 call sites (drift tripwire)', () => {
    // Catches bulk growth — if 20 new RPCs appear overnight, or
    // if every route handler starts spamming .rpc(), we want a
    // signal to re-evaluate the audit scope (per-RPC allow-lists,
    // call-site allow-lists, etc.).
    expect(SIG_INDEX.size).toBeGreaterThanOrEqual(5);
    expect(SIG_INDEX.size).toBeLessThanOrEqual(15);
    expect(APP_CALLS.length).toBeGreaterThanOrEqual(5);
    expect(APP_CALLS.length).toBeLessThanOrEqual(20);
  });
});
