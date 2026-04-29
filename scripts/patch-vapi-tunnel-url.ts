#!/usr/bin/env -S npx tsx
// Update the Vapi assistants' webhook URLs to a fresh Cloudflare
// tunnel. Cloudflare's free `trycloudflare.com` URLs rotate every
// time `cloudflared` restarts, so during dev we have to re-point Vapi
// after every tunnel cycle — otherwise end-of-call webhooks vanish
// into a dead URL and calls hang in `in_progress` forever.
//
// What this patches:
//   • Outbound assistant (VAPI_ASSISTANT_ID) → server.url
//   • Inbound callback assistant (VAPI_INBOUND_ASSISTANT_ID, optional)
//     → server.url
//
// Path components:
//   • /api/vapi/webhook         — outbound end-of-call reports
//   • /api/vapi/inbound-callback — inbound caller-press routing
//
// Usage:
//   npx tsx scripts/patch-vapi-tunnel-url.ts https://NEW-URL.trycloudflare.com
//
// Idempotent: a re-run with the same URL is a no-op (and prints so).
// Errors loudly if Vapi rejects the PATCH.

import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const OUTBOUND_ID = process.env.VAPI_ASSISTANT_ID;
// Optional — if you don't have an inbound callback assistant set up,
// just leave this unset and the script skips that target.
const INBOUND_ID = process.env.VAPI_INBOUND_ASSISTANT_ID ?? '';

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!VAPI_API_KEY) die('VAPI_API_KEY not set in .env.local.');
if (!OUTBOUND_ID) die('VAPI_ASSISTANT_ID not set in .env.local.');

const arg = process.argv[2];
if (!arg) die('Usage: patch-vapi-tunnel-url.ts <https://NEW-URL.trycloudflare.com>');

let baseUrl: string;
try {
  const u = new URL(arg);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol must be http(s)');
  baseUrl = u.origin;
} catch (err) {
  die(`Invalid URL: ${arg} (${err instanceof Error ? err.message : err})`);
}

const OUTBOUND_PATH = '/api/vapi/webhook';
const INBOUND_PATH = '/api/vapi/inbound-callback';

async function patchAssistant(assistantId: string, hookPath: string, label: string): Promise<void> {
  const base = `https://api.vapi.ai/assistant/${assistantId}`;
  const headers = {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const newUrl = baseUrl + hookPath;

  console.log(`▸ [${label}] ${assistantId}`);

  const getRes = await fetch(base, { headers });
  if (!getRes.ok) die(`GET ${label} failed: HTTP ${getRes.status} — ${await getRes.text()}`);
  const a = (await getRes.json()) as {
    server?: { url?: string; timeoutSeconds?: number };
  };

  const oldUrl = a.server?.url ?? '(none)';
  console.log(`  current server.url: ${oldUrl}`);

  if (oldUrl === newUrl) {
    console.log(`  ✓ already pointing at ${newUrl} — no-op.`);
    return;
  }

  // Vapi's PATCH is shallow-merge on `server`, so we send the whole
  // server object. timeoutSeconds defaults to 20 — preserve whatever
  // was there (we set it to 20 in earlier sessions).
  const body = {
    server: {
      ...a.server,
      url: newUrl,
    },
  };

  const patchRes = await fetch(base, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  if (!patchRes.ok) {
    die(`PATCH ${label} failed: HTTP ${patchRes.status} — ${(await patchRes.text()).slice(0, 600)}`);
  }
  const updated = (await patchRes.json()) as { server?: { url?: string } };
  if (updated.server?.url !== newUrl) {
    die(`${label} PATCH succeeded but server.url did not stick — verify in Vapi dashboard.`);
  }
  console.log(`  ✓ updated to ${newUrl}`);
}

async function main(): Promise<void> {
  console.log(`▸ New tunnel base: ${baseUrl}`);
  await patchAssistant(OUTBOUND_ID!, OUTBOUND_PATH, 'outbound');
  if (INBOUND_ID) {
    await patchAssistant(INBOUND_ID, INBOUND_PATH, 'inbound-callback');
  } else {
    console.log('▸ VAPI_INBOUND_ASSISTANT_ID not set — skipping inbound-callback patch.');
  }
  console.log('✓ Done. End-of-call webhooks will now fire through the new tunnel.');
}

main().catch((err) => {
  console.error('✗ Unexpected failure:', err);
  process.exit(1);
});
