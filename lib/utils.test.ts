// Tests for the cn() helper. Small but worth locking in because
// multiple components rely on tailwind-merge semantics (later class
// beats earlier) — if that behavior regresses we want to know.

import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn()', () => {
  it('joins strings with spaces', () => {
    expect(cn('p-2', 'text-sm')).toBe('p-2 text-sm');
  });

  it('filters falsy values (clsx semantics)', () => {
    expect(cn('p-2', false && 'hidden', null, undefined, '')).toBe('p-2');
  });

  it('respects object/array conditional syntax', () => {
    expect(cn('p-2', { 'text-red-500': true, 'text-blue-500': false })).toBe(
      'p-2 text-red-500'
    );
    expect(cn(['p-2', 'text-sm'], 'font-bold')).toBe('p-2 text-sm font-bold');
  });

  it('dedupes conflicting Tailwind classes — later wins', () => {
    // Core contract: tailwind-merge must collapse same-category classes.
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    expect(cn('bg-white', 'bg-background')).toBe('bg-background');
  });

  it('keeps non-conflicting classes untouched', () => {
    const result = cn('p-2', 'text-sm', 'font-bold');
    expect(result).toContain('p-2');
    expect(result).toContain('text-sm');
    expect(result).toContain('font-bold');
  });

  it('returns empty string for all-falsy input', () => {
    expect(cn(false, null, undefined, '')).toBe('');
  });
});
