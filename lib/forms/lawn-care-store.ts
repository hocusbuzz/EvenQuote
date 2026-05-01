'use client';

// Zustand store for the lawn-care intake form.
//
// Parallels lib/forms/handyman-store.ts and the other vertical stores
// but with a separate localStorage key so users filling one vertical
// don't leak draft state into another. Bump STORE_VERSION on breaking
// shape changes.
//
// Hydration pattern + analytics one-shot pattern are identical to the
// other intake stores — see lib/forms/intake-store.ts for the full
// rationale on each.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { LawnCareIntakeDraft, StepId } from '@/lib/forms/lawn-care-intake';
import { trackClient } from '@/lib/analytics/track';

const STORE_VERSION = 1;

type LawnCareIntakeStore = {
  draft: LawnCareIntakeDraft;
  setField: <K extends keyof LawnCareIntakeDraft>(
    key: K,
    value: LawnCareIntakeDraft[K]
  ) => void;
  setFields: (updates: Partial<LawnCareIntakeDraft>) => void;

  currentStep: StepId;
  setStep: (step: StepId) => void;

  // See lib/forms/intake-store.ts for the rationale on the `started`
  // one-shot flag — same pattern, vertical-tagged event.
  started: boolean;

  reset: () => void;
};

export const useLawnCareStore = create<LawnCareIntakeStore>()(
  persist(
    (set) => ({
      draft: {},
      setField: (key, value) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, [key]: value },
          } as Partial<LawnCareIntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'lawn-care' });
            next.started = true;
          }
          return next;
        }),
      setFields: (updates) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, ...updates },
          } as Partial<LawnCareIntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'lawn-care' });
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
      name: 'evenquote:intake:lawn-care',
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
 * Hook returning `true` once the lawn-care store has rehydrated from
 * localStorage. Identical pattern to the other intake stores.
 */
export function useIsLawnCareHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useLawnCareStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useLawnCareStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return () => unsub();
  }, []);

  return hydrated;
}
