// US state abbreviation → full name expansion.
//
// Why this exists:
//   The Vapi assistant TTS reads "CA" as "see-ay" letter-by-letter,
//   which sounds robotic and unprofessional on a first impression
//   ("Hi, I'm calling on behalf of a customer in San Marcos, see-ay…").
//   Expanding to the full name before passing as a variableValue
//   gives natural speech: "…in San Marcos, California…".
//
// Idempotent: passing "California" returns "California". Unknown
// inputs (typos, future bad data, "ZZ") pass through unchanged
// rather than throwing — the caller's prompt template will just
// render whatever it gets.

const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
  PR: 'Puerto Rico',
});

/**
 * Expand a US state abbreviation to its full name. Idempotent on
 * already-expanded values. Returns the input unchanged if no match
 * (defense against typos / future bad data — no throw).
 */
export function expandStateAbbr(input: string | null | undefined): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (trimmed.length !== 2) return trimmed; // already expanded or non-abbr
  const upper = trimmed.toUpperCase();
  return STATE_NAMES[upper] ?? trimmed;
}
