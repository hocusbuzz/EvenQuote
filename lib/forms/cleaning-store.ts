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
import { trackClient } from '@/lib/analytics/track';

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

  // See lib/forms/intake-store.ts for the rationale on the `started`
  // one-shot flag — same pattern, vertical-tagged event.
  started: boolean;

  reset: () => void;
};

export const useCleaningStore = create<CleaningIntakeStore>()(
  persist(
    (set) => ({
      draft: {},
      setField: (key, value) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, [key]: value },
          } as Partial<CleaningIntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'cleaning' });
            next.started = true;
          }
          return next;
        }),
      setFields: (updates) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, ...updates },
          } as Partial<CleaningIntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'cleaning' });
            next.started = true;
          }
          return next;
        }),

      currentStep: 'location',
      setStep: (step) => set({ currentStep: step }),

      started: false,
      reset: () => set({ draft: {}, currentStep: 'location', started: false }),
    }),
    {
      name: 'evenquote:intake:cleaning',
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        draft: state.draft,
        currentStep: state.currentStep,
        started: state.started,
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
