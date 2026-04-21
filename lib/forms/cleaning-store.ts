'use client';

// Zustand store for the cleaning intake form.
//
// Parallels lib/forms/intake-store.ts (moving) but with a separate
// localStorage key so users filling one vertical don't leak draft
// state into another. Bump STORE_VERSION on breaking shape changes.
//
// Hydration pattern is identical to the moving store — see comments
// there for the rationale on useIsHydrated.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CleaningIntakeDraft, StepId } from '@/lib/forms/cleaning-intake';

const STORE_VERSION = 1;

type CleaningIntakeStore = {
  draft: CleaningIntakeDraft;
  setField: <K extends keyof CleaningIntakeDraft>(
    key: K,
    value: CleaningIntakeDraft[K]
  ) => void;
  setFields: (updates: Partial<CleaningIntakeDraft>) => void;

  currentStep: StepId;
  setStep: (step: StepId) => void;

  reset: () => void;
};

export const useCleaningStore = create<CleaningIntakeStore>()(
  persist(
    (set) => ({
      draft: {},
      setField: (key, value) =>
        set((state) => ({ draft: { ...state.draft, [key]: value } })),
      setFields: (updates) =>
        set((state) => ({ draft: { ...state.draft, ...updates } })),

      currentStep: 'location',
      setStep: (step) => set({ currentStep: step }),

      reset: () => set({ draft: {}, currentStep: 'location' }),
    }),
    {
      name: 'evenquote:intake:cleaning',
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        draft: state.draft,
        currentStep: state.currentStep,
      }),
    }
  )
);

/**
 * Hook returning `true` once the cleaning store has rehydrated from
 * localStorage. Identical pattern to useIsHydrated in intake-store.ts.
 */
export function useIsCleaningHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useCleaningStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useCleaningStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return () => unsub();
  }, []);

  return hydrated;
}
