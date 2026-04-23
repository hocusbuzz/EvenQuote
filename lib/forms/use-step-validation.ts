'use client';

// Hook that powers per-step validation.
//
// Each step component calls `validate()` when the user clicks Next.
// If Zod rejects, `errors` is populated by field name and the step
// stays put. If Zod accepts, returns true and the step component
// calls setStep() to advance.
//
// We flatten ZodError into { [fieldName]: firstMessage } because that's
// what the FormField component expects. Nested paths aren't needed for
// this flat form.
//
// The pure helpers (`flattenZodIssues`, `dropFieldError`) are exported
// separately from the hook so they can be unit-tested without a React
// render context. The hook itself is a thin adapter around them.

import { useState, useCallback } from 'react';
import type { z, ZodSchema, ZodIssue } from 'zod';

export type FieldErrors = Record<string, string>;

/**
 * Flatten a ZodError.issues[] into { fieldName: firstMessage }.
 *
 * issues[] may contain multiple entries for the same field — we keep
 * only the first so the UI shows one error per field. Nested paths are
 * joined with '.' (e.g., ['address', 'postcode'] → 'address.postcode').
 *
 * Pure. No React, no side effects.
 */
export function flattenZodIssues(issues: readonly ZodIssue[]): FieldErrors {
  const flat: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.join('.');
    if (!flat[key]) flat[key] = issue.message;
  }
  return flat;
}

/**
 * Immutable delete: returns a new errors object with `field` removed.
 * Returns the input unchanged (same reference) if the field isn't
 * present, so React can skip re-renders.
 *
 * Pure. No React, no side effects.
 */
export function dropFieldError(prev: FieldErrors, field: string): FieldErrors {
  if (!prev[field]) return prev;
  // Avoid unused-var lint on rest-destructure discard
  const rest = { ...prev };
  delete rest[field];
  return rest;
}

export function useStepValidation<T extends ZodSchema>(schema: T) {
  const [errors, setErrors] = useState<FieldErrors>({});

  const validate = useCallback(
    (data: unknown): data is z.infer<T> => {
      const result = schema.safeParse(data);
      if (result.success) {
        setErrors({});
        return true;
      }
      setErrors(flattenZodIssues(result.error.issues));
      return false;
    },
    [schema]
  );

  const clearError = useCallback((field: string) => {
    setErrors((prev) => dropFieldError(prev, field));
  }, []);

  return { errors, validate, clearError };
}
