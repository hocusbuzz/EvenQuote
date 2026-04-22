// CLI entry for ingesting businesses from Google Places into Supabase.
//
// Usage:
//   pnpm ingest:businesses -- --category moving --query "movers near 10001"
//   pnpm ingest:businesses -- --category moving --query "movers in Brooklyn NY"
//
// The query string is passed to Google Places textSearch verbatim.
// Plain English works best ("movers near 10001 zip code"); Google's
// engine handles the geo parsing. If you want tighter geo bias, pass
// --lat/--lng/--radius-miles.
//
// Required env (loaded from .env.local via dotenv):
//   GOOGLE_PLACES_API_KEY
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { textSearch, type PlaceResult } from '../lib/ingest/google-places';
import { upsertBusinesses } from '../lib/ingest/upsert-businesses';

type Args = {
  categorySlug: string;
  query: string;
  lat?: number;
  lng?: number;
  radiusMiles?: number;
  pageSize?: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--category':
      case '-c':
        args.categorySlug = next;
        i += 1;
        break;
      case '--query':
      case '-q':
        args.query = next;
        i += 1;
        break;
      case '--lat':
        args.lat = Number(next);
        i += 1;
        break;
      case '--lng':
        args.lng = Number(next);
        i += 1;
        break;
      case '--radius-miles':
        args.radiusMiles = Number(next);
        i += 1;
        break;
      case '--page-size':
        args.pageSize = Number(next);
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        // ignore unknowns — we don't want to error on `--` separators
        // that package managers insert between their args and ours.
        break;
    }
  }
  if (!args.categorySlug) {
    throw new Error('Missing --category <slug>');
  }
  if (!args.query) {
    throw new Error('Missing --query "<text>"');
  }
  return args as Args;
}

function milesToMeters(miles: number): number {
  return Math.round(miles * 1609.344);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the service category UUID from its slug.
  const { data: category, error: catErr } = await admin
    .from('service_categories')
    .select('id, name')
    .eq('slug', args.categorySlug)
    .maybeSingle();

  if (catErr) throw new Error(`Category lookup failed: ${catErr.message}`);
  if (!category) throw new Error(`No category with slug "${args.categorySlug}"`);

  console.log(`ingesting "${args.query}" into category=${category.name} (${category.id})`);

  const locationBias =
    args.lat != null && args.lng != null && args.radiusMiles != null
      ? {
          latitude: args.lat,
          longitude: args.lng,
          radiusMeters: milesToMeters(args.radiusMiles),
        }
      : undefined;

  const places: PlaceResult[] = await textSearch({
    query: args.query,
    locationBias,
    pageSize: args.pageSize,
  });

  console.log(`google returned ${places.length} place(s)`);
  places.forEach((p, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${p.name} — ${p.phoneNational ?? p.phoneInternational ?? '(no phone)'} — ${p.city ?? '?'} ${p.state ?? ''} ${p.zipCode ?? ''} — ${p.rating ?? '?'}★ (${p.userRatingCount ?? 0})`
    );
  });

  if (args.dryRun) {
    console.log('\n--dry-run: not writing to DB');
    return;
  }

  const result = await upsertBusinesses(admin, {
    places,
    categoryId: category.id,
    source: 'google_places',
  });

  console.log(
    `\nresult: inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped}`
  );
  if (result.notes.length) {
    console.log('notes:');
    result.notes.forEach((n) => console.log(`  - ${n}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
