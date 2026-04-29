#!/usr/bin/env -S npx tsx
// Pre-flight readiness check for the soft launch.
//
// Hits every external dependency with a tiny live request and reports
// whether your credentials are valid + the account state is launch-ready.
// Designed to run BEFORE the Vercel deploy so the dumb config problems
// (wrong key, test mode left on, expired token, unfunded balance,
// Resend domain unverified) surface here, not in a customer flow.
//
// Usage (from repo root):
//   npx tsx scripts/launch-readiness.ts
//
// Optional flags:
//   --strict       — exit non-zero on any warning (not just errors).
//                    Use in CI / pre-deploy hook.
//   --skip-stripe  — skip Stripe checks (e.g. during initial setup
//                    before live keys exist).
//   --skip-vapi    — skip Vapi checks (simulation-mode launch).
//
// Each check has three possible outcomes:
//   ✓ pass    — credential works, account is in a launch-ready state.
//   ⚠ warn    — works but not optimal (e.g. Stripe still in test mode,
//                low Vapi balance). Don't block, but flag.
//   ✗ fail    — broken. Won't work in prod. Fix before deploy.
//
// Exit code:
//   0  — everything passes (or only warnings without --strict)
//   1  — any failures
//   2  — any warnings + --strict

import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

const STRICT = process.argv.includes('--strict');
const SKIP_STRIPE = process.argv.includes('--skip-stripe');
const SKIP_VAPI = process.argv.includes('--skip-vapi');

type Outcome = 'pass' | 'warn' | 'fail';
type Check = { name: string; outcome: Outcome; detail: string };

const checks: Check[] = [];
function add(name: string, outcome: Outcome, detail: string): void {
  checks.push({ name, outcome, detail });
}

const sym = (o: Outcome): string =>
  o === 'pass' ? '\x1b[32m✓\x1b[0m' : o === 'warn' ? '\x1b[33m⚠\x1b[0m' : '\x1b[31m✗\x1b[0m';

// ─── 1. Required env vars ──────────────────────────────────────────
function checkEnv(): void {
  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_APP_URL',
  ];
  const prodRequired = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CRON_SECRET',
    'RESEND_API_KEY',
    'RESEND_FROM',
  ];

  for (const k of required) {
    if (!process.env[k]) {
      add(`env:${k}`, 'fail', 'missing — required everywhere');
    } else {
      add(`env:${k}`, 'pass', 'set');
    }
  }
  for (const k of prodRequired) {
    if (!process.env[k]) {
      add(`env:${k}`, 'warn', 'missing — required in production (set in Vercel)');
    } else {
      add(`env:${k}`, 'pass', 'set');
    }
  }

  // The big landmine: TEST_OVERRIDE_PHONE in prod = every call goes to
  // your phone. Fail loudly if it's set in .env.local AND you're
  // running this against a prod-shaped URL.
  if (process.env.TEST_OVERRIDE_PHONE) {
    const url = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const looksProd = /\bevenquote\.com\b/.test(url) && !url.includes('localhost');
    add(
      'env:TEST_OVERRIDE_PHONE',
      looksProd ? 'fail' : 'warn',
      looksProd
        ? 'SET while APP_URL points at prod — every customer call would route to this number. Remove before deploy.'
        : `set to ${process.env.TEST_OVERRIDE_PHONE} — fine in dev, but DO NOT add to Vercel prod env`
    );
  }

  // Stripe key shape — sk_live_ vs sk_test_
  const sk = process.env.STRIPE_SECRET_KEY ?? '';
  if (sk.startsWith('sk_test_')) {
    add('stripe:mode', 'warn', 'using test key (sk_test_…) — switch to sk_live_… for launch');
  } else if (sk.startsWith('sk_live_')) {
    add('stripe:mode', 'pass', 'live key');
  }
}

