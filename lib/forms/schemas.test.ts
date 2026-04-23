import { describe, it, expect } from 'vitest';
import { ZipSchema, PhoneSchema, UsStateSchema } from './moving-intake';

describe('ZipSchema', () => {
  it('accepts 5-digit ZIP', () => {
    expect(ZipSchema.safeParse('94102').success).toBe(true);
  });

  it('accepts ZIP+4', () => {
    expect(ZipSchema.safeParse('94102-1234').success).toBe(true);
  });

  it('rejects short zips', () => {
    expect(ZipSchema.safeParse('9410').success).toBe(false);
  });

  it('rejects letters', () => {
    expect(ZipSchema.safeParse('9410A').success).toBe(false);
  });

  it('trims whitespace', () => {
    const r = ZipSchema.safeParse('  94102  ');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('94102');
  });
});

describe('PhoneSchema', () => {
  // Regex requires the first char to be '+' or a digit, so parenthesized
  // leading formats aren't accepted at this layer — they'd need to be
  // normalized upstream (see lib/ingest/phone.ts for E.164 normalization).
  it('accepts E.164 and digit-leading formats', () => {
    expect(PhoneSchema.safeParse('+1 415-555-0100').success).toBe(true);
    expect(PhoneSchema.safeParse('4155550100').success).toBe(true);
    expect(PhoneSchema.safeParse('1-415-555-0100').success).toBe(true);
  });

  it('rejects leading parenthesis — consumers must strip upstream', () => {
    expect(PhoneSchema.safeParse('(415) 555-0100').success).toBe(false);
  });

  it('rejects too-short strings', () => {
    expect(PhoneSchema.safeParse('555').success).toBe(false);
  });

  it('rejects invalid characters', () => {
    expect(PhoneSchema.safeParse('call me maybe').success).toBe(false);
  });
});

describe('UsStateSchema', () => {
  it('accepts a valid state code', () => {
    expect(UsStateSchema.safeParse('CA').success).toBe(true);
    expect(UsStateSchema.safeParse('NY').success).toBe(true);
    expect(UsStateSchema.safeParse('DC').success).toBe(true);
  });

  it('rejects lowercase state codes (consumers must uppercase)', () => {
    expect(UsStateSchema.safeParse('ca').success).toBe(false);
  });

  it('rejects non-states', () => {
    expect(UsStateSchema.safeParse('XX').success).toBe(false);
    expect(UsStateSchema.safeParse('California').success).toBe(false);
  });
});
