// Tests for the shared FormField wrapper.
//
// Covers the accessibility contract:
//   - label uses htmlFor / points at the input id
//   - required indicator is visually '*' AND screen-reader-visible
//     as "(required)"
//   - when error is set, the input gets aria-invalid="true" and
//     aria-describedby pointing at the rendered error paragraph
//   - when hint is set (and no error), aria-describedby points at hint
//   - when neither error nor hint is set, no aria-describedby is added
//   - caller-supplied aria-describedby is preserved (space-joined)

import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FormField } from './form-field';

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

describe('FormField', () => {
  it('wires label htmlFor to the child input id', () => {
    const html = render(
      <FormField label="ZIP code" htmlFor="zip">
        <input id="zip" />
      </FormField>
    );
    expect(html).toMatch(/<label[^>]*for="zip"/);
  });

  it('marks required fields visibly and to screen readers', () => {
    const html = render(
      <FormField label="Email" htmlFor="email" required>
        <input id="email" />
      </FormField>
    );
    // Visible asterisk is aria-hidden so it isn't read twice.
    expect(html).toMatch(/aria-hidden="true"[^>]*>\*/);
    // sr-only text "(required)" for screen readers.
    expect(html).toMatch(/class="sr-only"[^>]*>\(required\)/);
  });

  it('adds aria-invalid and aria-describedby when error is set', () => {
    const html = render(
      <FormField label="Email" htmlFor="email" error="Not a valid email">
        <input id="email" />
      </FormField>
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="email-error"');
    // Error message has the matching id and role="alert".
    expect(html).toMatch(/<p id="email-error"[^>]*role="alert"[^>]*>Not a valid email<\/p>/);
  });

  it('uses the hint id for aria-describedby when no error is present', () => {
    const html = render(
      <FormField label="ZIP" htmlFor="zip" hint="Helps us pick launch cities">
        <input id="zip" />
      </FormField>
    );
    expect(html).toContain('aria-describedby="zip-hint"');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).toMatch(/<p id="zip-hint"[^>]*>Helps us pick launch cities<\/p>/);
  });

  it('prefers error over hint when both are provided', () => {
    const html = render(
      <FormField
        label="ZIP"
        htmlFor="zip"
        hint="Optional"
        error="Must be 5 digits"
      >
        <input id="zip" />
      </FormField>
    );
    expect(html).toContain('aria-describedby="zip-error"');
    expect(html).not.toContain('aria-describedby="zip-hint"');
    // Hint is suppressed when error shows so we don't double-describe.
    expect(html).not.toContain('Optional</p>');
  });

  it('omits aria-describedby / aria-invalid when neither error nor hint is present', () => {
    const html = render(
      <FormField label="Name" htmlFor="name">
        <input id="name" />
      </FormField>
    );
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
  });

  it('preserves a caller-supplied aria-describedby by space-joining', () => {
    const html = render(
      <FormField label="Email" htmlFor="email" error="Bad">
        <input id="email" aria-describedby="newsletter-disclaimer" />
      </FormField>
    );
    expect(html).toMatch(/aria-describedby="newsletter-disclaimer email-error"/);
  });
});