// ─── 2. Supabase (DB + critical schema) ────────────────────────────
async function checkSupabase(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sr) {
    add('supabase:reach', 'fail', 'missing URL or service-role key');
    return;
  }

  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, sr, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Hits /rest with a HEAD count — cheapest possible round-trip.
  const tables = [
    'quote_requests',
    'calls',
    'quotes',
    'payments',
    'businesses',
    'service_categories',
    'profiles',
  ];
  for (const t of tables) {
    const { error } = await admin
      .from(t)
      .select('*', { count: 'exact', head: true });
    if (error) add(`supabase:${t}`, 'fail', error.message);
    else add(`supabase:${t}`, 'pass', 'reachable');
  }

  // R47 columns must exist — early-warning for the on-demand seeder.
  const { data, error } = await admin
    .from('quote_requests')
    .select('id, origin_lat, origin_lng, businesses_seeded_at')
    .limit(0);
  if (error) {
    add('supabase:r47-columns', 'fail', `migration 0011 not applied: ${error.message}`);
  } else {
    void data;
    add('supabase:r47-columns', 'pass', 'origin_lat/lng + businesses_seeded_at present');
  }
}

// ─── 3. Stripe ─────────────────────────────────────────────────────
async function checkStripe(): Promise<void> {
  if (SKIP_STRIPE) return;
  const sk = process.env.STRIPE_SECRET_KEY;
  if (!sk) {
    add('stripe:auth', 'warn', 'STRIPE_SECRET_KEY missing — skipping');
    return;
  }
  const res = await fetch('https://api.stripe.com/v1/account', {
    headers: { Authorization: `Bearer ${sk}` },
  });
  if (!res.ok) {
    add('stripe:auth', 'fail', `HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 100))}`);
    return;
  }
  const acct = (await res.json()) as {
    id?: string;
    charges_enabled?: boolean;
    details_submitted?: boolean;
    business_profile?: { url?: string };
  };
  add('stripe:auth', 'pass', `account ${acct.id}`);
  if (!acct.charges_enabled) {
    add('stripe:charges-enabled', 'fail', 'account cannot accept charges yet (KYC incomplete?)');
  } else {
    add('stripe:charges-enabled', 'pass', 'charges enabled');
  }
}

// ─── 4. Resend ─────────────────────────────────────────────────────
async function checkResend(): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    add('resend:auth', 'warn', 'RESEND_API_KEY missing — skipping');
    return;
  }
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    add('resend:auth', 'fail', `HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 100))}`);
    return;
  }
  const body = (await res.json()) as { data?: Array<{ name: string; status: string }> };
  add('resend:auth', 'pass', `${body.data?.length ?? 0} domain(s) on account`);

  const from = process.env.RESEND_FROM ?? '';
  const fromMatch = from.match(/[\w.+-]+@([\w.-]+)/);
  const fromDomain = fromMatch?.[1];
  if (fromDomain) {
    const domain = body.data?.find((d) => d.name === fromDomain);
    if (!domain) {
      add(
        'resend:from-domain',
        'fail',
        `RESEND_FROM domain "${fromDomain}" is not in your Resend account — emails will fail`
      );
    } else if (domain.status !== 'verified') {
      add(
        'resend:from-domain',
        'fail',
        `domain "${fromDomain}" status is "${domain.status}" — emails will land in spam until verified`
      );
    } else {
      add('resend:from-domain', 'pass', `${fromDomain} verified`);
    }
  }
}

