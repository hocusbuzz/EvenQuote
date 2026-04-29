#!/usr/bin/env -S npx tsx
// Apply a single SQL migration file to the live Supabase via the
// Management API.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_… \
//     npx tsx scripts/apply-migration.ts supabase/migrations/0011_quote_requests_origin_coords.sql
//
// The PAT is consumed from env so it never lands in shell history.
// Project ref is auto-derived from NEXT_PUBLIC_SUPABASE_URL in
// .env.local — no flag needed when run from the repo root.
//
// Designed for one-off ops moments when CI / dashboard isn't handy.
// Not a replacement for `supabase db push` once the local CLI is wired.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

// Load .env.local so NEXT_PUBLIC_SUPABASE_URL is populated.
dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const URL_RAW = process.env.NEXT_PUBLIC_SUPABASE_URL;
const FILE_ARG = process.argv[2];

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!PAT) die('SUPABASE_ACCESS_TOKEN env var required (paste a PAT from supabase.com/dashboard/account/tokens).');
if (!URL_RAW) die('NEXT_PUBLIC_SUPABASE_URL not set in .env.local.');
if (!FILE_ARG) die('Usage: apply-migration.ts <path/to/migration.sql>');

// xnhkuutoarmlmocqqpsh.supabase.co → xnhkuutoarmlmocqqpsh
const ref = new URL(URL_RAW).hostname.split('.')[0];
if (!ref || ref.length < 16) die(`Could not derive project ref from URL: ${URL_RAW}`);

const sqlPath = resolve(process.cwd(), FILE_ARG);
let sql: string;
try {
  sql = readFileSync(sqlPath, 'utf8');
} catch (err) {
  die(`Could not read ${sqlPath}: ${err instanceof Error ? err.message : err}`);
}

console.log(`▸ Project: ${ref}`);
console.log(`▸ File:    ${sqlPath}`);
console.log(`▸ Bytes:   ${sql.length}`);

const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query`;

// Wrapped in main() so this works under tsx's CJS transpile path,
// which doesn't support top-level await.
async function main(): Promise<void> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await res.text();
  console.log(`▸ HTTP ${res.status}`);
  console.log(text);

  if (!res.ok) {
    die(`Migration FAILED with HTTP ${res.status}.`);
  }

  console.log('✓ Migration applied.');
}

main().catch((err) => {
  console.error('✗ Unexpected failure:', err);
  process.exit(1);
});
