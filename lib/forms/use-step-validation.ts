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

import { useState, useCallback } from 'react';
import type { z, ZodSchema } from 'zod';

export type FieldErrors = Record<string, string>;

export function useStepValidation<T extends ZodSchema>(schema: T) {
  const [errors, setErrors] = useState<FieldErrors>({});

  const validate = useCallback(
    (data: unknown): data is z.infer<T> => {
      const result = schema.safeParse(data);
      if (result.success) {
        setErrors({});
        return true;
      }

      // Flatten to { fieldName: firstMessage }. issues[] may have
      // multiple entries per field — we take the first for UX.
      const flat: FieldErrors = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.');
        if (!flat[key]) flat[key] = issue.message;
      }
      setErrors(flat);
      return false;
    },
    [schema]
  );

  const clearError = useCallback((field: string) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const { [field]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  return { errors, validate, clearError };
}