// ─── 5. Vapi ───────────────────────────────────────────────────────
async function checkVapi(): Promise<void> {
  if (SKIP_VAPI) return;
  const key = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!key) {
    add('vapi:auth', 'warn', 'VAPI_API_KEY missing — simulation mode');
    return;
  }
  // Assistant fetch doubles as auth check — this is cheaper than
  // hitting /account and gives us the server.url at the same time.
  if (!assistantId) {
    add('vapi:assistant', 'fail', 'VAPI_ASSISTANT_ID missing');
    return;
  }
  const res = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    add('vapi:auth', 'fail', `HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 100))}`);
    return;
  }
  const a = (await res.json()) as { id?: string; server?: { url?: string }; firstMessage?: string };
  add('vapi:auth', 'pass', `assistant ${a.id}`);

  const serverUrl = a.server?.url ?? '';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  if (!serverUrl) {
    add('vapi:server-url', 'fail', 'assistant has no server.url — webhooks will not fire');
  } else if (
    appUrl.startsWith('https://evenquote.com') &&
    !serverUrl.startsWith('https://evenquote.com')
  ) {
    add(
      'vapi:server-url',
      'fail',
      `assistant.server.url=${serverUrl} doesn't match prod APP_URL — run scripts/patch-vapi-tunnel-url.ts ${appUrl}`
    );
  } else {
    add('vapi:server-url', 'pass', serverUrl);
  }

  // First-message sanity — should reference {{city}}/{{state}} after R47.
  const fm = a.firstMessage ?? '';
  if (fm && !fm.includes('{{city}}')) {
    add(
      'vapi:first-message',
      'warn',
      'firstMessage does not reference {{city}} — re-run scripts/patch-vapi-speaking-style.ts'
    );
  } else if (fm) {
    add('vapi:first-message', 'pass', 'references {{city}}');
  }
}

// ─── 6. Google Places ──────────────────────────────────────────────
async function checkPlaces(): Promise<void> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    add('places:auth', 'warn', 'GOOGLE_PLACES_API_KEY missing — on-demand seeding disabled');
    return;
  }
  // Trivial searchText with a cheap field mask.
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id',
    },
    body: JSON.stringify({ textQuery: 'movers near 92008', pageSize: 1 }),
  });
  if (!res.ok) {
    const body = await res.text();
    add('places:auth', 'fail', `HTTP ${res.status}: ${body.slice(0, 200)}`);
    return;
  }
  const data = (await res.json()) as { places?: unknown[] };
  add('places:auth', 'pass', `returned ${data.places?.length ?? 0} place(s)`);
}

// ─── 7. Anthropic ──────────────────────────────────────────────────
async function checkAnthropic(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    add('anthropic:auth', 'warn', 'ANTHROPIC_API_KEY missing — quote extraction disabled');
    return;
  }
  // Tiny tool-use call so we exercise the same code path the extractor uses.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_EXTRACTION_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    }),
  });
  if (!res.ok) {
    add('anthropic:auth', 'fail', `HTTP ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
    return;
  }
  const data = (await res.json()) as { model?: string };
  add('anthropic:auth', 'pass', `model ${data.model ?? 'unknown'} responded`);
}

// ─── Main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('▸ Running pre-launch readiness checks…\n');

  checkEnv();
  await checkSupabase();
  await Promise.all([
    checkStripe(),
    checkResend(),
    checkVapi(),
    checkPlaces(),
    checkAnthropic(),
  ]);

  // ── Print results grouped by integration prefix ──
  const groups = new Map<string, Check[]>();
  for (const c of checks) {
    const prefix = c.name.split(':')[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(c);
  }

  for (const [g, cs] of groups) {
    console.log(`\x1b[1m${g}\x1b[0m`);
    for (const c of cs) {
      console.log(`  ${sym(c.outcome)} ${c.name.replace(g + ':', '')} — ${c.detail}`);
    }
  }

  const fails = checks.filter((c) => c.outcome === 'fail').length;
  const warns = checks.filter((c) => c.outcome === 'warn').length;
  const passes = checks.filter((c) => c.outcome === 'pass').length;

  console.log(
    `\n\x1b[1mSummary:\x1b[0m ${sym('pass')} ${passes} passed · ${sym('warn')} ${warns} warning(s) · ${sym('fail')} ${fails} failure(s)`
  );

  if (fails > 0) {
    console.log('\n\x1b[31mNot launch-ready.\x1b[0m Fix the failures above and re-run.');
    process.exit(1);
  }
  if (warns > 0 && STRICT) {
    console.log('\n\x1b[33m--strict\x1b[0m: warnings present, exiting non-zero.');
    process.exit(2);
  }
  console.log('\n\x1b[32mLaunch-ready.\x1b[0m');
}

main().catch((err) => {
  console.error('✗ Unexpected failure:', err);
  process.exit(1);
});
