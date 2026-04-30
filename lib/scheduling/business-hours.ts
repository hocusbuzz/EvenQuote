// Business-hours scheduling for outbound calls (#117).
//
// Why this exists:
//   Customers can submit + pay for a quote request at any time
//   (3am insomnia is real). But calling a cleaning business at 3am
//   has two costs: (1) low pickup → voicemail or no-answer wastes
//   ~$0.20-0.50/call, (2) annoys the cleaner → bad-faith reputation.
//
//   Defer dispatch to local business hours of the SERVICE AREA's
//   timezone (not the customer's, not server UTC). Mon-Fri 9:00 AM
//   to 4:30 PM in the area where the work will happen.
//
// Design notes:
//   • US-only product today. State → IANA timezone map is good enough;
//     a few states straddle two zones (TN, KY, IN, FL panhandle, TX
//     panhandle) — we use the "majority" timezone. The false-positive
//     cost (calling 1h early/late on the boundary) is small enough
//     to accept for v1.
//   • No new npm deps. All math via JS Intl.DateTimeFormat. Keeps
//     bundle small and IANA-tz-correct including DST transitions.
//   • Pure functions. No I/O. Trivial to unit-test by faking `now`.

// ── Constants ─────────────────────────────────────────────────────
//
// Local business-hours window. Inclusive on start, exclusive on end.
// 9:00 ≤ hour < 16:30 → in hours.
//
// Exposed so callers (UI copy, success page) can quote them back to
// the customer without hardcoding the same numbers in two places.
export const BUSINESS_HOURS = Object.freeze({
  startHour: 9,
  startMinute: 0,
  endHour: 16,
  endMinute: 30,
  // 0=Sun, 1=Mon, …, 6=Sat
  workdays: [1, 2, 3, 4, 5] as const,
});

// ── State → IANA timezone ────────────────────────────────────────
//
// Default timezone for each US state. For multi-zone states we pick
// the timezone of the largest population center.
const STATE_TIMEZONES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York', // panhandle is Central; majority is Eastern
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise', // northern panhandle is Pacific; majority is Mountain
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis', // most counties Eastern; some Central
  IA: 'America/Chicago',
  KS: 'America/Chicago', // 4 westernmost counties are Mountain
  KY: 'America/New_York', // western KY is Central; majority is Eastern
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit', // upper peninsula has 4 Central counties
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago', // western panhandle is Mountain
  NV: 'America/Los_Angeles', // small Mountain pocket near Idaho
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago', // western counties are Mountain
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles', // a Mountain sliver in eastern Oregon
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago', // western half is Mountain
  TN: 'America/Chicago', // east TN is Eastern; majority is Central
  TX: 'America/Chicago', // El Paso is Mountain
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  DC: 'America/New_York',
  PR: 'America/Puerto_Rico',
});

// Default fallback when state is missing or unrecognized.
// California because that's where the founder + most early users are.
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Resolve an IANA timezone string from a US state abbreviation or
 * full name. Returns the default (America/Los_Angeles) on unknown
 * input — never throws.
 *
 * Accepts: "CA", "ca", "California", "  ca  ".
 */
export function resolveTimezoneFromState(state: string | null | undefined): string {
  if (!state) return DEFAULT_TIMEZONE;
  const trimmed = state.trim();
  if (!trimmed) return DEFAULT_TIMEZONE;

  // Try as 2-letter abbreviation.
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && STATE_TIMEZONES[upper]) {
    return STATE_TIMEZONES[upper];
  }

  // Try as full name → reverse-lookup via STATE_NAME_TO_ABBR.
  const abbr = FULL_NAME_TO_ABBR[trimmed.toLowerCase()];
  if (abbr && STATE_TIMEZONES[abbr]) {
    return STATE_TIMEZONES[abbr];
  }

  return DEFAULT_TIMEZONE;
}

// Reverse map for full-name lookups. Built once at module load.
const FULL_NAME_TO_ABBR: Readonly<Record<string, string>> = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
  'puerto rico': 'PR',
});

// ── Local-time inspection via Intl.DateTimeFormat ────────────────
//
// JS lacks a built-in "give me hour and weekday in this IANA tz"
// helper, but Intl.DateTimeFormat with `timeZone` gives the right
// answer including DST. We pull both fields in one formatToParts
// call for efficiency.

type LocalParts = {
  hour: number;        // 0–23
  minute: number;      // 0–59
  weekday: number;     // 0=Sun … 6=Sat
};

function localPartsInTz(timezone: string, when: Date): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(when);
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value) % 24; // "24" → 0
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'weekday') weekday = weekdayMap[p.value] ?? 0;
  }
  return { hour, minute, weekday };
}

