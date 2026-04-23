'use client';

// Form field wrapper. Combines:
//   - a Label (shadcn, tied to the input via htmlFor)
//   - slot for the input
//   - optional hint text
//   - optional error message (rendered only when present)
//
// Use pattern:
//   <FormField label="ZIP code" htmlFor="origin_zip" error={errors.origin_zip}>
//     <Input id="origin_zip" value={...} onChange={...} />
//   </FormField>
//
// Accessibility:
//   When `error` or `hint` is present, we clone the input child to add
//   `aria-describedby` (wiring the input to whichever message is shown)
//   and `aria-invalid="true"` (when error set). Screen readers then
//   announce "ZIP code, invalid entry, <error message>" on focus instead
//   of silently dropping the user into a textbox with no feedback.
//
// Keeps step components much tidier than inlining label + error markup.

import * as React from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Props = {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
};

export function FormField({ label, htmlFor, hint, error, required, children, className }: Props) {
  const errorId = error ? `${htmlFor}-error` : undefined;
  const hintId = hint && !error ? `${htmlFor}-hint` : undefined;
  const describedBy = errorId ?? hintId;

  // Only clone when we actually have something to describe. Avoids
  // silently adding attributes to every child, which can break
  // compound children like radix Select where the direct child is a
  // trigger wrapper, not the underlying input.
  const enhancedChildren = describedBy
    ? React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const existingProps = child.props as {
          'aria-describedby'?: string;
          'aria-invalid'?: boolean | 'true' | 'false';
        };
        // Preserve any caller-supplied aria-describedby by space-joining.
        const merged = [existingProps['aria-describedby'], describedBy]
          .filter(Boolean)
          .join(' ');
        return React.cloneElement(child, {
          'aria-describedby': merged,
          'aria-invalid': error ? true : existingProps['aria-invalid'],
        } as Record<string, unknown>);
      })
    : children;

  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={htmlFor} className="flex items-center gap-1">
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">(required)</span> : null}
      </Label>
      {enhancedChildren}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
