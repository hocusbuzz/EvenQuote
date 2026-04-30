import { describe, it, expect } from 'vitest';
import {
  buildSafeVariableValues,
  __ALLOWED_INTAKE_KEYS_FOR_TESTS,
} from './build-safe-variable-values';

// Realistic intake_data shapes for cleaning + moving. Built from the
// actual schemas in lib/forms/cleaning-intake.ts + moving-intake.ts.
// Updated whenever those add/rename keys.

const cleaningIntake = {
  // PII — must NOT appear in output.
  contact_name: 'John Smith',
  contact_phone: '+12163034889',
  contact_email: 'john@hotmail.com',
  address: '1223 El Camino Real',
  lat: 33.0369867,
  lng: -117.29198179999999,

  // Job details — should appear.
  home_size: '2 bedroom',
  bathrooms: '2',
  pets: 'None',
  cleaning_type: 'Standard',
  frequency: 'One-time',
  earliest_date: '2026-05-01',
  extras: ['Inside fridge', 'Inside oven'],
  additional_notes: 'do they take the trash out?',
};

const movingIntake = {
  contact_name: 'Pat Customer',
  contact_phone: '4155550100',
  contact_email: 'pat@example.com',
  origin_address: '100 Old St',
  destination_address: '200 New St',
  origin_lat: 32.0,
  origin_lng: -117.0,
  destination_lat: 33.0,
  destination_lng: -118.0,

  origin_city: 'Oceanside',
  origin_state: 'CA',
  origin_zip: '92054',
  destination_city: 'San Diego',
  destination_state: 'CA',
  destination_zip: '92101',
  home_size: '3 bedroom',
  move_date: '2026-06-15',
  flexible_dates: true,
  special_items: ['Piano', 'Heavy safe'],
  additional_notes: 'fragile mirrors please call (415) 555-0100 ahead',
};

const qrCleaning = {
  intake_data: cleaningIntake,
  city: 'San Marcos',
  state: 'CA',
  zip_code: '92078',
};

const qrMoving = {
  intake_data: movingIntake,
  city: 'Oceanside',
  state: 'CA',
  zip_code: '92054',
};

describe('buildSafeVariableValues — PII contract', () => {
  // ── The big one: PII MUST NOT leak ────────────────────────────────
  // Run on every realistic intake fixture we have, asserting that
  // none of the customer's identifying data shows up in the result.
  describe.each([
    ['cleaning intake', qrCleaning],
    ['moving intake', qrMoving],
  ])('regression suite — %s', (_label, qr) => {
    const out = buildSafeVariableValues(qr);
    const serialized = JSON.stringify(out);

    it('does not expose contact_name', () => {
      expect(out.contact_name).toBeUndefined();
      const intake = qr.intake_data as Record<string, unknown>;
      const name = intake.contact_name as string;
      // Defense-in-depth: serialized JSON must not contain the
      // first OR last name as substrings, anywhere.
      const [first, last] = name.split(' ');
      expect(serialized).not.toContain(first);
      if (last) expect(serialized).not.toContain(last);
    });

    it('does not expose contact_phone (any digit substring)', () => {
      expect(out.contact_phone).toBeUndefined();
      const intake = qr.intake_data as Record<string, unknown>;
      const phone = intake.contact_phone as string;
      // Strip non-digits, then verify the digit run isn't in output.
      const digits = phone.replace(/\D/g, '');
      expect(serialized).not.toContain(digits);
    });

    it('does not expose contact_email', () => {
      expect(out.contact_email).toBeUndefined();
      const intake = qr.intake_data as Record<string, unknown>;
      const email = intake.contact_email as string;
      expect(serialized).not.toContain(email);
    });

    it('does not expose street addresses', () => {
      expect(out.address).toBeUndefined();
      expect(out.origin_address).toBeUndefined();
      expect(out.destination_address).toBeUndefined();
    });

    it('does not expose lat/lng', () => {
      expect(out.lat).toBeUndefined();
      expect(out.lng).toBeUndefined();
      expect(out.origin_lat).toBeUndefined();
      expect(out.origin_lng).toBeUndefined();
      expect(out.destination_lat).toBeUndefined();
      expect(out.destination_lng).toBeUndefined();
    });
  });

  // ── Allowlist contract ─────────────────────────────────────────────
  it('the allowlist set contains zero PII keys', () => {
    const FORBIDDEN = [
      'contact_name',
      'contact_phone',
      'contact_email',
      'address',
      'origin_address',
      'destination_address',
      'lat',
      'lng',
      'origin_lat',
      'origin_lng',
      'destination_lat',
      'destination_lng',
    ];
    for (const k of FORBIDDEN) {
      expect(
        __ALLOWED_INTAKE_KEYS_FOR_TESTS.has(k),
        `Forbidden PII key '${k}' is on the allowlist`,
      ).toBe(false);
    }
  });
});

