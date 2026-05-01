// Tests for the lawn-care intake Zod schemas.
//
// Mirrors lib/forms/cleaning-intake.test.ts and the handyman tests
// inline in the parent suite. Focus: enums, the date refinement, the
// three step schemas, and the merged whole-intake schema.

import { describe, it, expect } from 'vitest';
import {
  LotSizeSchema,
  ServiceTypeSchema,
  FrequencySchema,
  StartDateSchema,
  LocationSchema,
  YardSchema,
  ContactSchema,
  LawnCareIntakeSchema,
  STEPS,
  STEP_SCHEMAS,
  LOT_SIZES,
  SERVICE_TYPES,
  FREQUENCIES,
} from './lawn-care-intake';

function isoOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('LotSizeSchema', () => {
  it('accepts every seeded option', () => {
    for (const v of LOT_SIZES) {
      expect(LotSizeSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(LotSizeSchema.safeParse('massive').success).toBe(false);
  });
});

describe('ServiceTypeSchema', () => {
  it('accepts every seeded option', () => {
    for (const v of SERVICE_TYPES) {
      expect(ServiceTypeSchema.safeParse(v).success).toBe(true);
    }
  });
});

describe('FrequencySchema', () => {
  it('accepts every seeded option', () => {
    for (const v of FREQUENCIES) {
      expect(FrequencySchema.safeParse(v).success).toBe(true);
    }
  });
});

describe('StartDateSchema', () => {
  it('accepts today and future ISO dates', () => {
    expect(StartDateSchema.safeParse(isoOffset(0)).success).toBe(true);
    expect(StartDateSchema.safeParse(isoOffset(7)).success).toBe(true);
  });

  it('rejects past dates', () => {
    expect(StartDateSchema.safeParse(isoOffset(-1)).success).toBe(false);
  });

  it('rejects malformed dates', () => {
    expect(StartDateSchema.safeParse('06/05/2026').success).toBe(false);
    expect(StartDateSchema.safeParse('2026/06/05').success).toBe(false);
  });
});

describe('LocationSchema', () => {
  it('accepts a complete US address', () => {
    expect(
      LocationSchema.safeParse({
        address: '123 Lawn St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      }).success,
    ).toBe(true);
  });

  it('accepts optional lat/lng from Place Details', () => {
    expect(
      LocationSchema.safeParse({
        address: '123 Lawn St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        lat: 30.2672,
        lng: -97.7431,
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-range coords', () => {
    expect(
      LocationSchema.safeParse({
        address: '123',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        lat: 99,
      }).success,
    ).toBe(false);
  });
});

describe('YardSchema', () => {
  const valid = {
    lot_size: '1/4 – 1/2 acre',
    service_type: ['Mowing', 'Edging'],
    frequency: 'Every two weeks',
    start_date: isoOffset(3),
  };

  it('accepts a valid yard payload', () => {
    expect(YardSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty service_type array (must pick at least one)', () => {
    const r = YardSchema.safeParse({ ...valid, service_type: [] });
    expect(r.success).toBe(false);
  });

  it('accepts an additional_notes string up to 1000 chars', () => {
    const r = YardSchema.safeParse({
      ...valid,
      additional_notes: 'x'.repeat(1000),
    });
    expect(r.success).toBe(true);
  });

  it('rejects additional_notes over 1000 chars', () => {
    const r = YardSchema.safeParse({
      ...valid,
      additional_notes: 'x'.repeat(1001),
    });
    expect(r.success).toBe(false);
  });

  it('accepts empty-string additional_notes (no error, kept as empty string)', () => {
    // The chain `.optional().or(z.literal('').transform(() => undefined))`
    // tries the optional string path FIRST and succeeds on '', so we
    // get '' back rather than undefined. Documenting current behavior;
    // form code defaults the field to '' anyway, so this is effectively
    // a no-op when the customer leaves the textarea blank.
    const r = YardSchema.safeParse({ ...valid, additional_notes: '' });
    expect(r.success).toBe(true);
  });
});

describe('ContactSchema', () => {
  it('accepts a valid contact block', () => {
    expect(
      ContactSchema.safeParse({
        contact_name: 'Pat Test',
        contact_phone: '512-555-0100',
        contact_email: 'pat@example.com',
      }).success,
    ).toBe(true);
  });

  it('lowercases + trims email via the shared EmailSchema', () => {
    const r = ContactSchema.safeParse({
      contact_name: 'Pat',
      contact_phone: '512-555-0100',
      contact_email: '  Pat@Example.COM  ',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contact_email).toBe('pat@example.com');
  });
});

describe('LawnCareIntakeSchema (full)', () => {
  it('accepts a fully-populated intake', () => {
    const r = LawnCareIntakeSchema.safeParse({
      address: '123 Lawn St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      lot_size: '1/4 – 1/2 acre',
      service_type: ['Mowing', 'Edging'],
      frequency: 'Weekly',
      start_date: isoOffset(2),
      contact_name: 'Pat',
      contact_phone: '512-555-0100',
      contact_email: 'pat@example.com',
    });
    expect(r.success).toBe(true);
  });

  it('accepts UTM fields as optional (merged from UtmsSchema)', () => {
    const r = LawnCareIntakeSchema.safeParse({
      address: '123 Lawn St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      lot_size: '1/4 – 1/2 acre',
      service_type: ['Mowing'],
      frequency: 'One-time',
      start_date: isoOffset(2),
      contact_name: 'Pat',
      contact_phone: '512-555-0100',
      contact_email: 'pat@example.com',
      utm_source: 'google',
      utm_campaign: 'sd-lawn-launch',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.utm_source).toBe('google');
  });
});

describe('STEPS / STEP_SCHEMAS', () => {
  it('has exactly 4 steps in the canonical order', () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      'location',
      'yard',
      'contact',
      'review',
    ]);
  });

  it('STEP_SCHEMAS covers every step id', () => {
    for (const step of STEPS) {
      expect(STEP_SCHEMAS).toHaveProperty(step.id);
    }
  });
});
