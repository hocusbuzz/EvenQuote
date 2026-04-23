import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  flattenZodIssues,
  dropFieldError,
  type FieldErrors,
} from './use-step-validation';

// Tests target the pure helpers that back the hook. The hook itself is
// a 3-line adapter (useState + useCallback) around these — covering the
// adapter would require @testing-library/react, which isn't in this
// project. The decision to extract pure helpers is what makes this
// testable without a DOM renderer.

describe('flattenZodIssues', () => {
  it('returns an empty object when given no issues', () => {
    expect(flattenZodIssues([])).toEqual({});
  });

  it('takes the first message per field when a field has multiple issues', () => {
    // Zod can emit multiple issues per path (e.g., min + regex). The UI
    // only has space for one line, so we intentionally keep the first.
    const schema = z.object({
      email: z.string().min(5, 'too short').email('not an email'),
    });
    const result = schema.safeParse({ email: 'x' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const flat = flattenZodIssues(result.error.issues);
    // exactly one entry per field
    expect(Object.keys(flat)).toEqual(['email']);
    // first issue wins — whichever Zod emits first stays
    expect(flat.email).toBe(result.error.issues[0].message);
  });

  it('joins nested paths with a dot', () => {
    const schema = z.object({
      address: z.object({
        postcode: z.string().min(5, 'postcode too short'),
      }),
    });
    const result = schema.safeParse({ address: { postcode: '' } });
    expect(result.success).toBe(false);
    if (result.success) return;

    const flat = flattenZodIssues(result.error.issues);
    expect(flat['address.postcode']).toBe('postcode too short');
  });

  it('uses the top-level key name for flat schemas', () => {
    const schema = z.object({
      name: z.string().min(1, 'required'),
      phone: z.string().regex(/^\d+$/, 'digits only'),
    });
    const result = schema.safeParse({ name: '', phone: 'abc' });
    expect(result.success).toBe(false);
    if (result.success) return;

    const flat = flattenZodIssues(result.error.issues);
    expect(flat).toEqual({ name: 'required', phone: 'digits only' });
  });

  it('produces an empty-string key for a root-level validation', () => {
    // Root-level refinement has issue.path = [] which joins to ''.
    // Documented here so a future caller knows what to expect.
    const schema = z.string().refine((v) => v.length > 0, { message: 'empty' });
    const result = schema.safeParse('');
    expect(result.success).toBe(false);
    if (result.success) return;

    const flat = flattenZodIssues(result.error.issues);
    expect(flat['']).toBe('empty');
  });
});

describe('dropFieldError', () => {
  it('returns the same reference when the field is not present', () => {
    // Reference equality matters — React uses it to skip re-renders.
    const prev: FieldErrors = { email: 'bad' };
    const next = dropFieldError(prev, 'name');
    expect(next).toBe(prev);
  });

  it('returns a new object with the field removed', () => {
    const prev: FieldErrors = { email: 'bad', name: 'required' };
    const next = dropFieldError(prev, 'email');
    expect(next).not.toBe(prev); // reference changed → React re-renders
    expect(next).toEqual({ name: 'required' });
  });

  it('leaves the input object untouched', () => {
    // Immutability guard: dropFieldError must not mutate its input.
    const prev: FieldErrors = { email: 'bad', name: 'required' };
    const snapshot = { ...prev };
    dropFieldError(prev, 'email');
    expect(prev).toEqual(snapshot);
  });

  it('treats an empty-string message as absent (same reference)', () => {
    // Defensive: `prev[field]` is a truthiness check, so an empty string
    // value — while unexpected — is treated as absent. Locking this in
    // because the hook stores only non-empty error messages, so this
    // branch should never fire in practice.
    const prev: FieldErrors = { email: '' };
    const next = dropFieldError(prev, 'email');
    expect(next).toBe(prev);
  });
});
