// Google Place Details proxy.
//
// Called once, after the user picks a prediction from the autocomplete
// dropdown. Returns the structured address fields (street, city,
// state, zip) so the form can auto-fill them.
//
// Same session_token should be sent here as was used during the
// autocomplete lookups — Google uses it to bundle the queries into a
// single billed session.
//
// Endpoint shape:
//   GET /api/places/details?place_id=<id>&session_token=<uuid>
//     → { address_line, city, state, zip_code, country, formatted }

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';
import { assertRateLimit } from '@/lib/security/rate-limit-auth';

const log = createLogger('places/details');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Rate-limit policy for the Place Details proxy.
//
// Details is called once per address pick (one per autocomplete
// session), so volume is much lower than autocomplete. We pick a
// conservative cap that still covers a real user re-typing several
// times: 30 calls / 60s / IP.
const RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

type RawAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type GoogleDetailsResponse = {
  id?: string;
  formattedAddress?: string;
  addressComponents?: RawAddressComponent[];
  // Geographic coordinates of the place. We pass them through to the
  // client so the form server action can persist origin_lat/origin_lng
  // on the quote_request — used downstream by the on-demand business
  // seeder + the radius selector.
  location?: { latitude?: number; longitude?: number };
};

// Walks Google's addressComponents array and builds a clean address
// record. `short` for state (we want "CA" not "California") and zip;
// `long` for city (street-level detail stays verbose).
function parseAddress(components: RawAddressComponent[] | undefined): {
  address_line: string;
  city: string;
  state: string;
  zip_code: string;
  country: string;
} {
  const out = { address_line: '', city: '', state: '', zip_code: '', country: '' };
  if (!components) return out;
  let streetNumber = '';
  let route = '';
  for (const c of components) {
    const types = c.types ?? [];
    if (types.includes('street_number')) streetNumber = c.longText ?? '';
    else if (types.includes('route')) route = c.longText ?? '';
    else if (types.includes('locality')) out.city = c.longText ?? '';
    // Some places lack 'locality' but have 'postal_town' or 'sublocality'.
    else if (!out.city && types.includes('postal_town')) out.city = c.longText ?? '';
    else if (!out.city && types.includes('sublocality')) out.city = c.longText ?? '';
    else if (types.includes('administrative_area_level_1')) out.state = c.shortText ?? '';
    else if (types.includes('postal_code')) out.zip_code = c.shortText ?? '';
    else if (types.includes('country')) out.country = c.shortText ?? '';
  }
  out.address_line = [streetNumber, route].filter(Boolean).join(' ').trim();
  return out;
}

export async function GET(req: Request) {
  const deny = assertRateLimit(req, {
    prefix: 'places-details',
    limit: RATE_LIMIT.limit,
    windowMs: RATE_LIMIT.windowMs,
  });
  if (deny) return deny;

  const url = new URL(req.url);
  const placeId = (url.searchParams.get('place_id') ?? '').trim();
  const sessionToken = (url.searchParams.get('session_token') ?? '').trim();
  if (!placeId) {
    return NextResponse.json({ error: 'place_id required' }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    log.error('GOOGLE_PLACES_API_KEY not set');
    return NextResponse.json({ error: 'Places API not configured' }, { status: 500 });
  }

  try {
    const fields = 'id,formattedAddress,addressComponents,location';
    const qs = new URLSearchParams({ fields });
    if (sessionToken) qs.set('sessionToken', sessionToken);
    const r = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${qs.toString()}`,
      { headers: { 'X-Goog-Api-Key': apiKey } }
    );

    if (!r.ok) {
      const text = await r.text();
      log.warn('Google details error', { status: r.status, body: text.slice(0, 200) });
      return NextResponse.json(
        { error: `Google ${r.status}` },
        { status: r.status === 429 ? 429 : 502 }
      );
    }

    const data = (await r.json()) as GoogleDetailsResponse;
    const parsed = parseAddress(data.addressComponents);
    // Spell out every key explicitly (rather than `...parsed`) so the
    // response contract is visible at the call site and the
    // route-response-shape audit can verify it. R46(a) lock.
    return NextResponse.json({
      address_line: parsed.address_line,
      city: parsed.city,
      state: parsed.state,
      zip_code: parsed.zip_code,
      country: parsed.country,
      formatted: data.formattedAddress ?? '',
      // Coords are nullable — Place Details usually returns them but
      // some entries (PO boxes, fictional addresses) may not.
      latitude: data.location?.latitude ?? null,
      longitude: data.location?.longitude ?? null,
    });
  } catch (err) {
    log.error('details exception', { err });
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { route: 'places/details' },
    });
    return NextResponse.json({ error: 'upstream error' }, { status: 502 });
  }
}
