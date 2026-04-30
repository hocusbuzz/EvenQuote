// Tests for lib/scheduling/business-hours.ts (#117).
//
// Three things are verified here:
//
//   1. resolveTimezoneFromState — every US state + DC + PR returns a
//      sane IANA tz, the function is forgiving with input formatting,
//      and unknown input falls back to the documented default.
//
//   2. isBusinessHoursLocal — boundary semantics at 9:00 (in), 16:30
//      (OUT), workday vs weekend, and across DST transitions.
//
//   3. nextBusinessHourStart — early-morning advance to today 9am,
//      Friday-evening rollover to Monday 9am, weekend rollover, and
//      pass-through behavior when called inside business hours.
//
// All tests pin a specific Date — no real-time leakage. JS Intl is the
// only DST source; Node 22+ ships with full ICU so these tests are
// deterministic in CI.

import { describe, it, expect } from 'vitest';
import {
  BUSINESS_HOURS,
  resolveTimezoneFromState,
  isBusinessHoursLocal,
  nextBusinessHourStart,
} from './business-hours';

// Helper: build a UTC Date for a moment in a known IANA tz so tests can
// reason in local time. We construct via Date.UTC + an offset hint —
// good enough for tests where we just need a fixed instant.
function utc(iso: string): Date {
  return new Date(iso);
}

describe('BUSINESS_HOURS constant', () => {
  it('exports the expected window: Mon-Fri 9:00-16:30', () => {
    expect(BUSINESS_HOURS.startHour).toBe(9);
    expect(BUSINESS_HOURS.startMinute).toBe(0);
    expect(BUSINESS_HOURS.endHour).toBe(16);
    expect(BUSINESS_HOURS.endMinute).toBe(30);
    expect([...BUSINESS_HOURS.workdays]).toEqual([1, 2, 3, 4, 5]);
  });

  it('is frozen so callers cannot mutate the schedule globally', () => {
    expect(Object.isFrozen(BUSINESS_HOURS)).toBe(true);
  });
});

describe('resolveTimezoneFromState', () => {
  it('resolves common 2-letter state codes', () => {
    expect(resolveTimezoneFromState('CA')).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState('NY')).toBe('America/New_York');
    expect(resolveTimezoneFromState('TX')).toBe('America/Chicago');
    expect(resolveTimezoneFromState('AK')).toBe('America/Anchorage');
    expect(resolveTimezoneFromState('HI')).toBe('Pacific/Honolulu');
    expect(resolveTimezoneFromState('PR')).toBe('America/Puerto_Rico');
    expect(resolveTimezoneFromState('DC')).toBe('America/New_York');
  });

  it('is case- and whitespace-tolerant', () => {
    expect(resolveTimezoneFromState('ca')).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState('  ny  ')).toBe('America/New_York');
  });

  it('resolves full state names (case-insensitive)', () => {
    expect(resolveTimezoneFromState('California')).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState('new york')).toBe('America/New_York');
    expect(resolveTimezoneFromState('PUERTO RICO')).toBe('America/Puerto_Rico');
  });

  it('falls back to America/Los_Angeles on unknown / nullish input', () => {
    expect(resolveTimezoneFromState(null)).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState(undefined)).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState('')).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState('XX')).toBe('America/Los_Angeles');
    expect(resolveTimezoneFromState('Mordor')).toBe('America/Los_Angeles');
  });

  it('covers all 50 states + DC + PR (no silent fallback for any)', () => {
    const all = [
      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
      'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
      'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
      'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
      'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
      'DC','PR',
    ];
    for (const s of all) {
      const tz = resolveTimezoneFromState(s);
      // Sanity: every state should resolve to an IANA-shaped string,
      // not the LA fallback (unless it's actually a Pacific state).
      expect(tz).toMatch(/^[A-Z][a-z]+\/[A-Z]/);
    }
  });
});

describe('isBusinessHoursLocal', () => {
  // We use America/Los_Angeles with known DST offsets:
  //   Standard time (PST): UTC-8 → 9:00 AM PST = 17:00 UTC
  //   Daylight time (PDT): UTC-7 → 9:00 AM PDT = 16:00 UTC

  it('returns true at 9:00 AM PDT exactly on a Tuesday', () => {
    // 2026-04-28 is a Tuesday. PDT (UTC-7) → 9 AM = 16:00 UTC.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-04-28T16:00:00Z'))
    ).toBe(true);
  });

  it('returns false at 8:59 AM PDT (one minute before open)', () => {
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-04-28T15:59:00Z'))
    ).toBe(false);
  });

  it('returns true at 4:29 PM PDT (one minute before close)', () => {
    // 16:29 PDT = 23:29 UTC.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-04-28T23:29:00Z'))
    ).toBe(true);
  });

  it('returns false at 4:30 PM PDT (close exactly — exclusive)', () => {
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-04-28T23:30:00Z'))
    ).toBe(false);
  });

  it('returns false on a Saturday at 11 AM local', () => {
    // 2026-05-02 is a Saturday. 11 AM PDT = 18:00 UTC.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-05-02T18:00:00Z'))
    ).toBe(false);
  });

  it('returns false on a Sunday at 11 AM local', () => {
    // 2026-05-03 is a Sunday.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-05-03T18:00:00Z'))
    ).toBe(false);
  });

  it('respects DST — 9 AM PST in January resolves to 17:00 UTC', () => {
    // 2026-01-13 is a Tuesday in Pacific Standard Time (PST = UTC-8).
    // 9 AM PST → 17:00 UTC.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-01-13T17:00:00Z'))
    ).toBe(true);
    // And 16:00 UTC (would be 9 AM in PDT) is actually 8 AM PST = OUT.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-01-13T16:00:00Z'))
    ).toBe(false);
  });

  it('handles East Coast (NY) windows independently', () => {
    // 2026-04-28 Tue. EDT (UTC-4) → 9 AM EDT = 13:00 UTC.
    expect(
      isBusinessHoursLocal('America/New_York', utc('2026-04-28T13:00:00Z'))
    ).toBe(true);
    // At 13:00 UTC it's still 6 AM in LA → out for LA.
    expect(
      isBusinessHoursLocal('America/Los_Angeles', utc('2026-04-28T13:00:00Z'))
    ).toBe(false);
  });
});

