import { describe, it, expect } from 'vitest';
import { expandStateAbbr } from './state-name';

describe('expandStateAbbr', () => {
  it('expands all 50 US state abbreviations', () => {
    const cases: Array<[string, string]> = [
      ['AL', 'Alabama'],
      ['AK', 'Alaska'],
      ['AZ', 'Arizona'],
      ['AR', 'Arkansas'],
      ['CA', 'California'],
      ['CO', 'Colorado'],
      ['CT', 'Connecticut'],
      ['DE', 'Delaware'],
      ['FL', 'Florida'],
      ['GA', 'Georgia'],
      ['HI', 'Hawaii'],
      ['ID', 'Idaho'],
      ['IL', 'Illinois'],
      ['IN', 'Indiana'],
      ['IA', 'Iowa'],
      ['KS', 'Kansas'],
      ['KY', 'Kentucky'],
      ['LA', 'Louisiana'],
      ['ME', 'Maine'],
      ['MD', 'Maryland'],
      ['MA', 'Massachusetts'],
      ['MI', 'Michigan'],
      ['MN', 'Minnesota'],
      ['MS', 'Mississippi'],
      ['MO', 'Missouri'],
      ['MT', 'Montana'],
      ['NE', 'Nebraska'],
      ['NV', 'Nevada'],
      ['NH', 'New Hampshire'],
      ['NJ', 'New Jersey'],
      ['NM', 'New Mexico'],
      ['NY', 'New York'],
      ['NC', 'North Carolina'],
      ['ND', 'North Dakota'],
      ['OH', 'Ohio'],
      ['OK', 'Oklahoma'],
      ['OR', 'Oregon'],
      ['PA', 'Pennsylvania'],
      ['RI', 'Rhode Island'],
      ['SC', 'South Carolina'],
      ['SD', 'South Dakota'],
      ['TN', 'Tennessee'],
      ['TX', 'Texas'],
      ['UT', 'Utah'],
      ['VT', 'Vermont'],
      ['VA', 'Virginia'],
      ['WA', 'Washington'],
      ['WV', 'West Virginia'],
      ['WI', 'Wisconsin'],
      ['WY', 'Wyoming'],
    ];
    expect(cases).toHaveLength(50); // 50 US states

    for (const [abbr, name] of cases) {
      expect(expandStateAbbr(abbr)).toBe(name);
    }
  });

  it('expands DC and Puerto Rico', () => {
    expect(expandStateAbbr('DC')).toBe('District of Columbia');
    expect(expandStateAbbr('PR')).toBe('Puerto Rico');
  });

  it('is case-insensitive on the abbreviation', () => {
    expect(expandStateAbbr('ca')).toBe('California');
    expect(expandStateAbbr('Ca')).toBe('California');
    expect(expandStateAbbr('cA')).toBe('California');
  });

  it('trims whitespace before lookup', () => {
    expect(expandStateAbbr('  CA  ')).toBe('California');
  });

  it('passes through already-expanded names (idempotent)', () => {
    expect(expandStateAbbr('California')).toBe('California');
    expect(expandStateAbbr('New York')).toBe('New York');
  });

  it('passes through unknown 2-letter codes unchanged (no throw)', () => {
    expect(expandStateAbbr('ZZ')).toBe('ZZ');
    expect(expandStateAbbr('XX')).toBe('XX');
  });

  it('returns empty string for null / undefined / empty', () => {
    expect(expandStateAbbr(null)).toBe('');
    expect(expandStateAbbr(undefined)).toBe('');
    expect(expandStateAbbr('')).toBe('');
  });
});
