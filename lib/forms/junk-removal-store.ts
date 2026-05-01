'use client';

// Zustand store for the junk-removal intake form.
//
// Parallels lib/forms/lawn-care-store.ts and the other vertical stores
// — separate localStorage key per vertical so drafts don't leak. Same
// hydration + analytics one-shot patterns; see lib/forms/intake-store.ts
// for the full rationale on each.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { JunkRemovalIntakeDraft, StepId } from '@/lib/forms/junk-removal-intake';
import { trackClient } from '@/lib/analytics/track';

const STORE_VERSION = 1;

type JunkRemovalIntakeStore = {
  draft: JunkRemovalIntakeDraft;
  setField: <K extends keyof JunkRemovalIntakeDraft>(
    key: K,
    value: JunkRemovalIntakeDraft[K]
  ) => void;
  setFields: (updates: Partial<JunkRemovalIntakeDraft>) => void;

  currentStep: StepId;
  setStep: (step: StepId) => void;

  // See lib/forms/intake-store.ts for the rationale on the `started`
  // one-shot flag — same pattern, vertical-tagged event.
  started: boolean;

  reset: () => void;
};

export const useJunkRemovalStore = create<JunkRemovalIntakeStore>()(
  persist(
    (set) => ({
      draft: {},
      setField: (key, value) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, [key]: value },
          } as Partial<JunkRemovalIntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'junk-removal' });
            next.started = true;
          }
          return next;
        }),
      setFields: (updates) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, ...updates },
          } as Partial<JunkRemovalIntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'junk-removal' });
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
      name: 'evenquote:intake:junk-removal',
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
 * Hook returning `true` once the junk-removal store has rehydrated
 * from localStorage. Identical pattern to the other intake stores.
 */
export function useIsJunkRemovalHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useJunkRemovalStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useJunkRemovalStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return () => unsub();
  }, []);

  return hydrated;
}
