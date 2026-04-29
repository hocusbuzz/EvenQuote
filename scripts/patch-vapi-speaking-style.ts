#!/usr/bin/env -S npx tsx
// Two coordinated Vapi assistant tweaks shipped together because both
// surfaced in the same first-call test:
//
//   1. Append a "SPEAKING STYLE" block to the system prompt so the AI
//      agent doesn't read prices with decimal cents on calls. The
//      block has a sentinel marker — re-running is a no-op.
//
//   2. Replace the firstMessage so the agent leads with WHO they're
//      calling for (city/state) BEFORE the AI disclosure, and ends
//      with a softer time-bound ("usually under three minutes")
//      instead of a hard "under four minutes" cap.
//
// Why a Vapi-side patch (not a code/SQL change)? The system prompt and
// firstMessage are the only durable channels the assistant carries
// into every call. The per-vertical call_script_template in
// service_categories is rendered into a {{variable}} block; speaking
// style + opening line belong at the assistant level.
//
// Usage (from repo root, with .env.local already populated):
//   npx tsx scripts/patch-vapi-speaking-style.ts
//
// Prints before / after for both fields so the change is auditable.
// Errors loudly if Vapi rejects the PATCH.

import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!VAPI_API_KEY) die('VAPI_API_KEY not set in .env.local.');
if (!ASSISTANT_ID) die('VAPI_ASSISTANT_ID not set in .env.local.');

// Sentinel marker — present in the appended block. Re-running the
// script after a successful patch becomes a no-op, so it's safe to
// schedule, batch, or accidentally double-fire.
const SENTINEL = '<!-- speaking-style:v1 -->';

const APPENDED = `

${SENTINEL}
## SPEAKING STYLE

These rules govern HOW the agent says things on a call. They do not
change what info is collected.

- Say prices in plain spoken English. NO decimals, NO cents — round
  every dollar amount to a whole number. Examples:
    • "$2,500.00" → say "twenty-five hundred dollars" or "two thousand five hundred dollars"
    • "$1,899.50" → say "about nineteen hundred dollars" or "around nineteen hundred"
    • "$150–$200/hr" → say "one fifty to two hundred an hour"
- For ranges, prefer the natural form ("between X and Y", "around X to Y").
- Never say ".zero zero" or "and zero cents" — drop them entirely.
- For hourly rates, say "an hour" not "per hour" unless the mover used
  "per hour" first.
- If the mover quoted with cents, paraphrase to whole dollars when
  repeating it back ("so about twenty-five hundred, got it").
- Capture the EXACT figure (with cents) in your end-of-call structured
  output. The "no cents" rule is for the spoken summary only — the
  data we record stays precise.
`;

// New firstMessage. Reorders the existing line so the agent leads
// with WHO they're calling for (city/state — populated via Vapi's
// {{variable}} expansion at call time), then discloses AI, then
// states the soft time bound. Drops the hard "under four minutes"
// in favor of "usually under three minutes" — the maxDuration cap
// is still 240s on the call body, this is just spoken framing.
const NEW_FIRST_MESSAGE =
  "Hi, I'm calling on behalf of a real customer in {{city}}, {{state}} who's looking for a quote. Quick heads-up — by law I have to disclose I'm an AI assistant. This usually takes under three minutes. Is now a quick good time?";

