'use client';

// Zustand store for captured UTMs.
//
// Mirrors the shape used by lib/forms/intake-store.ts (persist
// middleware + hydration hook + bumpable version), but lives separately
// from the intake stores because UTMs are cross-vertical and
// session-scoped attribution metadata, not form data.
//
// Persistence: localStorage. We want a UTM captured on /get-quotes
// (the picker page) to survive a navigation to /get-quotes/handyman
// AND a refresh, so the field-out submit still ties back to the ad.
// We do NOT clear them after submit — last-touch attribution is the
// goal, and a user who fills out a second form in the same session
// without re-entering through an ad is still attributable to the
// first ad-driven session.
//
// Hydration hook: identical pattern to useIsHydrated /
// useIsCleaningHydrated / useIsHandymanHydrated. Form shells need to
// wait for hydration before reading, otherwise SSR will render
// no-UTMs and the client will hydrate with UTMs → React will warn
// about hydration mismatch.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { hasAnyUtms, type Utms } from './utms';

const STORE_VERSION = 1;

type UtmsStore = {
  utms: Utms;
  /**
   * Last-touch capture: replace stored UTMs with the new ones if the
   * new payload has any. Otherwise no-op (preserve existing). This
   * matches industry-standard attribution semantics — refreshing the
   * landing page or navigating between vertical pickers without new
   * UTM params should not clear the original campaign attribution.
   */
  captureFromUrl: (incoming: Utms) => void;
  /** Manual reset — used by tests; not wired to UI. */
  reset: () => void;
};

export const useUtmsStore = create<UtmsStore>()(
  persist(
    (set) => ({
      utms: {},
      captureFromUrl: (incoming) => {
        if (!hasAnyUtms(incoming)) return;
        set({ utms: incoming });
      },
      reset: () => set({ utms: {} }),
    }),
    {
      name: 'evenquote:utms',
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ utms: state.utms }),
    }
  )
);

/**
 * Hook returning `true` once the UTMs store has rehydrated from
 * localStorage. Form shells that read UTMs at submit time should
 * gate on this so they don't accidentally submit empty UTMs while
 * persisted ones exist (race between submit and hydration).
 */
export function useIsUtmsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useUtmsStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useUtmsStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return () => unsub();
  }, []);

  return hydrated;
}
