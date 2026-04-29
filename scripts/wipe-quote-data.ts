#!/usr/bin/env -S npx tsx
// Pre-launch admin reset.
//
// DELETES every quote_request + dependent calls/quotes/payments rows so
// the admin starts fresh. KEEPS businesses (your seeded movers/cleaners),
// service_categories, profiles, auth users.
//
// Uses SUPABASE_SERVICE_ROLE_KEY (already in .env.local) — no PAT or
// management API needed. Service role bypasses RLS.
//
// Usage (from repo root):
//   npx tsx scripts/wipe-quote-data.ts
//
// Refuses to run unless you confirm by passing the YES_WIPE flag:
//   YES_WIPE=1 npx tsx scripts/wipe-quote-data.ts
//
// Prints before/after counts and exits non-zero if any leftover rows
// remain. Idempotent — re-running on an already-empty DB is a no-op.

import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!URL || !SR) die('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');

if (process.env.YES_WIPE !== '1') {
  console.error('✗ Refusing to wipe without confirmation.');
  console.error('  This will DELETE every row in: payments, quotes, calls, quote_requests.');
  console.error('  Re-run with: YES_WIPE=1 npx tsx scripts/wipe-quote-data.ts');
  process.exit(2);
}

const admin = createClient(URL, SR, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function countAll(): Promise<Record<string, number>> {
  const tables = ['quote_requests', 'calls', 'quotes', 'payments', 'businesses'] as const;
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count, error } = await admin
      .from(t)
      .select('*', { count: 'exact', head: true });
    if (error) die(`count ${t} failed: ${error.message}`);
    out[t] = count ?? 0;
  }
  return out;
}

async function wipeTable(table: string): Promise<number> {
  // Supabase requires a filter on every .delete() to guard against
  // accidental nuke-everything calls. We satisfy the guard with a
  // tautology (id is not null) — every row has a uuid id.
  const { error, count } = await admin
    .from(table)
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (error) die(`wipe ${table} failed: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<void> {
  console.log('▸ BEFORE:');
  const before = await countAll();
  for (const [k, v] of Object.entries(before)) console.log(`    ${k}: ${v}`);

  // Order matters: drop dependents before parents to avoid FK
  // restrict errors. payments → quotes → calls → quote_requests.
  console.log('▸ Wiping…');
  const wPayments = await wipeTable('payments');
  console.log(`    payments deleted: ${wPayments}`);
  const wQuotes = await wipeTable('quotes');
  console.log(`    quotes deleted: ${wQuotes}`);
  const wCalls = await wipeTable('calls');
  console.log(`    calls deleted: ${wCalls}`);
  const wRequests = await wipeTable('quote_requests');
  console.log(`    quote_requests deleted: ${wRequests}`);

  console.log('▸ AFTER:');
  const after = await countAll();
  for (const [k, v] of Object.entries(after)) console.log(`    ${k}: ${v}`);

  const leftover = ['quote_requests', 'calls', 'quotes', 'payments']
    .filter((t) => after[t] > 0);
  if (leftover.length) {
    die(`Leftover rows in ${leftover.join(', ')} — wipe incomplete.`);
  }

  console.log('✓ Wipe complete. businesses + categories + profiles preserved.');
}

main().catch((err) => {
  console.error('✗ Unexpected failure:', err);
  process.exit(1);
});
