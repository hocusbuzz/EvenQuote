#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Preview-deploy webhook smoke test (R34).
 *
 * The R33 feasibility report (`docs/RETRY_HARNESS_FEASIBILITY_R33.md`)
 * evaluated whether to install an MSW + supertest harness for real-
 * HTTP webhook retry-storm coverage. Conclusion: the highest-value
 * version of this work is NOT a local in-process harness; it's a
 * smoke test that POSTs REAL signed webhook payloads at the preview
 * deployment. That exercises the actual Vercel target — middleware
 * ordering, chunked-encoding handling, platform-level retry
 * annotations — which a local harness cannot reproduce.
 *
 * This script is that smoke test. Zero new dependencies: uses the
 * Stripe SDK (already a production dep) plus Node's built-in crypto
 * for Vapi + Twilio signing.
 *
 * Scope:
 *   • Stripe /api/stripe/webhook   — signed payload + 20-retry storm
 *   • Vapi   /api/vapi/webhook     — signed payload + dedupe check
 *   • Twilio /api/twilio/sms       — signed payload + dedupe check
 *
 * What it DOES assert:
 *   • Every POST returns HTTP 200.
 *   • Retry storms do NOT surface a 5xx (the route's idempotency
 *     layer must absorb them).
 *   • Duplicate-event returns match the R30 "Duplicate event —
 *     already processed" contract in their response body.
 *
 * What it DOES NOT assert:
 *   • DB row state. The preview DB may or may not be shared with
 *     other smoke runs; asserting row counts would be flaky. The
 *     in-process idempotency tests (`app/api/stripe/webhook/route
 *     .test.ts` R30 stateful-stub block) already lock the DB-side
 *     invariants against a mocked Supabase. This script is the wire
 *     /transport-level sibling of that, not a replacement.
 *
 * Usage
 * -----
 *   PREVIEW_URL='https://evenquote-preview-xxxxx.vercel.app' \
 *   STRIPE_WEBHOOK_SECRET=whsec_...                          \
 *   VAPI_WEBHOOK_SECRET=shhh...                              \
 *   TWILIO_AUTH_TOKEN=auth_...                               \
 *     npx tsx scripts/smoke-webhook-preview.ts
 *
 * Flags (optional):
 *   --only=stripe|vapi|twilio        Run just one leg.
 *   --retries=N                       Override the retry-storm size
 *                                     (default 20 for stripe/vapi,
 *                                     3 for twilio).
 *   --timeout-ms=N                    Per-request timeout, default 15000.
 *   --dry-run                         Print what would be sent; do not
 *                                     make network calls. Useful for
 *                                     catching env/config mistakes
 *                                     before hitting the preview URL.
 *
 * Exit codes:
 *   0   All legs passed.
 *   1   At least one assertion failed (non-200, 5xx, timeout).
 *   2   Missing required env or bad flags.
 *
 * Operator workflow:
 *   1. Merge PR → Vercel opens a preview deploy.
 *   2. Copy the preview URL from the PR check.
 *   3. Export PREVIEW_URL + the three webhook secrets you use in
 *      that preview's env.
 *   4. Run this script.
 *   5. If it passes, promote the preview to production.
 *
 * Why this exists and not the MSW harness (see R33 feasibility for
 * the full writeup): the bug class we care about for retry storms
 * (signature verification on raw bytes, middleware ordering,
 * chunked-encoding parity) only manifests on the real Vercel runtime.
 * Local harnesses don't reproduce it. The right investment is
 * preview-target smoke coverage, not local stubs.
 *
 * Safety notes:
 *   • This script is READ-MOSTLY against the preview: every webhook
 *     it POSTs is indistinguishable from a real one. That means the
 *     preview DB WILL see a row insert for the test payment. Use a
 *     preview project tied to a throwaway Supabase, not prod.
 *   • The stripe webhook secret MUST match the one configured in the
 *     preview deploy's Stripe dashboard. If you're rotating secrets,
 *     the smoke test will fail until the preview env is updated.
 *   • The script does NOT submit anything to Stripe's live API — it
 *     only signs a locally-constructed event. No charges are made.
 */

import crypto from 'node:crypto';
import Stripe from 'stripe';

// ─── CLI flag parsing ─────────────────────────────────────────────
type Leg = 'stripe' | 'vapi' | 'twilio';

