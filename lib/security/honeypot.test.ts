// Tests for the form honeypot module.
//
// Locks:
//   • field name + generic-error string (UI + server depend on these
//     being stable; renaming requires a coordinated update)
//   • detection truth-table for the various non-string and edge-case
//     payload shapes we'll see in the wild
//   • the "trip is silent" contract — generic error is GENERIC, not a
//     bot-aware "honeypot tripped" string

import { describe, it, expect } from 'vitest';
import {
  HONEYPOT_FIELD_NAME,
  HONEYPOT_GENERIC_ERROR,
  isHoneypotTripped,
} from './honeypot';

describe('HONEYPOT_FIELD_NAME', () => {
  it('is the bait-shaped name "website_url" (UI + server depend on this)', () => {
    expect(HONEYPOT_FIELD_NAME).toBe('website_url');
  });
});

describe('HONEYPOT_GENERIC_ERROR', () => {
  it('does NOT mention "honeypot", "bot", or "spam" (must look like a real save error)', () => {
    const lower = HONEYPOT_GENERIC_ERROR.toLowerCase();
    expect(lower).not.toContain('honeypot');
    expect(lower).not.toContain('bot');
    expect(lower).not.toContain('spam');
    expect(lower).not.toContain('detected');
  });

  it('matches the same shape as a generic save-failure message', () => {
    expect(HONEYPOT_GENERIC_ERROR).toMatch(/save|try again/i);
  });
});

describe('isHoneypotTripped', () => {
  it('returns false for a plain payload without the field', () => {
    expect(isHoneypotTripped({ contact_email: 'a@b.com' })).toBe(false);
  });

  it('returns false when the field is undefined', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: undefined })).toBe(false);
  });

  it('returns false when the field is null', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: null })).toBe(false);
  });

  it('returns false when the field is an empty string', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: '' })).toBe(false);
  });

  it('returns false when the field is whitespace only', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: '   \t\n  ' })).toBe(false);
  });

  it('returns true when the field has any non-whitespace content', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 'http://spam.com' })).toBe(
      true,
    );
  });

  it('returns true even for a single character', () => {
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 'x' })).toBe(true);
  });

  it('returns true when the field is a non-string type (bot signal)', () => {
    // A real human textarea cannot submit anything but a string; a
    // boolean / number / object in this slot means a script bypassed
    // the form entirely.
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: true })).toBe(true);
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: 1 })).toBe(true);
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: { spam: 'yes' } })).toBe(true);
    expect(isHoneypotTripped({ [HONEYPOT_FIELD_NAME]: ['a', 'b'] })).toBe(true);
  });

  it('returns false for non-object payloads (defensive — would fail Zod anyway)', () => {
    expect(isHoneypotTripped(null)).toBe(false);
    expect(isHoneypotTripped(undefined)).toBe(false);
    expect(isHoneypotTripped('not an object')).toBe(false);
    expect(isHoneypotTripped(42)).toBe(false);
  });

  it('does not look at any field other than the honeypot field', () => {
    expect(
      isHoneypotTripped({
        contact_name: 'looks like a bot',
        url: 'http://spam.com', // wrong field name — ignored
        link: 'http://spam.com', // wrong field name — ignored
      }),
    ).toBe(false);
  });
});
