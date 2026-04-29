/**
 * DB sanity check.
 *
 * Usage:  npx tsx scripts/verify-db.ts
 *
 * Reads .env.local, connects using the service role key, and verifies:
 *   - connection works
 *   - moving category + 4-step intake schema loaded correctly
 *   - every currently-seeded category has non-null extraction_schema
 *     and places_query_template (migration 0005 + seed 0002 invariants)
 *   - businesses seed loaded (>=20 rows, all 555-* fake phones, at
 *     least one is_active=false for filter-path coverage)
 *
 * Exits 0 on success, 1 on any failure.
 *
 * NOTE: historical "expected exactly 1 service_category" check was
 * dropped in Round 24 — seed 0002 adds cleaning/handyman/lawn-care
 * on top of moving, so a fixed count would fail on any fully-seeded
 * DB. The moving invariants + per-row extraction_schema / places
 * template checks are the forward-compatible replacement.
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
      // >=1 since seed 0002 adds cleaning/handyman/lawn-care on top of
      // moving. The fixed count check was removed in Round 24 — a
      // single-category DB is a freshly-migrated-but-not-seed-0002 DB,
      // which is still a valid state (Phase 1 only).
      const { count, error } = await supabase
        .from('service_categories')
        .select('*', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      if (!count || count < 1) throw new Error(`expected >=1, got ${count}`);
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
    name: 'every category has extraction_schema + places_query_template',
    run: async () => {
      // Migration 0005 added these two columns. Seed 0002 backfills
      // moving + inserts cleaning/handyman/lawn-care with both columns
      // populated. A category missing either is either a seed bug or
      // a DB that hasn't run seed 0002 — ops should know.
      const { data, error } = await supabase
        .from('service_categories')
        .select('slug, extraction_schema, places_query_template');
      if (error) throw new Error(error.message);
      const gaps = (data ?? []).filter(
        (c) => !c.extraction_schema || !c.places_query_template
      );
      if (gaps.length > 0) {
        throw new Error(
          `${gaps.length} category(ies) missing extraction_schema/places_query_template: ${gaps.map((g) => g.slug).join(', ')}`
        );
      }
      return `${data?.length ?? 0}/${data?.length ?? 0} filled`;
    },
  },
  {
    name: 'businesses row count',
    run: async () => {
      // >=20 so future ingest-businesses.ts runs on top of the seed
      // don't break the check. The original ===20 was valid only
      // immediately after seed 0002_sample_businesses.sql ran.
      const { count, error } = await supabase
        .from('businesses')
        .select('*', { count: 'exact', head: true });
      if (error) throw new Error(error.message);
      if (!count || count < 20) throw new Error(`expected >=20, got ${count}`);
      return `${count}`;
    },
  },
  {
    name: 'all seed phones are fake 555-range',
    run: async () => {
      // Gate for dev environments only: every seeded business MUST
      // have a 555-range phone so `startOutboundCall` can never hit
      // a real line from a dev run. Post-ingest real businesses are
      // expected to have real phones — this check is ONLY meaningful
      // before ingest, which is the only time verify-db.ts is typically
      // run (smoke-test after migrate+seed). Once ingest has run, this
      // is expected to fail loudly — that's a feature, not a bug; the
      // failing output tells ops "you have real phones now, be careful".
      const { data, error } = await supabase
        .from('businesses')
        .select('name, phone');
      if (error) throw new Error(error.message);
      const bad = data.filter((b) => !b.phone.startsWith('+1555'));
      if (bad.length > 0) {
        throw new Error(
          `found ${bad.length} non-555 phones (real-phone ingest has run — expected after Phase 1, but remove TEST_OVERRIDE_PHONE before any dial): ${bad
            .slice(0, 3)
            .map((b) => b.name)
            .join(', ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}`
        );
      }
      return `${data.length}/${data.length} safe`;
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
