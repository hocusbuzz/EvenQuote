// Tests for the UTM attribution module.
//
// Two surfaces under test:
//   • UtmsSchema — Zod parsing rules (all-optional, length-capped,
//     trim semantics)
//   • parseUtmsFromSearchParams — URL → object extraction (only the
//     five canonical keys, drops empties, truncates oversized values)
//
// The schema and parser are independently used: the parser is the
// client-side capture path (utm-capture.tsx), the schema is the server-
// side validation path (intake server actions). Both must agree on
// the legal shape of a UTM, hence the dual-coverage test setup below.

import { describe, it, expect } from 'vitest';
import {
  UTM_KEYS,
  UtmsSchema,
  parseUtmsFromSearchParams,
  hasAnyUtms,
} from './utms';

describe('UTM_KEYS', () => {
  it('lists exactly the five canonical utm_* params', () => {
    expect([...UTM_KEYS]).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
    ]);
  });
});

describe('UtmsSchema', () => {
  it('accepts an empty object (all fields optional — direct/organic traffic)', () => {
    const r = UtmsSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('accepts a fully-populated payload', () => {
    const r = UtmsSchema.safeParse({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'sd-moving-2026-05',
      utm_content: 'variant-a',
      utm_term: 'moving company san diego',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.utm_source).toBe('google');
  });

  it('trims whitespace on each field', () => {
    const r = UtmsSchema.safeParse({ utm_source: '  google  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.utm_source).toBe('google');
  });

  it('rejects an empty-string utm_source after trim (would persist garbage)', () => {
    const r = UtmsSchema.safeParse({ utm_source: '   ' });
    expect(r.success).toBe(false);
  });

  it('rejects a value exceeding 200 chars', () => {
    const r = UtmsSchema.safeParse({ utm_campaign: 'x'.repeat(201) });
    expect(r.success).toBe(false);
  });

  it('accepts a value at the 200-char boundary', () => {
    const r = UtmsSchema.safeParse({ utm_campaign: 'x'.repeat(200) });
    expect(r.success).toBe(true);
  });
});

describe('parseUtmsFromSearchParams', () => {
  it('returns an empty object when the URL has no UTMs', () => {
    const params = new URLSearchParams('?foo=bar&gclid=abc');
    expect(parseUtmsFromSearchParams(params)).toEqual({});
  });

  it('extracts only the five canonical keys', () => {
    const params = new URLSearchParams(
      '?utm_source=google&utm_medium=cpc&utm_campaign=sd-moving' +
        '&unrelated=ignored&fbclid=ignored',
    );
    const out = parseUtmsFromSearchParams(params);
    expect(out).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'sd-moving',
    });
  });

  it('skips empty-string values (e.g. "?utm_source=&utm_medium=cpc")', () => {
    const params = new URLSearchParams('?utm_source=&utm_medium=cpc');
    const out = parseUtmsFromSearchParams(params);
    expect(out).toEqual({ utm_medium: 'cpc' });
  });

  it('trims whitespace on values', () => {
    const params = new URLSearchParams('?utm_source=  google  ');
    const out = parseUtmsFromSearchParams(params);
    expect(out.utm_source).toBe('google');
  });

  it('truncates oversized values to 200 chars rather than dropping them', () => {
    // Persisting a truncated value is more useful than refusing the row —
    // see the comment in parseUtmsFromSearchParams for the rationale.
    const big = 'x'.repeat(500);
    const params = new URLSearchParams(`?utm_campaign=${big}`);
    const out = parseUtmsFromSearchParams(params);
    expect(out.utm_campaign?.length).toBe(200);
  });

  it('accepts an object with a get() method (ReadonlyURLSearchParams shape)', () => {
    // `useSearchParams()` from next/navigation returns ReadonlyURLSearchParams,
    // which is API-compatible with URLSearchParams via .get(). We accept
    // anything with a `get(key) → string|null` to keep the function usable
    // from both the server (URL.searchParams) and the client.
    const fake = {
      get(key: string): string | null {
        if (key === 'utm_source') return 'reddit';
        return null;
      },
    };
    expect(parseUtmsFromSearchParams(fake)).toEqual({ utm_source: 'reddit' });
  });
});

describe('hasAnyUtms', () => {
  it('returns false for an empty object', () => {
    expect(hasAnyUtms({})).toBe(false);
  });

  it('returns true if any single utm_* is present', () => {
    expect(hasAnyUtms({ utm_source: 'google' })).toBe(true);
  });

  it('returns false if every key is explicitly undefined', () => {
    expect(
      hasAnyUtms({
        utm_source: undefined,
        utm_medium: undefined,
        utm_campaign: undefined,
        utm_content: undefined,
        utm_term: undefined,
      }),
    ).toBe(false);
  });
});