async function main(): Promise<void> {
  const base = `https://api.vapi.ai/assistant/${ASSISTANT_ID}`;
  const headers = {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // 1. Read current assistant.
  const getRes = await fetch(base, { headers });
  if (!getRes.ok) die(`GET assistant failed: HTTP ${getRes.status} — ${await getRes.text()}`);
  const a = (await getRes.json()) as {
    id: string;
    firstMessage?: string;
    model?: { messages?: Array<{ role: string; content: string }> };
  };

  const messages = a.model?.messages ?? [];
  const sysIdx = messages.findIndex((m) => m.role === 'system');
  if (sysIdx < 0) die('Assistant has no system message — refusing to overwrite.');

  const before = messages[sysIdx].content;
  console.log(`▸ Assistant: ${a.id}`);
  console.log(`▸ Current system prompt: ${before.length} chars`);
  console.log(`▸ Current firstMessage: ${(a.firstMessage ?? '').slice(0, 120)}${(a.firstMessage ?? '').length > 120 ? '…' : ''}`);

  const styleAlreadyPatched = before.includes(SENTINEL);
  const firstMessageAlreadyPatched = a.firstMessage === NEW_FIRST_MESSAGE;

  if (styleAlreadyPatched && firstMessageAlreadyPatched) {
    console.log('✓ Both speaking-style block and firstMessage already current — no-op.');
    return;
  }

  const after = styleAlreadyPatched ? before : before + APPENDED;
  if (!styleAlreadyPatched) {
    console.log(`▸ Appending ${APPENDED.length} chars to system prompt (sentinel: ${SENTINEL}).`);
  } else {
    console.log('▸ Speaking-style block already present in system prompt — leaving unchanged.');
  }
  if (!firstMessageAlreadyPatched) {
    console.log(`▸ Replacing firstMessage with: ${NEW_FIRST_MESSAGE}`);
  } else {
    console.log('▸ firstMessage already current — leaving unchanged.');
  }

  // 2. PATCH back. Vapi expects a partial model object — we replace
  //    just the system message and leave model.provider / .model /
  //    .temperature etc. untouched.
  const patched = {
    ...a,
    firstMessage: NEW_FIRST_MESSAGE,
    model: {
      ...a.model,
      messages: messages.map((m, i) =>
        i === sysIdx ? { ...m, content: after } : m
      ),
    },
  };
  // Vapi's API rejects unknown top-level fields on PATCH (id, orgId,
  // createdAt, updatedAt, etc.). Strip them.
  const PATCH_ALLOWED = new Set([
    'name',
    'model',
    'voice',
    'transcriber',
    'firstMessage',
    'firstMessageMode',
    'voicemailMessage',
    'endCallMessage',
    'endCallPhrases',
    'serverUrl',
    'server',
    'silenceTimeoutSeconds',
    'maxDurationSeconds',
    'voicemailDetection',
    'voicemailDetectionEnabled',
    'recordingEnabled',
    'hipaaEnabled',
    'backgroundSound',
    'backchannelingEnabled',
    'startSpeakingPlan',
    'stopSpeakingPlan',
    'analysisPlan',
    'artifactPlan',
    'messagePlan',
    'monitorPlan',
    'modelOutputInMessagesEnabled',
    'transportConfigurations',
    'observabilityPlan',
    'metadata',
  ]);
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patched)) {
    if (PATCH_ALLOWED.has(k)) body[k] = v;
  }

  const patchRes = await fetch(base, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  if (!patchRes.ok) {
    die(`PATCH assistant failed: HTTP ${patchRes.status} — ${(await patchRes.text()).slice(0, 600)}`);
  }
  const updated = (await patchRes.json()) as {
    firstMessage?: string;
    model?: { messages?: Array<{ role: string; content: string }> };
  };
  const newPrompt = updated.model?.messages?.find((m) => m.role === 'system')?.content ?? '';
  console.log(`✓ Patched. New system prompt: ${newPrompt.length} chars.`);
  console.log(`✓ New firstMessage: ${updated.firstMessage}`);
  if (!newPrompt.includes(SENTINEL)) {
    die('PATCH succeeded but sentinel missing in response — verify in Vapi dashboard.');
  }
  if (updated.firstMessage !== NEW_FIRST_MESSAGE) {
    die('PATCH succeeded but firstMessage did not stick — verify in Vapi dashboard.');
  }
  console.log('✓ Sentinel + firstMessage both confirmed in updated assistant.');
}

main().catch((err) => {
  console.error('✗ Unexpected failure:', err);
  process.exit(1);
});
