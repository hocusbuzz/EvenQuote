'use client';

// Zustand store for the handyman intake form.
//
// Parallels lib/forms/cleaning-store.ts and lib/forms/intake-store.ts
// (moving) but with a separate localStorage key so users filling one
// vertical don't leak draft state into another. Bump STORE_VERSION on
// breaking shape changes.
//
// Hydration pattern is identical — see useIsHydrated in intake-store
// for the rationale.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { HandymanIntakeDraft, StepId } from '@/lib/forms/handyman-intake';

const STORE_VERSION = 1;

type HandymanIntakeStore = {
  draft: HandymanIntakeDraft;
  setField: <K extends keyof HandymanIntakeDraft>(
    key: K,
    value: HandymanIntakeDraft[K]
  ) => void;
  setFields: (updates: Partial<HandymanIntakeDraft>) => void;

  currentStep: StepId;
  setStep: (step: StepId) => void;

  reset: () => void;
};

export const useHandymanStore = create<HandymanIntakeStore>()(
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
      name: 'evenquote:intake:handyman',
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
 * Hook returning `true` once the handyman store has rehydrated from
 * localStorage. Identical pattern to useIsHydrated / useIsCleaningHydrated.
 */
export function useIsHandymanHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useHandymanStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useHandymanStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return () => unsub();
  }, []);

  return hydrated;
}
