// Tests for the junk-removal intake Zod schemas.
// Mirrors the lawn-care + cleaning intake test patterns.

import { describe, it, expect } from 'vitest';
import {
  VolumeBucketSchema,
  HeavyItemSchema,
  PickupLocationSchema,
  PreferredDateSchema,
  LocationSchema,
  LoadSchema,
  ContactSchema,
  JunkRemovalIntakeSchema,
  STEPS,
  STEP_SCHEMAS,
  VOLUME_BUCKETS,
  HEAVY_ITEMS,
  PICKUP_LOCATIONS,
} from './junk-removal-intake';

function isoOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('VolumeBucketSchema', () => {
  it('accepts every seeded option', () => {
    for (const v of VOLUME_BUCKETS) {
      expect(VolumeBucketSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(VolumeBucketSchema.safeParse('giant').success).toBe(false);
  });
});

describe('HeavyItemSchema', () => {
  it('accepts every seeded option', () => {
    for (const v of HEAVY_ITEMS) {
      expect(HeavyItemSchema.safeParse(v).success).toBe(true);
    }
  });
});

describe('PickupLocationSchema', () => {
  it('accepts every seeded option', () => {
    for (const v of PICKUP_LOCATIONS) {
      expect(PickupLocationSchema.safeParse(v).success).toBe(true);
    }
  });
});

describe('PreferredDateSchema', () => {
  it('accepts today and future ISO dates', () => {
    expect(PreferredDateSchema.safeParse(isoOffset(0)).success).toBe(true);
    expect(PreferredDateSchema.safeParse(isoOffset(7)).success).toBe(true);
  });

  it('rejects past dates', () => {
    expect(PreferredDateSchema.safeParse(isoOffset(-1)).success).toBe(false);
  });

  it('rejects malformed dates', () => {
    expect(PreferredDateSchema.safeParse('06/05/2026').success).toBe(false);
  });
});

describe('LocationSchema', () => {
  it('accepts a complete US address', () => {
    expect(
      LocationSchema.safeParse({
        address: '123 Trash St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
      }).success,
    ).toBe(true);
  });

  it('accepts optional lat/lng from Place Details', () => {
    expect(
      LocationSchema.safeParse({
        address: '123 Trash St',
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        lat: 30.2672,
        lng: -97.7431,
      }).success,
    ).toBe(true);
  });
});

describe('LoadSchema', () => {
  const valid = {
    volume_bucket: 'Pickup-truck load',
    heavy_items: [],
    pickup_location: 'Curb / driveway',
    preferred_date: isoOffset(2),
  };

  it('accepts a valid load with no heavy items (default empty array)', () => {
    expect(LoadSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts heavy_items as an array of valid enum values', () => {
    const r = LoadSchema.safeParse({
      ...valid,
      heavy_items: ['Piano', 'Hot tub'],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.heavy_items).toEqual(['Piano', 'Hot tub']);
  });

  it('defaults heavy_items to empty array when omitted', () => {
    const { heavy_items: _omit, ...withoutHeavyItems } = valid;
    void _omit;
    const r = LoadSchema.safeParse(withoutHeavyItems);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.heavy_items).toEqual([]);
  });

  it('rejects an invalid heavy_items entry', () => {
    const r = LoadSchema.safeParse({
      ...valid,
      heavy_items: ['Piano', 'Spaceship'],
    });
    expect(r.success).toBe(false);
  });

  it('accepts same_day_needed as boolean or undefined', () => {
    expect(LoadSchema.safeParse({ ...valid, same_day_needed: true }).success).toBe(true);
    expect(LoadSchema.safeParse({ ...valid, same_day_needed: false }).success).toBe(true);
    expect(LoadSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects additional_notes over 1000 chars', () => {
    const r = LoadSchema.safeParse({
      ...valid,
      additional_notes: 'x'.repeat(1001),
    });
    expect(r.success).toBe(false);
  });
});

describe('ContactSchema', () => {
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

describe('JunkRemovalIntakeSchema (full)', () => {
  it('accepts a fully-populated intake', () => {
    const r = JunkRemovalIntakeSchema.safeParse({
      address: '123 Trash St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      volume_bucket: 'Half a truck',
      heavy_items: ['Piano'],
      pickup_location: 'Garage',
      same_day_needed: false,
      preferred_date: isoOffset(2),
      additional_notes: 'Behind the side gate.',
      contact_name: 'Pat',
      contact_phone: '512-555-0100',
      contact_email: 'pat@example.com',
    });
    expect(r.success).toBe(true);
  });

  it('accepts UTM fields as optional', () => {
    const r = JunkRemovalIntakeSchema.safeParse({
      address: '123 Trash St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      volume_bucket: 'Single couch / armchair',
      pickup_location: 'Curb / driveway',
      preferred_date: isoOffset(1),
      contact_name: 'Pat',
      contact_phone: '512-555-0100',
      contact_email: 'pat@example.com',
      utm_source: 'google',
      utm_campaign: 'sd-junk-launch',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.utm_source).toBe('google');
  });
});

describe('STEPS / STEP_SCHEMAS', () => {
  it('has exactly 4 steps in the canonical order', () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      'location',
      'load',
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
