// Google Places Autocomplete proxy.
//
// Why proxy instead of calling from the browser directly?
// - The existing GOOGLE_PLACES_API_KEY is a server-only key. Putting
//   it in a NEXT_PUBLIC_* would expose a key that has broad Places API
//   access. A proxy keeps the key server-side and lets us add rate
//   limiting / observability later.
// - We pass through a session_token param so Google bills us for
//   autocomplete SESSIONS (cheap bundle) rather than per-keystroke
//   standalone queries (2–3x more expensive).
//
// Endpoint shape:
//   GET /api/places/autocomplete?q=<query>&session_token=<uuid>
//     → { predictions: [{ place_id, description, main_text, secondary_text }] }
//
// Failure modes:
//   - Missing q: 400
//   - Missing GOOGLE_PLACES_API_KEY: 500 (ops config issue)
//   - Google 4xx/5xx: passthrough status with short error text

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';
import { assertRateLimit } from '@/lib/security/rate-limit-auth';

const log = createLogger('places/autocomplete');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Rate-limit policy for the Places autocomplete proxy.
//
// The route fronts a paid Google API and is reachable from any
// client (the form fires it on every keystroke ≥2 chars). Without
// throttling a single bot can burn our daily Places quota — which
// either bills us hard or, if quota-capped, breaks autocomplete for
// real users for the rest of the day.
//
// Numbers: 60 calls / 60s / IP. A real user typing in three address
// inputs (street + city + zip) at ~6 chars each fires ~12 keystrokes
// total, well under the budget. A bot scripting many lookups crosses
// 60 in one window and gets a clean 429 with Retry-After.
const RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

type GooglePrediction = {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
  };
};

type GoogleAutocompleteResponse = {
  suggestions?: GooglePrediction[];
};

// Google's v1 autocomplete lets us filter by an `includedPrimaryTypes`
// allowlist. We expose three modes via a `?type=` query param so each
// of our address inputs (street / city / zip) sees only the
// predictions that make sense for it:
//   - street: full street addresses (houses, apartments, route-level)
//   - city  : localities / postal towns (cities + similar administrative places)
//   - zip   : postal codes
// Unknown / omitted → defaults to street (the original behavior).
const TYPE_PRIMARIES: Record<string, string[]> = {
  street: ['street_address', 'premise', 'subpremise', 'route'],
  city: ['locality', 'postal_town', 'administrative_area_level_3'],
  zip: ['postal_code'],
};

export async function GET(req: Request) {
  const deny = assertRateLimit(req, {
    prefix: 'places-autocomplete',
    limit: RATE_LIMIT.limit,
    windowMs: RATE_LIMIT.windowMs,
  });
  if (deny) return deny;

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const sessionToken = (url.searchParams.get('session_token') ?? '').trim();
  const typeParam = (url.searchParams.get('type') ?? 'street').trim();
  const includedPrimaryTypes =
    TYPE_PRIMARIES[typeParam] ?? TYPE_PRIMARIES.street;

  // ZIP lookups become useful with 3 digits (Google can suggest
  // specific ZIPs from a prefix). City/street are fine at 2 chars.
  const minQueryLength = typeParam === 'zip' ? 3 : 2;
  if (!q || q.length < minQueryLength) {
    return NextResponse.json({ predictions: [] });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    log.error('GOOGLE_PLACES_API_KEY not set');
    return NextResponse.json(
      { predictions: [], error: 'Places API not configured' },
      { status: 500 }
    );
  }

  try {
    const body = {
      input: q,
      // US-only for now — matches our ingest + the business coverage.
      // Drop this once we expand internationally.
      includedRegionCodes: ['us'],
      // Filter predictions by `?type=` (street | city | zip). Each form
      // input only sees predictions appropriate for that field, so the
      // city box doesn't suggest full street addresses, etc.
      includedPrimaryTypes,
      ...(sessionToken ? { sessionToken } : {}),
    };
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      log.warn('Google autocomplete error', { status: r.status, body: text.slice(0, 200) });
      return NextResponse.json(
        { predictions: [], error: `Google ${r.status}` },
        { status: r.status === 429 ? 429 : 502 }
      );
    }

    const data = (await r.json()) as GoogleAutocompleteResponse;
    const predictions = (data.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<GooglePrediction['placePrediction']> => !!p?.placeId)
      .map((p) => ({
        place_id: p.placeId!,
        description: p.text?.text ?? '',
        main_text: p.structuredFormat?.mainText?.text ?? '',
        secondary_text: p.structuredFormat?.secondaryText?.text ?? '',
      }));

    return NextResponse.json({ predictions });
  } catch (err) {
    log.error('autocomplete exception', { err });
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { route: 'places/autocomplete' },
    });
    return NextResponse.json(
      { predictions: [], error: 'upstream error' },
      { status: 502 }
    );
  }
}
