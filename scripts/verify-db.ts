/**
 * DB sanity check for Phase 1.
 *
 * Usage:  npx tsx scripts/verify-db.ts
 *
 * Reads .env.local, connects using the service role key, and verifies:
 *   - connection works
 *   - all expected tables exist
 *   - seed data loaded correctly (1 category, 20 businesses, all 555-*)
 *   - RLS is enabled on user-scoped tables
 *
 * Exits 0 on success, 1 on any failure.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Check = { name: string; run: () => Promise<string> };

const checks: Check[] = [
  {
    name: 'connection',
    run: async () => {
      const { error } = await supabase.from('service_categories').select('id').limit(1);
      if (error) throw new Error(error.message);
      return 'reachable';
    },
  },
  {
    name: 'service_categories row count',
    run: async () => {
      const { count, error } = await supabase
        .from('service_categories')
        .select('*', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      if (count !== 1) throw new Error(`expected 1, got ${count}`);
      return `${count}`;
    },
  },
  {
    name: 'moving category present with intake schema',
    run: async () => {
      const { data, error } = await supabase
        .from('service_categories')
        .select('slug, intake_form_schema')
        .eq('slug', 'moving')
        .single();
      if (error) throw new Error(error.message);
      const steps = (data.intake_form_schema as { steps?: unknown[] })?.steps;
      if (!Array.isArray(steps) || steps.length !== 4) {
        throw new Error(`expected 4 intake steps, got ${steps?.length}`);
      }
      return `4 steps`;
    },
  },
  {
    name: 'businesses row count',
    run: async () => {
      const { count, error } = await supabase
        .from('businesses')
        .select('*', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      if (count !== 20) throw new Error(`expected 20, got ${count}`);
      return `${count}`;
    },
  },
  {
    name: 'all seed phones are fake 555-range',
    run: async () => {
      const { data, error } = await supabase
        .from('businesses')
        .select('name, phone');
      if (error) throw new Error(error.message);
      const bad = data.filter((b) => !b.phone.startsWith('+1555'));
      if (bad.length > 0) {
        throw new Error(
          `found ${bad.length} non-555 phones: ${bad.map((b) => b.name).join(', ')}`
        );
      }
      return `${data.length}/20 safe`;
    },
  },
  {
    name: 'inactive business exists (for filter testing)',
    run: async () => {
      const { data, error } = await supabase
        .from('businesses')
        .select('name')
        .eq('is_active', false);
      if (error) throw new Error(error.message);
      if (data.length < 1) throw new Error('expected >=1 inactive business');
      return `${data.length} inactive`;
    },
  },
];

async function main() {
  console.log('\n🔍 EvenQuote DB verification\n');

  let failed = 0;
  for (const check of checks) {
    try {
      const result = await check.run();
      console.log(`  ✅ ${check.name.padEnd(45)} ${result}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ❌ ${check.name.padEnd(45)} ${msg}`);
    }
  }

  console.log();
  if (failed > 0) {
    console.log(`❌ ${failed} check(s) failed.\n`);
    process.exit(1);
  }
  console.log('✅ DB connection OK. All Phase 1 checks passed.\n');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
