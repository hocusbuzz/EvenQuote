#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Seed a small batch of realistic CSP violations into `csp_violations`
 * so you can run `scripts/analyze-csp-reports.ts` end-to-end LOCALLY
 * before opening the production collection window.
 *
 * Intended use
 * ------------
 * Point `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` at
 * your LOCAL Supabase (or a throwaway dev project). Never at prod.
 * The seed inserts ~50 rows shaped like real browser reports so the
 * aggregator in `scripts/analyze-csp-reports.ts` has something
 * non-empty to group over.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=<local-service-role> \
 *   NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 \
 *     npx tsx scripts/seed-csp-sample.ts
 *
 * Then:
 *
 *   npx tsx scripts/analyze-csp-reports.ts --days=30
 *
 * Safety
 * ------
 * • Hard refusal if the Supabase URL contains `supabase.co` AND the
 *   hostname looks like a production project (no `localhost`, no
 *   `127.0.0.1`). This is a defense against "oops I pasted the prod
 *   env vars". Override with `ALLOW_PROD_SEED=true` ONLY if you
 *   absolutely mean to (you almost never do).
 * • Prints the IDs it inserted so you can delete them with a single
 *   SQL statement afterward.
 *
 * Not-goals
 * ---------
 * This is not a migration tool, not a fuzzer, and not a load-tester.
 * It exists to make the analyze script's output format visible in
 * ~30 seconds without waiting for real browser traffic.
 */

import { createClient } from '@supabase/supabase-js';

// Shape matches `0009_csp_violations.sql`. Keep this list literal so
// the aggregator's grouping behavior is easy to predict when you read
// the output. Numbers reflect a realistic long-tail distribution:
// a handful of very-frequent "legit 3rd-party" violations, a mid-tier
// of "probably ok on allow-list", and a long tail of browser noise.
type Sample = {
  effective_directive: string;
  violated_directive: string;
  blocked_uri: string;
  document_uri: string;
  referrer: string;
  repeat: number;
};

const SAMPLES: Sample[] = [
  // Top-tier: Stripe's script-loader is the single most common
  // legitimate violation — every checkout page fires it.
  {
    effective_directive: 'script-src',
    violated_directive: 'script-src-elem',
    blocked_uri: 'https://js.stripe.com/v3/',
    document_uri: 'https://evenquote.com/get-quotes/checkout/abc-123',
    referrer: 'https://evenquote.com/get-quotes',
    repeat: 18,
  },
  // Stripe's checkout iframe.
  {
    effective_directive: 'frame-src',
    violated_directive: 'frame-src',
    blocked_uri: 'https://checkout.stripe.com/c/pay/cs_test_abcdef',
    document_uri: 'https://evenquote.com/get-quotes/checkout/abc-123',
    referrer: 'https://evenquote.com/get-quotes',
    repeat: 12,
  },
  // Google Fonts stylesheet — used if we ever switch off self-hosted.
  {
    effective_directive: 'style-src',
    violated_directive: 'style-src-elem',
    blocked_uri: 'https://fonts.googleapis.com/css2?family=Fraunces',
    document_uri: 'https://evenquote.com/',
    referrer: '',
    repeat: 7,
  },
  // Inline style from a 3rd-party widget, if any.
  {
    effective_directive: 'style-src',
    violated_directive: 'style-src-attr',
    blocked_uri: 'inline',
    document_uri: 'https://evenquote.com/dashboard',
    referrer: 'https://evenquote.com/',
    repeat: 4,
  },
  // Image host — cdn for user-provided images in some future flow.
  {
    effective_directive: 'img-src',
    violated_directive: 'img-src',
    blocked_uri: 'https://images.unsplash.com/photo-12345',
    document_uri: 'https://evenquote.com/',
    referrer: '',
    repeat: 3,
  },
  // Browser noise: a Chrome extension injecting a content script.
  // These should be ignored at analyze time — no allow-list entry.
  {
    effective_directive: 'script-src',
    violated_directive: 'script-src-elem',
    blocked_uri: 'chrome-extension://abcdef/content.js',
    document_uri: 'https://evenquote.com/',
    referrer: '',
    repeat: 2,
  },
  // Inline script sample — the JSON-LD block on / until we thread
  // the nonce through <Script>. Expected under Report-Only.
  {
    effective_directive: 'script-src',
    violated_directive: 'script-src-elem',
    blocked_uri: 'inline',
    document_uri: 'https://evenquote.com/',
    referrer: '',
    repeat: 5,
  },
  // A genuinely-sketchy blocked URI — an XSS probe that landed on
  // the production homepage. These are exactly what we WANT to keep
  // blocked — Enforce should land before, not after, mitigating.
  {
    effective_directive: 'script-src',
    violated_directive: 'script-src-elem',
    blocked_uri: 'https://evil.example/xss.js',
    document_uri: 'https://evenquote.com/',
    referrer: '',
    repeat: 1,
  },
];

function isProdSupabase(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('localhost')) return false;
  if (lower.includes('127.0.0.1')) return false;
  // `supabase.co` hosts are shared dev + prod — only flag "looks
  // prod" if the hostname is a bare project URL, not a branch.
  return lower.includes('.supabase.co');
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
        'This script writes with service-role creds and will not run with anon.'
    );
    process.exit(1);
  }

  if (isProdSupabase(url) && process.env.ALLOW_PROD_SEED !== 'true') {
    console.error(
      `Refusing to seed: ${url} looks like a hosted Supabase project.\n` +
        'Set ALLOW_PROD_SEED=true to override (you almost never want this).'
    );
    process.exit(1);
  }

  const supa = createClient(url, key);

  // Expand `repeat` into individual rows with a jittered timestamp
  // across the last 14 days so the aggregator's `--days=N` window
  // exercises day-boundary edges.
  const now = Date.now();
  const rows: Array<{
    effective_directive: string;
    violated_directive: string;
    blocked_uri: string;
    document_uri: string;
    referrer: string;
    received_at: string;
  }> = [];

  for (const s of SAMPLES) {
    for (let i = 0; i < s.repeat; i += 1) {
      const jitterDays = Math.random() * 14;
      const ts = new Date(now - jitterDays * 24 * 60 * 60 * 1000).toISOString();
      rows.push({
        effective_directive: s.effective_directive,
        violated_directive: s.violated_directive,
        blocked_uri: s.blocked_uri,
        document_uri: s.document_uri,
        referrer: s.referrer,
        received_at: ts,
      });
    }
  }

  console.log(`Inserting ${rows.length} sample rows into csp_violations…`);

  const { data, error } = await supa
    .from('csp_violations')
    .insert(rows)
    .select('id');

  if (error) {
    console.error('insert failed:', error.message);
    process.exit(1);
  }

  const ids = (data ?? []).map((r) => r.id);
  console.log(`Inserted ${ids.length} rows.`);
  console.log('\nTo remove them afterward, run this SQL in the Supabase editor:');
  console.log(
    `  delete from public.csp_violations where id in (${ids
      .map((id) => `'${id}'`)
      .join(',')});`
  );
  console.log('\nNext:');
  console.log('  npx tsx scripts/analyze-csp-reports.ts --days=30');
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