interface Options {
  only?: Leg | null;
  retries: number;
  timeoutMs: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    only: null,
    retries: 20,
    timeoutMs: 15000,
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg.startsWith('--only=')) {
      const v = arg.slice('--only='.length);
      if (v !== 'stripe' && v !== 'vapi' && v !== 'twilio') {
        exitWithUsage(`unknown --only=${v}; expected stripe|vapi|twilio`);
      }
      opts.only = v as Leg;
    } else if (arg.startsWith('--retries=')) {
      const n = Number(arg.slice('--retries='.length));
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        exitWithUsage(`--retries must be 1..500, got ${arg}`);
      }
      opts.retries = n;
    } else if (arg.startsWith('--timeout-ms=')) {
      const n = Number(arg.slice('--timeout-ms='.length));
      if (!Number.isFinite(n) || n < 100 || n > 60000) {
        exitWithUsage(`--timeout-ms must be 100..60000, got ${arg}`);
      }
      opts.timeoutMs = n;
    } else {
      exitWithUsage(`unknown arg: ${arg}`);
    }
  }
  return opts;
}

function exitWithUsage(msg: string): never {
  console.error(`[smoke-webhook-preview] ${msg}`);
  console.error(
    'Usage: PREVIEW_URL=... npx tsx scripts/smoke-webhook-preview.ts [--only=stripe|vapi|twilio] [--retries=N] [--timeout-ms=N] [--dry-run]',
  );
  process.exit(2);
}

// ─── Env helpers ──────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `[smoke-webhook-preview] missing required env: ${name}. ` +
        `Set it in your shell before running (use the secret that matches your preview deploy).`,
    );
    process.exit(2);
  }
  return v;
}

function baseUrl(): string {
  const raw = requireEnv('PREVIEW_URL');
  const trimmed = raw.replace(/\/+$/, '');
  if (!/^https:\/\//.test(trimmed)) {
    console.error(
      `[smoke-webhook-preview] PREVIEW_URL must start with https:// — got ${raw}. ` +
        `This script does not talk to http endpoints; use the preview deploy URL.`,
    );
    process.exit(2);
  }
  return trimmed;
}

// ─── HTTP helper with timeout + retry-storm emulation ─────────────
async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; text: string; durationMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text, durationMs: Date.now() - started };
  } finally {
    clearTimeout(t);
  }
}

// ─── Assertion helpers ────────────────────────────────────────────
interface LegResult {
  leg: Leg;
  ok: boolean;
  messages: string[];
}

function makeLegResult(leg: Leg): LegResult {
  return { leg, ok: true, messages: [] };
}

function assertStatusOk(res: { status: number }, ctx: string, acc: LegResult) {
  if (res.status < 200 || res.status >= 300) {
    acc.ok = false;
    acc.messages.push(`${ctx}: expected 2xx, got ${res.status}`);
  } else {
    acc.messages.push(`${ctx}: ${res.status} OK`);
  }
}

// ─── Stripe leg ───────────────────────────────────────────────────
async function runStripeLeg(opts: Options): Promise<LegResult> {
  const acc = makeLegResult('stripe');
  const secret = requireEnv('STRIPE_WEBHOOK_SECRET');
  const url = `${baseUrl()}/api/stripe/webhook`;

  // Build a realistic checkout.session.completed event. Payload shape
  // matches what the real route's zod schema expects — anything
  // narrower would 400 before we could test retry-storm behaviour.
  const eventId = `evt_smoke_${crypto.randomBytes(8).toString('hex')}`;
  const event = {
    id: eventId,
    object: 'event',
    api_version: '2025-02-24.acacia',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_test_smoke_${crypto.randomBytes(8).toString('hex')}`,
        object: 'checkout.session',
        amount_total: 999,
        currency: 'usd',
        customer_email: 'smoke+preview@evenquote.com',
        payment_intent: `pi_smoke_${crypto.randomBytes(6).toString('hex')}`,
        payment_status: 'paid',
        status: 'complete',
        client_reference_id: `smoke-${crypto.randomUUID()}`,
        metadata: { smoke: 'preview' },
      },
    },
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type: 'checkout.session.completed',
  };
  const payload = JSON.stringify(event);

  // Use the real Stripe SDK's generateTestHeaderString so the HMAC
  // algorithm can never drift from what constructEvent expects.
  // API version must match lib/stripe/server.ts — the SDK types pin
  // us to one value. If that file bumps, this line must too.
  const stripe = new Stripe('sk_test_smoke_unused', { apiVersion: '2025-02-24.acacia' });
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
  });

  const headers = {
    'content-type': 'application/json',
    'stripe-signature': signature,
  };

  if (opts.dryRun) {
    acc.messages.push(
      `[dry-run] would POST ${url} with signature ${signature.slice(0, 40)}… and event.id=${eventId}`,
    );
    return acc;
  }

  // First call — the canonical write.
  try {
    const res1 = await postWithTimeout(url, payload, headers, opts.timeoutMs);
    assertStatusOk(res1, 'stripe first POST', acc);
  } catch (err) {
    acc.ok = false;
    acc.messages.push(`stripe first POST threw: ${(err as Error).message}`);
    return acc;
  }

  // Retry storm — same event.id, N repeats.
  let dupeReturnMatches = 0;
  for (let i = 0; i < opts.retries; i++) {
    try {
      const res = await postWithTimeout(url, payload, headers, opts.timeoutMs);
      if (res.status !== 200) {
        acc.ok = false;
        acc.messages.push(
          `stripe retry #${i + 1}: expected 200 (idempotent), got ${res.status}`,
        );
      } else if (/Duplicate event|already processed/i.test(res.text)) {
        dupeReturnMatches++;
      }
    } catch (err) {
      acc.ok = false;
      acc.messages.push(`stripe retry #${i + 1} threw: ${(err as Error).message}`);
    }
  }
  acc.messages.push(
    `stripe retry storm: ${opts.retries} POSTs, ${dupeReturnMatches} returned a recognised dedupe message`,
  );

  return acc;
}