/**
 * Is the given moment within Mon-Fri 9:00 AM – 4:30 PM in the given
 * IANA timezone? Defaults `when` to "now".
 *
 * Boundary semantics:
 *   • 9:00 AM exactly → in hours.
 *   • 4:30 PM exactly → OUT of hours (we don't dispatch new batches
 *     at the close — they'd run past 4:30 and into customer dinner
 *     time).
 */
export function isBusinessHoursLocal(timezone: string, when: Date = new Date()): boolean {
  const { hour, minute, weekday } = localPartsInTz(timezone, when);

  // Workday check.
  if (!BUSINESS_HOURS.workdays.includes(weekday as 1 | 2 | 3 | 4 | 5)) {
    return false;
  }

  // Time-of-day check. Compare in minutes-since-midnight to avoid
  // off-by-half-hour bugs at 16:30.
  const minutesSinceMidnight = hour * 60 + minute;
  const startMinutes = BUSINESS_HOURS.startHour * 60 + BUSINESS_HOURS.startMinute;
  const endMinutes = BUSINESS_HOURS.endHour * 60 + BUSINESS_HOURS.endMinute;

  return minutesSinceMidnight >= startMinutes && minutesSinceMidnight < endMinutes;
}

/**
 * Returns the next moment that is INSIDE business hours for the given
 * timezone, starting from `from` (default now). If `from` is already
 * in business hours, returns `from` unchanged.
 *
 * Algorithm:
 *   1. If already in hours → return as-is.
 *   2. Compute "today 9:00 AM local" — if `from` is before 9:00 AM
 *      on a workday, that's the answer.
 *   3. Otherwise advance one day at a time (up to 7 iterations) and
 *      return the first workday's 9:00 AM that's strictly after `from`.
 *
 * Returned Date is in UTC (a JS Date is always UTC internally), but
 * its calendar instant corresponds to 9:00 AM in the target timezone.
 */
export function nextBusinessHourStart(
  timezone: string,
  from: Date = new Date(),
): Date {
  if (isBusinessHoursLocal(timezone, from)) return from;

  // Strategy: we know the local hour:minute of `from`. We want a Date
  // representing 9:00 AM local on the next workday at-or-after today.
  //
  // The trick is converting "9:00 AM local on date X in tz Z" into a
  // UTC Date. We do that by formatting `from` in the target tz to get
  // its local YYYY-MM-DD, then constructing a candidate UTC instant
  // and adjusting by the tz offset.

  // Iterate up to 8 days forward (covers any wkday/Friday/holiday gap).
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidate = candidateLocalNineAm(timezone, from, dayOffset);
    if (candidate.getTime() <= from.getTime()) continue; // not strictly after `from`
    if (isBusinessHoursLocal(timezone, candidate)) return candidate;
  }

  // Pathological fallback: should never hit this in practice.
  // Return `from + 24h` as a last resort.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Build a Date corresponding to 09:00 local time in `timezone` on the
 * day that is `dayOffset` days after the local date of `fromUtc`.
 *
 * Implementation: format `fromUtc` to extract the local YYYY-MM-DD
 * for the tz, increment the day, then synthesize the UTC instant
 * that represents 09:00:00 local on that date.
 */
function candidateLocalNineAm(
  timezone: string,
  fromUtc: Date,
  dayOffset: number,
): Date {
  // Get the local Y/M/D in the target tz for `fromUtc`.
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dateFmt.formatToParts(fromUtc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const y = get('year');
  const m = get('month');
  const d = get('day') + dayOffset;

  // Construct a "naive" UTC instant for 09:00 on Y/M/D (any month
  // overflow handled by Date constructor).
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, BUSINESS_HOURS.startHour, BUSINESS_HOURS.startMinute, 0));

  // The naive instant has a tz offset bug — we labeled UTC midnight
  // 09:00 but in the target zone it's actually offset hours off.
  // Compute the actual offset for that instant in target tz and
  // shift back so the local-time display lines up.
  const tzMinutesOffset = utcMinusLocalOffsetMinutes(timezone, naiveUtc);
  return new Date(naiveUtc.getTime() + tzMinutesOffset * 60 * 1000);
}

/**
 * For a given Date and target timezone, returns how many minutes
 * UTC is AHEAD of local. Example: tz=America/Los_Angeles, date in
 * July → returns 420 (UTC is 7 hours ahead of PDT).
 *
 * Handles DST correctly because we ask Intl for the local time of
 * a real instant, not for a fixed offset.
 */
function utcMinusLocalOffsetMinutes(timezone: string, when: Date): number {
  // Format `when` as if it were UTC, and compare with formatting it
  // in the target timezone. The difference is the offset we need.
  const localFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const utcFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localTs = partsToTs(localFmt.formatToParts(when));
  const utcTs = partsToTs(utcFmt.formatToParts(when));
  return Math.round((utcTs - localTs) / 60000);
}

function partsToTs(parts: Intl.DateTimeFormatPart[]): number {
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    0,
  );
}
