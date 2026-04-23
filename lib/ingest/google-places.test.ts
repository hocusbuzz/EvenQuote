// Tests for the Google Places v1 textSearch client.
//
// Key contract points:
//   - Throws a readable error when GOOGLE_PLACES_API_KEY is unset (we
//     want script runners to see this message, not a 403 from Google).
//   - Sends X-Goog-Api-Key + X-Goog-FieldMask headers (the v1 API
//     requires an explicit field mask; omitting it returns everything
//     and Google charges us for it).
//   - Caps pageSize at 20 (Google's max) even when callers pass larger.
//   - normalizePlace extracts city / state / zip from addressComponents
//     using the Google type taxonomy (locality, administrative_area_
//     level_1, postal_code, country).
//   - Skips entries with no id (malformed/partial responses).
//
// We mock global.fetch so we don't hit Google.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { textSearch } from './google-places';

const originalFetch = global.fetch;
const originalKey = process.env.GOOGLE_PLACES_API_KEY;

function mockFetchOk(body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchError(status: number, bodyText: string) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Error',
    json: async () => ({}),
    text: async () => bodyText,
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('textSearch', () => {
  beforeEach(() => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = originalKey;
  });

  it('throws when GOOGLE_PLACES_API_KEY is missing', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    await expect(textSearch({ query: 'movers near 10001' })).rejects.toThrow(
      /GOOGLE_PLACES_API_KEY is not set/
    );
  });

  it('sends API key and field mask headers', async () => {
    const fetchMock = mockFetchOk({ places: [] });
    await textSearch({ query: 'movers near 10001' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('test-key');
    expect(headers['X-Goog-FieldMask']).toContain('places.id');
    expect(headers['X-Goog-FieldMask']).toContain('places.displayName');
    expect(headers['X-Goog-FieldMask']).toContain('places.addressComponents');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('caps pageSize at 20 regardless of input', async () => {
    const fetchMock = mockFetchOk({ places: [] });
    await textSearch({ query: 'x', pageSize: 100 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.pageSize).toBe(20);
  });

  it('defaults pageSize to 20 when not provided', async () => {
    const fetchMock = mockFetchOk({ places: [] });
    await textSearch({ query: 'x' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.pageSize).toBe(20);
  });

  it('passes locationBias.circle shape when provided', async () => {
    const fetchMock = mockFetchOk({ places: [] });
    await textSearch({
      query: 'x',
      locationBias: { latitude: 40.75, longitude: -73.99, radiusMeters: 5000 },
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.locationBias).toEqual({
      circle: {
        center: { latitude: 40.75, longitude: -73.99 },
        radius: 5000,
      },
    });
  });

  it('throws an informative error on non-2xx response', async () => {
    mockFetchError(403, 'API key not valid');
    await expect(textSearch({ query: 'x' })).rejects.toThrow(
      /Google Places textSearch failed: 403/
    );
  });

  it('normalizes a full place response', async () => {
    mockFetchOk({
      places: [
        {
          id: 'places/ABC',
          displayName: { text: "Joe's Movers" },
          internationalPhoneNumber: '+1 212-555-0100',
          nationalPhoneNumber: '(212) 555-0100',
          websiteUri: 'https://example.com',
          formattedAddress: '123 Main St, New York, NY 10001, USA',
          addressComponents: [
            { longText: 'New York', shortText: 'NYC', types: ['locality'] },
            {
              longText: 'New York',
              shortText: 'NY',
              types: ['administrative_area_level_1'],
            },
            { longText: '10001', shortText: '10001', types: ['postal_code'] },
            { longText: 'United States', shortText: 'US', types: ['country'] },
          ],
          location: { latitude: 40.75, longitude: -73.99 },
          rating: 4.7,
          userRatingCount: 123,
        },
      ],
    });
    const [place] = await textSearch({ query: 'movers' });
    expect(place).toEqual({
      placeId: 'places/ABC',
      name: "Joe's Movers",
      phoneInternational: '+1 212-555-0100',
      phoneNational: '(212) 555-0100',
      website: 'https://example.com',
      formattedAddress: '123 Main St, New York, NY 10001, USA',
      city: 'New York',
      state: 'NY',
      zipCode: '10001',
      country: 'US',
      latitude: 40.75,
      longitude: -73.99,
      rating: 4.7,
      userRatingCount: 123,
    });
  });

  it('falls back to postal_town when locality is absent', async () => {
    // UK-style addresses often omit "locality" and use "postal_town".
    mockFetchOk({
      places: [
        {
          id: 'places/UK1',
          displayName: { text: 'UK Movers' },
          addressComponents: [
            { longText: 'Croydon', types: ['postal_town'] },
            { longText: 'England', shortText: 'ENG', types: ['administrative_area_level_1'] },
          ],
        },
      ],
    });
    const [place] = await textSearch({ query: 'uk' });
    expect(place.city).toBe('Croydon');
    expect(place.state).toBe('ENG');
  });

  it('returns sensible nulls for a sparse response', async () => {
    mockFetchOk({ places: [{ id: 'places/XYZ' }] });
    const [place] = await textSearch({ query: 'x' });
    expect(place).toEqual({
      placeId: 'places/XYZ',
      name: 'Unknown',
      phoneInternational: null,
      phoneNational: null,
      website: null,
      formattedAddress: null,
      city: null,
      state: null,
      zipCode: null,
      country: null,
      latitude: null,
      longitude: null,
      rating: null,
      userRatingCount: null,
    });
  });

  it('skips entries missing an id', async () => {
    mockFetchOk({
      places: [
        { id: 'places/OK', displayName: { text: 'Kept' } },
        { displayName: { text: 'Dropped' } }, // no id
      ],
    });
    const results = await textSearch({ query: 'x' });
    expect(results).toHaveLength(1);
    expect(results[0].placeId).toBe('places/OK');
  });

  it('returns empty array when response has no places key', async () => {
    mockFetchOk({});
    const results = await textSearch({ query: 'x' });
    expect(results).toEqual([]);
  });
});
