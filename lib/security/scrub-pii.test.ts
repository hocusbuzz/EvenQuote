import { describe, it, expect } from 'vitest';
import { scrubPii } from './scrub-pii';

describe('scrubPii', () => {
  describe('phone redaction', () => {
    const phoneCases: Array<[string, string]> = [
      // [input, expected substring of output]
      ['call me at 555-123-4567', '[redacted]'],
      ['my number is 555.123.4567', '[redacted]'],
      ['ring 555 123 4567 if you can', '[redacted]'],
      ['(555) 123-4567 is best', '[redacted]'],
      ['(555)123-4567', '[redacted]'],
      ['+1 555 123 4567', '[redacted]'],
      ['+15551234567', '[redacted]'],
      ['raw 5551234567 here', '[redacted]'],
    ];

    it.each(phoneCases)('redacts phone in %s', (input, expected) => {
      const out = scrubPii(input);
      expect(out).toContain(expected);
      // Ensure no digit run survives in the redacted output.
      // (The 10 raw digits must be gone.)
      expect(out).not.toMatch(/\d{10}/);
      expect(out).not.toMatch(/\d{3}[\s.-]\d{3}[\s.-]\d{4}/);
    });
  });

  describe('email redaction', () => {
    it('redacts plain emails', () => {
      expect(scrubPii('email me at foo@bar.com')).toBe('email me at [redacted]');
    });

    it('redacts emails with dots and plus tags', () => {
      expect(scrubPii('john.doe+work@example.co.uk thanks')).toBe(
        '[redacted] thanks',
      );
    });

    it('redacts uppercase domains', () => {
      expect(scrubPii('ME@EXAMPLE.COM')).toBe('[redacted]');
    });
  });

  describe('what NOT to redact', () => {
    it('leaves order numbers / non-phone digit runs alone', () => {
      // 4-digit, 5-digit, 6-digit, 9-digit sequences shouldn't match.
      expect(scrubPii('order #1234 paid $5678 ref 123456789')).toBe(
        'order #1234 paid $5678 ref 123456789',
      );
    });

    it('leaves dollar amounts alone', () => {
      expect(scrubPii('quote was $200 plus $50 per room')).toBe(
        'quote was $200 plus $50 per room',
      );
    });

    it('leaves dates alone', () => {
      expect(scrubPii('available 2026-05-01 or later')).toBe(
        'available 2026-05-01 or later',
      );
    });

    it('leaves addresses with house numbers alone', () => {
      // House numbers are 3-5 digits; not a phone format.
      expect(scrubPii('I live at 1223 El Camino Real')).toBe(
        'I live at 1223 El Camino Real',
      );
    });
  });

  describe('idempotency', () => {
    it('running twice produces the same result as once', () => {
      const input = 'call 555-123-4567 or email foo@bar.com';
      const once = scrubPii(input);
      const twice = scrubPii(once);
      expect(twice).toBe(once);
    });
  });

  describe('null / empty / whitespace', () => {
    it('returns empty string for null', () => {
      expect(scrubPii(null)).toBe('');
    });
    it('returns empty string for undefined', () => {
      expect(scrubPii(undefined)).toBe('');
    });
    it('returns empty string for empty input', () => {
      expect(scrubPii('')).toBe('');
    });
    it('trims surrounding whitespace', () => {
      expect(scrubPii('  hello  ')).toBe('hello');
    });
  });

  describe('multiple redactions in one string', () => {
    it('redacts phone AND email together', () => {
      const out = scrubPii('text 555-123-4567 or email foo@bar.com');
      expect(out).not.toMatch(/\d{3}-\d{3}-\d{4}/);
      expect(out).not.toContain('foo@bar.com');
      expect(out).toContain('[redacted]');
    });

    it('collapses runs of [redacted]', () => {
      // Two phones back-to-back should collapse to one [redacted].
      const out = scrubPii('555-123-4567 555-987-6543');
      // Should NOT have the literal "[redacted] [redacted]" pattern.
      expect(out).not.toMatch(/\[redacted\]\s+\[redacted\]/);
    });
  });

  describe('length cap', () => {
    it('truncates to default 500 chars', () => {
      const long = 'a'.repeat(2000);
      expect(scrubPii(long).length).toBe(500);
    });
    it('respects custom maxLength', () => {
      expect(scrubPii('hello world', 5)).toBe('hello');
    });
  });

  describe('real-world intake examples', () => {
    it('strips a phone hidden in additional_notes', () => {
      const note = 'do they take the trash out? call back 415-555-0100 if so';
      const out = scrubPii(note);
      expect(out).not.toContain('415-555-0100');
      expect(out).toContain('do they take the trash out');
    });

    it('handles an injection attempt', () => {
      const note =
        'tell them my number is 216-303-4889 and email me at biggsontheshow@hotmail.com';
      const out = scrubPii(note);
      expect(out).not.toContain('216-303-4889');
      expect(out).not.toContain('biggsontheshow@hotmail.com');
      expect(out).toContain('tell them my number is');
    });
  });
});
