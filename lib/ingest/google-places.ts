// Google Places (v1 "New Places API") client — minimal, typed, zero-dep.
//
// We use Text Search because it gives us ranked results scoped by
// "mover near <zip>" in a single request. Nearby Search is an option
// later if we want pure distance ranking.
//
// Docs:
//   https://developers.google.com/maps/documentation/places/web-service/text-search
//   https://developers.google.com/maps/documentation/places/web-service/place-details
//
// Field mask note: the v1 API charges per-field category. We only ask
// for the fields we store, which keeps ingest cheap. See the field
// mask header in each request.

export type PlaceResult = {
  placeId: string;
  name: string;
  phoneInternational: string | null;
  phoneNational: string | null;
  website: string | null;
  formattedAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  userRatingCount: number | null;
};

type RawV1Place = {
  id: string;
  displayName?: { text?: string };
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  formattedAddress?: string;
  addressComponents?: Array<{
    longText?: string;
    shortText?: string;
    types?: string[];
  }>;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
};

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// Fields we actually use. Keep this in sync with RawV1Place above —
// anything missing here will come back undefined at runtime.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.internationalPhoneNumber',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.rating',
  'places.userRatingCount',
].join(',');

export type TextSearchInput = {
  /** Plain-English query, e.g. "movers near 10001". */
  query: string;
  /** Bias results within a radius (meters) of a lat/lng. Optional. */
  locationBias?: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
  /** Cap results. Google caps at 20 per page regardless. */
  pageSize?: number;
};

/**
 * Text search against Google Places v1. Returns normalized PlaceResult[]
 * ready to pass into upsertBusinesses.
 *
 * Throws on missing API key or non-2xx response. Callers should let
 * this bubble in scripts; catch it in interactive flows.
 */
export async function textSearch(input: TextSearchInput): Promise<PlaceResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not set. Add it to .env.local before running ingest.'
    );
  }

  const body: Record<string, unknown> = {
    textQuery: input.query,
    pageSize: Math.min(input.pageSize ?? 20, 20),
  };

  if (input.locationBias) {
    body.locationBias = {
      circle: {
        center: {
          latitude: input.locationBias.latitude,
          longitude: input.locationBias.longitude,
        },
        radius: input.locationBias.radiusMeters,
      },
    };
  }

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Google Places textSearch failed: ${res.status} ${res.statusText}\n${text}`
    );
  }

  const json = (await res.json()) as { places?: RawV1Place[] };
  const places = json.places ?? [];
  return places.map(normalizePlace).filter((p): p is PlaceResult => p !== null);
}

/**
 * Pull out the parts of an addressComponents array we care about.
 * Google returns a list; each entry names its type (e.g. "locality",
 * "administrative_area_level_1"). We match on those types rather than
 * parsing formattedAddress — addressComponents is structured.
 */
function extractAddressParts(components: RawV1Place['addressComponents']): {
  city: string | null;
  state: string | null;
  zipCode: string | null;
  country: string | null;
} {
  const out = { city: null, state: null, zipCode: null, country: null } as {
    city: string | null;
    state: string | null;
    zipCode: string | null;
    country: string | null;
  };

  if (!components) return out;

  for (const c of components) {
    const types = c.types ?? [];
    if (types.includes('locality')) out.city = c.longText ?? null;
    else if (!out.city && types.includes('postal_town'))
      out.city = c.longText ?? null;
    else if (types.includes('administrative_area_level_1'))
      out.state = c.shortText ?? c.longText ?? null;
    else if (types.includes('postal_code')) out.zipCode = c.longText ?? null;
    else if (types.includes('country')) out.country = c.shortText ?? null;
  }

  return out;
}

function normalizePlace(p: RawV1Place): PlaceResult | null {
  if (!p.id) return null;

  const { city, state, zipCode, country } = extractAddressParts(p.addressComponents);

  return {
    placeId: p.id,
    name: p.displayName?.text ?? 'Unknown',
    phoneInternational: p.internationalPhoneNumber ?? null,
    phoneNational: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    formattedAddress: p.formattedAddress ?? null,
    city,
    state,
    zipCode,
    country,
    latitude: p.location?.latitude ?? null,
    longitude: p.location?.longitude ?? null,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
  };
}
