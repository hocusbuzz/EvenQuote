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
  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={htmlFor} className="flex items-center gap-1">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