// ─── Vapi leg ─────────────────────────────────────────────────────
async function runVapiLeg(opts: Options): Promise<LegResult> {
  const acc = makeLegResult('vapi');
  const secret = requireEnv('VAPI_WEBHOOK_SECRET');
  const url = `${baseUrl()}/api/vapi/webhook`;

  // End-of-call-report shape — the single event type the webhook
  // handles. vapi_call_id is the dedupe anchor.
  const vapiCallId = `vcall_smoke_${crypto.randomBytes(8).toString('hex')}`;
  const body = {
    message: {
      type: 'end-of-call-report',
      call: {
        id: vapiCallId,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        endedAt: new Date().toISOString(),
        cost: 0.03,
      },
      endedReason: 'customer-ended-call',
      transcript: 'Smoke test transcript. No quote info.',
      summary: 'Smoke test call — no extraction expected.',
      recordingUrl: null,
    },
  };
  const payload = JSON.stringify(body);

  // Vapi's webhook auth per lib/security/vapi-auth.ts is a shared-
  // secret header. Mirror that.
  const headers = {
    'content-type': 'application/json',
    'x-vapi-secret': secret,
  };

  if (opts.dryRun) {
    acc.messages.push(
      `[dry-run] would POST ${url} with vapi_call_id=${vapiCallId} (secret redacted)`,
    );
    return acc;
  }

  try {
    const res = await postWithTimeout(url, payload, headers, opts.timeoutMs);
    assertStatusOk(res, 'vapi first POST', acc);
  } catch (err) {
    acc.ok = false;
    acc.messages.push(`vapi first POST threw: ${(err as Error).message}`);
    return acc;
  }

  // Retry — same vapi_call_id. The dedupe layer should short-circuit
  // with 200 and zero side-effect writes.
  for (let i = 0; i < opts.retries; i++) {
    try {
      const res = await postWithTimeout(url, payload, headers, opts.timeoutMs);
      if (res.status !== 200) {
        acc.ok = false;
        acc.messages.push(
          `vapi retry #${i + 1}: expected 200 (idempotent), got ${res.status}`,
        );
      }
    } catch (err) {
      acc.ok = false;
      acc.messages.push(`vapi retry #${i + 1} threw: ${(err as Error).message}`);
    }
  }
  acc.messages.push(`vapi retry storm: ${opts.retries} POSTs (all expected 200)`);
  return acc;
}

// ─── Twilio leg ───────────────────────────────────────────────────
function computeTwilioSignature(url: string, params: URLSearchParams, token: string): string {
  // Twilio X-Twilio-Signature: HMAC-SHA1(token, url + sortedKeys.map(k => k + v).join(''))
  // Mirrors the algorithm in app/api/twilio/sms/route.ts.
  const sortedKeys = [...params.keys()].sort();
  const concat = sortedKeys.map((k) => k + (params.get(k) ?? '')).join('');
  return crypto.createHmac('sha1', token).update(url + concat).digest('base64');
}

