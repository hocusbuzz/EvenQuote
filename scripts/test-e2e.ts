/**
 * End-to-end happy-path walker for EvenQuote.
 *
 * Drives the full post-checkout pipeline against your local dev DB
 * without needing to click through the browser or run the real Vapi
 * dialer. What it does:
 *
 *   1. Picks a service_category + N businesses (default 3) from your
 *      seed data.
 *   2. Inserts a quote_request with status='paid' (simulating a
 *      successful Stripe checkout).
 *   3. Inserts matching calls rows in status='queued'.
 *   4. Walks each call through a synthetic end-of-call-report by
 *      POSTing to /api/vapi/webhook (the same path Vapi would hit) —
 *      so the real webhook runs, extraction runs, apply_call_end
 *      bumps counters, and the request transitions to 'processing' →
 *      'completed' naturally.
 *   5. Optionally hits /api/cron/send-reports so you can watch the
 *      email path fire.
 *
 * Usage:
 *   npx tsx scripts/test-e2e.ts
 *   npx tsx scripts/test-e2e.ts --zero-quotes   # drive refund path
 *   npx tsx scripts/test-e2e.ts --skip-cron
 *
 * Requires the dev server running on :3000 and .env.local with
 * Supabase + VAPI_WEBHOOK_SECRET (+ CRON_SECRET if --skip-cron is
 * not passed).
 *
 * Exits 0 on success, 1 on any failure. Cleans up nothing — the rows
 * it creates are real and stay in your dev DB so you can inspect them.
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPI_SECRET = process.env.VAPI_WEBHOOK_SECRET ?? 'whsec_local_dev';
const CRON_SECRET = process.env.CRON_SECRET;

const args = new Set(process.argv.slice(2));
const ZERO_QUOTES = args.has('--zero-quotes');
const SKIP_CRON = args.has('--skip-cron');
const CALL_BATCH_SIZE = Number(process.env.CALL_BATCH_SIZE ?? 3);

if (!SUPABASE_URL || !SERVICE_ROLE) {
  fail('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
}

const admin: SupabaseClient = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  log('1/5  Pick seed data');
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('id, slug, name')
    .limit(1)
    .single();
  if (catErr || !category) fail(`no service_categories found: ${catErr?.message ?? 'empty'}`);
  log(`     category=${category.slug} (${category.id})`);

  const { data: businesses, error: bizErr } = await admin
    .from('businesses')
    .select('id, name, phone')
    .eq('category_id', category.id)
    .limit(CALL_BATCH_SIZE);
  if (bizErr || !businesses || businesses.length === 0)
    fail(`no businesses for category: ${bizErr?.message ?? 'empty'}`);
  log(`     ${businesses.length} businesses: ${businesses.map((b) => b.name).join(', ')}`);

  log('2/5  Insert quote_request (status=paid, simulating Stripe success)');
  const requestId = randomUUID();
  const intake = {
    moveFromZip: '94610',
    moveToZip: '94102',
    bedrooms: 2,
    moveDate: '2026-05-10',
    contactEmail: 'e2e-test@example.com',
    contactPhone: '+15555550123',
  };
  const { error: qrErr } = await admin.from('quote_requests').insert({
    id: requestId,
    category_id: category.id,
    intake_data: intake,
    contact_email: intake.contactEmail,
    status: 'paid',
    stripe_session_id: `cs_test_e2e_${Date.now()}`,
    total_calls_planned: businesses.length,
    total_calls_completed: 0,
    total_quotes_collected: 0,
  });
  if (qrErr) fail(`quote_requests insert: ${qrErr.message}`);
  log(`     quote_request.id=${requestId}`);

  log('3/5  Insert calls (status=queued)');
  const callRows = businesses.map((b) => ({
    id: randomUUID(),
    quote_request_id: requestId,
    business_id: b.id,
    vapi_call_id: `e2e-vapi-${randomUUID()}`,
    status: 'queued',
  }));
  const { error: callsErr } = await admin.from('calls').insert(callRows);
  if (callsErr) fail(`calls insert: ${callsErr.message}`);
  log(`     ${callRows.length} calls queued`);

  log(`4/5  Simulate end-of-call-report for each (mode=${ZERO_QUOTES ? 'no_answer' : 'completed'})`);
  for (const [i, c] of callRows.entries()) {
    const res = await postEndOfCallReport(c.vapi_call_id, ZERO_QUOTES ? 'no_answer' : 'completed');
    log(`     [${i + 1}/${callRows.length}] vapi_call_id=${c.vapi_call_id} → HTTP ${res.status} ${res.bodyPreview}`);
    if (!res.ok) fail(`webhook returned non-2xx — is \`npm run dev\` running? is VAPI_WEBHOOK_SECRET matching?`);
  }

  // Give the RPC a beat to settle, then read back the request.
  await sleep(500);
  const { data: finalReq, error: finalErr } = await admin
    .from('quote_requests')
    .select('status, total_calls_completed, total_quotes_collected')
    .eq('id', requestId)
    .single();
  if (finalErr) fail(`quote_requests reread: ${finalErr.message}`);
  log(
    `     quote_request now: status=${finalReq.status}  calls_completed=${finalReq.total_calls_completed}  quotes=${finalReq.total_quotes_collected}`
  );

  if (SKIP_CRON) {
    log('5/5  Skipping cron (--skip-cron). Trigger manually when ready:');
    log(`     curl -H "x-cron-secret: \$CRON_SECRET" ${APP_URL}/api/cron/send-reports`);
  } else {
    if (!CRON_SECRET) {
      log('5/5  CRON_SECRET not set — skipping /api/cron/send-reports call.');
    } else {
      log('5/5  Fire /api/cron/send-reports');
      const r = await fetch(`${APP_URL}/api/cron/send-reports`, {
        method: 'POST',
        headers: { 'x-cron-secret': CRON_SECRET },
      });
      const body = await r.text();
      log(`     HTTP ${r.status}  ${body.slice(0, 200)}`);
    }
  }

  log('');
  log(`DONE. quote_request.id=${requestId}`);
  log(
    `Inspect:\n  select * from quote_requests where id='${requestId}';\n  select status, contact_name from quotes where quote_request_id='${requestId}';`
  );
}

// ── helpers ──────────────────────────────────────────────────────────

async function postEndOfCallReport(
  vapiCallId: string,
  outcome: 'completed' | 'no_answer' | 'refused' | 'failed'
): Promise<{ ok: boolean; status: number; bodyPreview: string }> {
  const payload = buildReport(vapiCallId, outcome);
  const r = await fetch(`${APP_URL}/api/vapi/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vapi-secret': VAPI_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, bodyPreview: body.slice(0, 120) };
}

function buildReport(vapiCallId: string, outcome: 'completed' | 'no_answer' | 'refused' | 'failed') {
  const base = {
    type: 'end-of-call-report' as const,
    call: { id: vapiCallId },
    recordingUrl: 'https://example.com/recordings/test.mp3',
    cost: 0.12,
  };

  switch (outcome) {
    case 'completed':
      return {
        message: {
          ...base,
          transcript:
            "AI: Hi, I'm calling for a moving quote, 2BR Oakland to SF on May 10.\n" +
            "Business: Sure, we've got that weekend. 3 hours, 2 movers — quote's $800 to $950 all in. No onsite needed. I'm Mike, mike@oaklandmovers.example.",
          summary:
            'Oakland Movers quoted $800-$950 for a 2BR Oakland→SF on May 10, no onsite estimate required.',
          durationSeconds: 142,
          endedReason: 'assistant-ended-call',
          analysis: {
            structuredData: {
              priceMin: 800,
              priceMax: 950,
              priceDescription: 'all-in, 2 movers + truck, ~3 hours',
              availability: 'May 10 weekend',
              includes: ['blankets', 'wrap'],
              excludes: ['boxes ($2 ea)'],
              notes: 'Confirmed no onsite estimate needed for a 2BR.',
              contactName: 'Mike',
              contactPhone: null,
              contactEmail: 'mike@oaklandmovers.example',
              requiresOnsiteEstimate: false,
              confidenceScore: 0.9,
            },
            successEvaluation: 'pass',
          },
        },
      };
    case 'no_answer':
      return {
        message: {
          ...base,
          transcript: '',
          summary: '',
          durationSeconds: 18,
          endedReason: 'voicemail-detected',
          analysis: { structuredData: null, successEvaluation: null },
        },
      };
    case 'refused':
      return {
        message: {
          ...base,
          transcript: '',
          summary: '',
          durationSeconds: 4,
          endedReason: 'customer-hungup',
          analysis: { structuredData: null, successEvaluation: null },
        },
      };
    case 'failed':
      return {
        message: {
          ...base,
          transcript: '',
          summary: '',
          durationSeconds: 0,
          endedReason: 'twilio-error-no-route',
          analysis: { structuredData: null, successEvaluation: null },
        },
      };
  }
}

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
