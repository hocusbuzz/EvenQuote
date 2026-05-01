'use client';

// Zustand store for the moving intake form.
//
// Why Zustand (not React Context)?
//   - Multi-step form state is read/written by many sibling components
//     (step, progress bar, nav buttons, review pane). Context would
//     cause prop-drilling OR a re-render firehose.
//   - Zustand's persist middleware gives us localStorage sync with
//     versioning for free.
//
// Hydration: Next.js SSRs with empty store, then hydrates from
// localStorage on the client. If a component reads draft values during
// the first render, it produces a hydration mismatch.
//
// Solution: `useIsHydrated()` hook below returns false until zustand's
// persist middleware confirms hydration is done. Components gate on it.
// This is the pattern recommended in Zustand's own docs.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { MovingIntakeDraft, StepId } from '@/lib/forms/moving-intake';
import { trackClient } from '@/lib/analytics/track';

// Bump this number any time the schema changes in a way that would
// break deserialization. Old persisted state is discarded on mismatch.
const STORE_VERSION = 1;

type IntakeStore = {
  // ─── Form data ────────────────────────────────────────────────
  draft: MovingIntakeDraft;
  setField: <K extends keyof MovingIntakeDraft>(
    key: K,
    value: MovingIntakeDraft[K]
  ) => void;
  setFields: (updates: Partial<MovingIntakeDraft>) => void;

  // ─── Navigation ──────────────────────────────────────────────
  currentStep: StepId;
  setStep: (step: StepId) => void;

  // ─── Analytics one-shot ──────────────────────────────────────
  // Tracks whether the `quote_request_started` event has fired for
  // the current draft. Persisted so a refresh mid-form doesn't refire
  // the event (which would inflate funnel-top counts). reset() clears
  // it so a fresh request after submit fires again.
  started: boolean;

  // Wipe everything — called after a successful submission so the
  // next quote request starts clean.
  reset: () => void;
};

export const useIntakeStore = create<IntakeStore>()(
  persist(
    (set) => ({
      draft: {},
      // Wrap setField/setFields to fire the funnel-top analytics event
      // exactly once per draft — see the `started` field comment above
      // for why this is one-shot. trackClient is fan-out across enabled
      // providers (GA4 today; Meta + Reddit when their pixels land).
      setField: (key, value) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, [key]: value },
          } as Partial<IntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'moving' });
            next.started = true;
          }
          return next;
        }),
      setFields: (updates) =>
        set((state) => {
          const next = {
            draft: { ...state.draft, ...updates },
          } as Partial<IntakeStore>;
          if (!state.started) {
            trackClient('quote_request_started', { vertical: 'moving' });
            next.started = true;
          }
          return next;
        }),

      currentStep: 'origin',
      setStep: (step) => set({ currentStep: step }),

      started: false,
      reset: () => set({ draft: {}, currentStep: 'origin', started: false }),
    }),
    {
      name: 'evenquote:intake:moving',
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      // Only persist form data + step + started flag. NOT the action
      // closures (zustand persists primitives only by default, but we
      // list these explicitly so the contract is obvious to a reader).
      partialize: (state) => ({
        draft: state.draft,
        currentStep: state.currentStep,
        started: state.started,
      }),
    }
  )
);

/**
 * Hook returning `true` once the store has rehydrated from localStorage.
 * Until then, persisted values aren't available — components should
 * render skeletons or fall back to defaults.
 *
 * Pattern from Zustand docs for Next.js SSR safety.
 */
export function useIsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // If hydration already completed (e.g. on fast client remount),
    // we'd miss the onFinishHydration event. Check both.
    if (useIntakeStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    // Otherwise, subscribe to the finish event.
    const unsub = useIntakeStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return () => unsub();
  }, []);

  return hydrated;
}