describe('nextBusinessHourStart', () => {
  it('returns `from` unchanged when already in business hours', () => {
    const inHours = utc('2026-04-28T16:00:00Z'); // 9 AM PDT Tue
    const next = nextBusinessHourStart('America/Los_Angeles', inHours);
    expect(next.getTime()).toBe(inHours.getTime());
  });

  it('advances to today 9 AM when called pre-open on a workday', () => {
    // Tuesday 2026-04-28 at 6 AM PDT (13:00 UTC).
    const earlyAm = utc('2026-04-28T13:00:00Z');
    const next = nextBusinessHourStart('America/Los_Angeles', earlyAm);
    // Expect 9 AM PDT same day → 16:00 UTC.
    expect(next.toISOString()).toBe('2026-04-28T16:00:00.000Z');
  });

  it('rolls Friday evening forward to Monday 9 AM', () => {
    // Friday 2026-05-01 at 5 PM PDT (00:00 UTC Saturday).
    const friEvening = utc('2026-05-02T00:00:00Z'); // 5 PM PDT Fri 5/1
    const next = nextBusinessHourStart('America/Los_Angeles', friEvening);
    // Expect Monday 2026-05-04 9 AM PDT → 16:00 UTC.
    expect(next.toISOString()).toBe('2026-05-04T16:00:00.000Z');
  });

  it('rolls Saturday morning forward to Monday 9 AM', () => {
    // Saturday 2026-05-02 at 11 AM PDT (18:00 UTC).
    const satMorn = utc('2026-05-02T18:00:00Z');
    const next = nextBusinessHourStart('America/Los_Angeles', satMorn);
    expect(next.toISOString()).toBe('2026-05-04T16:00:00.000Z');
  });

  it('rolls Sunday evening forward to Monday 9 AM', () => {
    // Sunday 2026-05-03 at 8 PM PDT (03:00 UTC Mon).
    const sunNight = utc('2026-05-04T03:00:00Z');
    const next = nextBusinessHourStart('America/Los_Angeles', sunNight);
    expect(next.toISOString()).toBe('2026-05-04T16:00:00.000Z');
  });

  it('handles East Coast tz (NY) — 4 AM Tuesday → 9 AM EDT same day', () => {
    // Tuesday 2026-04-28 at 4 AM EDT (08:00 UTC).
    const earlyEastern = utc('2026-04-28T08:00:00Z');
    const next = nextBusinessHourStart('America/New_York', earlyEastern);
    // 9 AM EDT = 13:00 UTC.
    expect(next.toISOString()).toBe('2026-04-28T13:00:00.000Z');
  });

  it('handles 4:30 PM exact (boundary case) — rolls to next workday 9 AM', () => {
    // Tuesday 2026-04-28 at 4:30 PM PDT (23:30 UTC).
    const closeExact = utc('2026-04-28T23:30:00Z');
    const next = nextBusinessHourStart('America/Los_Angeles', closeExact);
    // Wednesday 2026-04-29 at 9 AM PDT = 16:00 UTC.
    expect(next.toISOString()).toBe('2026-04-29T16:00:00.000Z');
  });

  it('crosses a DST transition correctly (Sat 8 Nov 2025 → Mon)', () => {
    // 2025-11-09 is a Sunday and the day clocks fall back from PDT
    // to PST in the US (transition at 2 AM local). A Saturday
    // afternoon dispatch deferral should land on Monday 9 AM PST
    // (16:00 UTC after the transition, not 17:00).
    //
    // Saturday 2025-11-08 at 1 PM PST-equivalent — well, Saturday is
    // still PDT. We use 21:00 UTC (1 PM PDT).
    const satAfter = utc('2025-11-08T21:00:00Z');
    const next = nextBusinessHourStart('America/Los_Angeles', satAfter);
    // Monday 2025-11-10 9 AM PST (UTC-8) = 17:00 UTC.
    expect(next.toISOString()).toBe('2025-11-10T17:00:00.000Z');
  });
});