describe('buildSafeVariableValues — happy-path content', () => {
  it('passes through cleaning job specifics', () => {
    const out = buildSafeVariableValues(qrCleaning);
    expect(out.home_size).toBe('2 bedroom');
    expect(out.bathrooms).toBe('2');
    expect(out.pets).toBe('None');
    expect(out.cleaning_type).toBe('Standard');
    expect(out.frequency).toBe('One-time');
    expect(out.earliest_date).toBe('2026-05-01');
  });

  it('flattens arrays to comma-separated strings', () => {
    const out = buildSafeVariableValues(qrCleaning);
    expect(out.extras).toBe('Inside fridge, Inside oven');
  });

  it('passes through moving job specifics', () => {
    const out = buildSafeVariableValues(qrMoving);
    expect(out.origin_city).toBe('Oceanside');
    expect(out.destination_city).toBe('San Diego');
    expect(out.move_date).toBe('2026-06-15');
    expect(out.flexible_dates).toBe('yes');
    expect(out.special_items).toBe('Piano, Heavy safe');
  });

  it('always sets top-level service-area fields from qr (not intake_data)', () => {
    const out = buildSafeVariableValues(qrCleaning);
    expect(out.city).toBe('San Marcos');
    expect(out.state).toBe('CA');
    expect(out.zip_code).toBe('92078');
  });

  it('handles missing top-level fields as null (no crash)', () => {
    const out = buildSafeVariableValues({
      intake_data: { home_size: '1 bedroom' },
      city: null,
      state: null,
      zip_code: null,
    });
    expect(out.city).toBeNull();
    expect(out.state).toBeNull();
    expect(out.zip_code).toBeNull();
    expect(out.home_size).toBe('1 bedroom');
  });
});

describe('buildSafeVariableValues — additional_notes scrubbing', () => {
  it('scrubs phone hidden in cleaning notes', () => {
    const out = buildSafeVariableValues(qrCleaning);
    // The fixture says "do they take the trash out?" — no PII to scrub.
    expect(out.additional_notes).toBe('do they take the trash out?');
  });

  it('scrubs phone embedded in moving notes', () => {
    const out = buildSafeVariableValues(qrMoving);
    // Fixture has "(415) 555-0100" — must be redacted.
    expect(out.additional_notes).not.toContain('415');
    expect(out.additional_notes).not.toContain('555-0100');
    expect(out.additional_notes).toContain('[redacted]');
    expect(out.additional_notes).toContain('fragile mirrors');
  });

  it('drops additional_notes entirely when scrubbed value is empty', () => {
    const out = buildSafeVariableValues({
      intake_data: { home_size: '1 bedroom', additional_notes: '   ' },
      city: 'X',
      state: 'CA',
      zip_code: '00000',
    });
    expect('additional_notes' in out).toBe(false);
  });
});

describe('buildSafeVariableValues — edge cases', () => {
  it('handles missing intake_data gracefully', () => {
    const out = buildSafeVariableValues({
      intake_data: null,
      city: 'X',
      state: 'CA',
      zip_code: '00000',
    });
    expect(out.city).toBe('X');
    // No intake-data keys present.
    expect(Object.keys(out).filter((k) => k.startsWith('home'))).toEqual([]);
  });

  it('handles undefined values within intake_data', () => {
    const out = buildSafeVariableValues({
      intake_data: { home_size: undefined as unknown as string, pets: null },
      city: 'X',
      state: 'CA',
      zip_code: '00000',
    });
    // home_size is undefined → key not in 'in' check, so it's not added.
    expect('home_size' in out).toBe(false);
    // pets is explicitly null → preserved as null.
    expect(out.pets).toBeNull();
  });

  it('drops unknown / unexpected keys silently', () => {
    const out = buildSafeVariableValues({
      intake_data: {
        home_size: '1 bedroom',
        contact_name: 'Should Not Appear', // PII
        random_new_field: 'should not appear', // not on allowlist
      },
      city: 'X',
      state: 'CA',
      zip_code: '00000',
    });
    expect(out.home_size).toBe('1 bedroom');
    expect('contact_name' in out).toBe(false);
    expect('random_new_field' in out).toBe(false);
  });
});
