// cn() — the standard shadcn utility. Merges Tailwind classes with
// clsx's conditional syntax, then dedupes via tailwind-merge so that
// later classes beat earlier ones ("p-2 p-4" collapses to "p-4").
//
// This file is created automatically by `shadcn init`, but we define
// it ourselves here so the Phase 3 bundle is self-contained.

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