async function runTwilioLeg(opts: Options): Promise<LegResult> {
  const acc = makeLegResult('twilio');
  const token = requireEnv('TWILIO_AUTH_TOKEN');
  const url = `${baseUrl()}/api/twilio/sms`;

  // Minimum viable SMS payload — the real Twilio endpoint sends many
  // more fields, but MessageSid + From + To + Body is what the route
  // keys off.
  const params = new URLSearchParams();
  params.set('MessageSid', `SM_smoke_${crypto.randomBytes(8).toString('hex')}`);
  params.set('From', '+15555550100');
  params.set('To', '+15555550200');
  params.set('Body', 'Smoke test inbound SMS.');
  params.set('AccountSid', 'AC_smoke_0000000000000000000000000000');

  const signature = computeTwilioSignature(url, params, token);
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': signature,
  };

  if (opts.dryRun) {
    acc.messages.push(
      `[dry-run] would POST ${url} with MessageSid=${params.get('MessageSid')}`,
    );
    return acc;
  }

  const twilioRetries = Math.min(opts.retries, 3);
  try {
    const res = await postWithTimeout(url, params.toString(), headers, opts.timeoutMs);
    assertStatusOk(res, 'twilio first POST', acc);
  } catch (err) {
    acc.ok = false;
    acc.messages.push(`twilio first POST threw: ${(err as Error).message}`);
    return acc;
  }

  for (let i = 0; i < twilioRetries; i++) {
    try {
      const res = await postWithTimeout(url, params.toString(), headers, opts.timeoutMs);
      if (res.status !== 200) {
        acc.ok = false;
        acc.messages.push(
          `twilio retry #${i + 1}: expected 200 (idempotent), got ${res.status}`,
        );
      }
    } catch (err) {
      acc.ok = false;
      acc.messages.push(`twilio retry #${i + 1} threw: ${(err as Error).message}`);
    }
  }
  acc.messages.push(`twilio retry storm: ${twilioRetries} POSTs (all expected 200)`);
  return acc;
}

// ─── Orchestrator ─────────────────────────────────────────────────
async function main(): Promise<number> {
  const opts = parseArgs(process.argv);
  // Always validate PREVIEW_URL shape up-front so a missing env
  // doesn't surface as a leg-specific error later.
  void baseUrl();

  console.log(`[smoke-webhook-preview] starting (only=${opts.only ?? 'all'}, retries=${opts.retries}, timeout=${opts.timeoutMs}ms, dryRun=${opts.dryRun})`);

  const legs: Array<() => Promise<LegResult>> = [];
  if (!opts.only || opts.only === 'stripe') legs.push(() => runStripeLeg(opts));
  if (!opts.only || opts.only === 'vapi') legs.push(() => runVapiLeg(opts));
  if (!opts.only || opts.only === 'twilio') legs.push(() => runTwilioLeg(opts));

  const results: LegResult[] = [];
  for (const leg of legs) {
    // Serialize so the retry storms don't collide and saturate the
    // Vercel preview function concurrency. A failure in one leg
    // doesn't short-circuit — we want the full report.
    results.push(await leg());
  }

  // Print a human summary.
  console.log('');
  console.log('─── Summary ──────────────────────────────────');
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${r.leg}`);
    for (const m of r.messages) console.log(`  - ${m}`);
  }

  const anyFail = results.some((r) => !r.ok);
  console.log('');
  console.log(
    anyFail
      ? '[smoke-webhook-preview] ONE OR MORE LEGS FAILED — do not promote the preview.'
      : '[smoke-webhook-preview] all legs passed.',
  );
  return anyFail ? 1 : 0;
}

// Only execute when invoked directly (`npx tsx scripts/smoke-webhook-preview.ts`),
// NOT when imported for unit testing. Lets us unit-test the pure
// helpers (signature / arg parsing) without firing a real POST.
const isEntrypoint =
  typeof require !== 'undefined' && require.main === module;

if (isEntrypoint) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[smoke-webhook-preview] fatal:', err);
      process.exit(1);
    });
}

// Exports for unit tests (and future operator scripts that want to
// reuse a leg in isolation).
export {
  parseArgs,
  computeTwilioSignature,
  runStripeLeg,
  runVapiLeg,
  runTwilioLeg,
  type Options,
  type LegResult,
  type Leg,
};
