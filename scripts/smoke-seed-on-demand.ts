#!/usr/bin/env -S npx tsx
// Smoke test for the on-demand business seeder.
//
// What it does:
//   1. Spins up an admin Supabase client.
//   2. Creates a fresh moving quote_request in pending_payment with
//      Carlsbad, CA / 92008 origin coords (33.16, -117.35) so the
//      seeder has a real location to bias against.
//   3. POSTs to /api/dev/skip-payment, which:
//      a) flips the request to 'paid'
//      b) runs seedBusinessesForRequest()  ← what we're testing
//      c) runs enqueueQuoteCalls()
//   4. Reads back businesses_seeded_at + counts what the seeder
//      inserted/updated, then prints a one-screen summary.
//
// Usage (from repo root, with the dev server running on :3000):
//   npx tsx scripts/smoke-seed-on-demand.ts
//
// Optional env:
//   APP_URL           — default http://localhost:3000
//   DEV_TRIGGER_TOKEN — only needed if .env.local sets one
//
// Idempotent: each run creates a NEW quote_request — does not reuse
// or touch existing rows. Safe to run repeatedly.

import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';
const DEV_TOKEN = process.env.DEV_TRIGGER_TOKEN ?? '';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_SR = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!SUPA_URL || !SUPA_SR) die('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');

const admin = createClient(SUPA_URL, SUPA_SR, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Wrapped in main() because tsx may transpile to CJS, and CJS does
// not support top-level await. The async IIFE pattern is portable.
async function main(): Promise<void> {

console.log('▸ Looking up moving category…');
const { data: cat, error: catErr } = await admin
  .from('service_categories')
  .select('id, slug, places_query_template')
  .eq('slug', 'moving')
  .single();
if (catErr || !cat) die(`category lookup failed: ${catErr?.message ?? 'not found'}`);
console.log(`  ✓ moving category id=${cat.id} template="${cat.places_query_template}"`);

console.log('▸ Creating a fresh test quote_request in Carlsbad, 92008…');
const intake = {
  origin_address: '2825 State St',
  origin_city: 'Carlsbad',
  origin_state: 'CA',
  origin_zip: '92008',
  origin_lat: 33.16,
  origin_lng: -117.35,
  destination_address: '2825 State St',
  destination_city: 'Carlsbad',
  destination_state: 'CA',
  destination_zip: '92008',
  destination_lat: 33.16,
  destination_lng: -117.35,
  home_size: '2 bedroom',
  move_date: '2026-12-01',
  flexible_dates: true,
  special_items: [],
  contact_name: 'Smoke Test',
  contact_phone: '+15555550100',
  contact_email: 'smoke@example.com',
};
const { data: created, error: createErr } = await admin
  .from('quote_requests')
  .insert({
    user_id: null,
    category_id: cat.id,
    status: 'pending_payment',
    intake_data: intake,
    city: 'Carlsbad',
    state: 'CA',
    zip_code: '92008',
    origin_lat: 33.16,
    origin_lng: -117.35,
  })
  .select('id')
  .single();
if (createErr || !created) die(`create quote_request failed: ${createErr?.message ?? 'no row'}`);
console.log(`  ✓ quote_request id=${created.id}`);

console.log(`▸ Counting businesses for moving in 92008 BEFORE…`);
const beforeQ = await admin
  .from('businesses')
  .select('id', { count: 'exact', head: true })
  .eq('category_id', cat.id)
  .eq('zip_code', '92008');
const before = beforeQ.count ?? 0;
console.log(`  ✓ before: ${before} business(es) in zip 92008`);

console.log(`▸ POST ${APP_URL}/api/dev/skip-payment…`);
const url = new URL('/api/dev/skip-payment', APP_URL);
if (DEV_TOKEN) url.searchParams.set('token', DEV_TOKEN);
const res = await fetch(url.toString(), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ quote_request_id: created.id }),
});
const text = await res.text();
console.log(`  HTTP ${res.status}`);
console.log(`  ${text.slice(0, 800)}${text.length > 800 ? '… (truncated)' : ''}`);
if (!res.ok) die(`skip-payment failed: HTTP ${res.status}`);

console.log(`▸ Reading sentinel + counting businesses AFTER…`);
const { data: after, error: afterErr } = await admin
  .from('quote_requests')
  .select('businesses_seeded_at')
  .eq('id', created.id)
  .single();
if (afterErr) die(`sentinel read failed: ${afterErr.message}`);
const afterQ = await admin
  .from('businesses')
  .select('id', { count: 'exact', head: true })
  .eq('category_id', cat.id)
  .eq('zip_code', '92008');
const afterCount = afterQ.count ?? 0;

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  SMOKE TEST RESULT');
console.log('═══════════════════════════════════════════');
console.log(`  quote_request_id:        ${created.id}`);
console.log(`  businesses_seeded_at:    ${after.businesses_seeded_at ?? 'NULL (seeder did NOT stamp)'}`);
console.log(`  businesses in 92008:     ${before} → ${afterCount}  (${afterCount - before >= 0 ? '+' : ''}${afterCount - before})`);
console.log('═══════════════════════════════════════════');

if (!after.businesses_seeded_at) {
  die('Seeder did not stamp the sentinel. Inspect the dev-server logs for the "seedOnDemand" namespace.');
}
console.log('✓ Seeder fired and stamped the sentinel.');
console.log(`Inspect the run in admin: ${APP_URL}/admin/requests/${created.id}`);

}

main().catch((err) => {
  console.error('✗ Unexpected failure:', err);
  process.exit(1);
});
