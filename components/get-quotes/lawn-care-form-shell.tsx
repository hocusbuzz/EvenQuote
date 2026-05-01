'use client';

// Top-level form shell for /get-quotes/lawn-care.
//
// Structural twin of handyman-form-shell.tsx + cleaning-form-shell.tsx.
// The difference is the wiring: this shell talks to the lawn-care
// store, lawn-care steps, and submitLawnCareIntake. Four single-
// vertical shells is now well past the threshold where we should
// generalize — flagged for a future refactor pass; not blocking for v1.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  useLawnCareStore,
  useIsLawnCareHydrated,
} from '@/lib/forms/lawn-care-store';
import { STEPS, type StepId } from '@/lib/forms/lawn-care-intake';
import { STEP_COMPONENTS } from './lawn-care-steps';
import { IntakeProgress } from './progress';
import { submitLawnCareIntake } from '@/lib/actions/lawn-care-intake';
import { useUtmsStore, useIsUtmsHydrated } from '@/lib/marketing/utms-store';

export function LawnCareFormShell() {
  const hydrated = useIsLawnCareHydrated();
  // See form-shell.tsx for the rationale on the second hydration gate.
  const utmsHydrated = useIsUtmsHydrated();
  const currentStep = useLawnCareStore((s) => s.currentStep);
  const setStep = useLawnCareStore((s) => s.setStep);
  const draft = useLawnCareStore((s) => s.draft);
  const utms = useUtmsStore((s) => s.utms);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  const goNext = () => {
    const next = STEPS[currentIndex + 1];
    if (!next) return;
    setStep(next.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goBack = () => {
    const prev = STEPS[currentIndex - 1];
    if (!prev) return;
    setStep(prev.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = () => {
    setSubmitError(null);
    startTransition(async () => {
      // See form-shell.tsx for rationale on merging UTMs at submit time.
      const result = await submitLawnCareIntake({ ...draft, ...utms });
      if (!result.ok) {
        setSubmitError(result.error);
        if (result.fieldErrors) {
          const firstField = Object.keys(result.fieldErrors)[0] ?? '';
          if (
            firstField === 'address' ||
            firstField === 'city' ||
            firstField === 'state' ||
            firstField === 'zip'
          )
            setStep('location');
          else if (firstField.startsWith('contact')) setStep('contact');
          else setStep('yard');
        }
        return;
      }

      router.push(`/get-quotes/checkout?request=${result.requestId}`);
    });
  };

  if (!hydrated || !utmsHydrated) {
    return (
      <div className="space-y-8" aria-hidden>
        <div className="h-8 w-64 animate-pulse rounded bg-foreground/10" />
        <div className="h-2 w-full animate-pulse rounded bg-foreground/10" />
        <div className="space-y-4">
          <div className="h-10 w-full animate-pulse rounded bg-foreground/10" />
          <div className="h-10 w-full animate-pulse rounded bg-foreground/10" />
          <div className="h-10 w-full animate-pulse rounded bg-foreground/10" />
        </div>
      </div>
    );
  }

  const CurrentComponent = STEP_COMPONENTS[currentStep as StepId];

  return (
    <>
      <IntakeProgress currentStep={currentStep} steps={STEPS} />

      {submitError ? (
        <div
          role="alert"
          className="mb-6 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {submitError}
        </div>
      ) : null}

      <CurrentComponent
        onNext={goNext}
        onBack={goBack}
        onSubmit={handleSubmit}
        submitting={isPending}
      />
    </>
  );
}
