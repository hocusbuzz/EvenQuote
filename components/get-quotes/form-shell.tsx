'use client';

// Top-level form shell for /get-quotes.
//
// Responsibilities:
//   - Render the current step (from Zustand)
//   - Provide onBack/onNext that advance/rewind the step
//   - Handle final submission via the server action
//   - Surface server errors cleanly
//   - Block rendering until Zustand has hydrated from localStorage
//
// Guest-flow note: we submit the request WITHOUT requiring login.
// The server action stores user_id=null; Phase 5 checkout will prompt
// sign-in and associate the row with the user's profile at that point.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useIntakeStore, useIsHydrated } from '@/lib/forms/intake-store';
import { STEPS, type StepId } from '@/lib/forms/moving-intake';
import { STEP_COMPONENTS } from './steps';
import { IntakeProgress } from './progress';
import { submitMovingIntake } from '@/lib/actions/intake';

export function IntakeFormShell() {
  const hydrated = useIsHydrated();
  const currentStep = useIntakeStore((s) => s.currentStep);
  const setStep = useIntakeStore((s) => s.setStep);
  const draft = useIntakeStore((s) => s.draft);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // ─── Step navigation ────────────────────────────────────────
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  const goNext = () => {
    const next = STEPS[currentIndex + 1];
    if (!next) return;
    setStep(next.id);
    // Scroll to top on step change so long forms don't leave the
    // user mid-page. Use `instant` so it doesn't feel sluggish.
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
      const result = await submitMovingIntake(draft);
      if (!result.ok) {
        setSubmitError(result.error);
        // If server validation caught something, jump to the most
        // likely offending step. Simple heuristic — matches review step.
        if (result.fieldErrors) {
          const firstField = Object.keys(result.fieldErrors)[0] ?? '';
          if (firstField.startsWith('origin')) setStep('origin');
          else if (firstField.startsWith('destination')) setStep('destination');
          else if (firstField.startsWith('contact')) setStep('contact');
          else setStep('details');
        }
        return;
      }

      // Success: push to the checkout handoff page. That page doesn't
      // exist yet (Phase 5 builds it), but the redirect target is
      // stable, so we wire it up now.
      router.push(`/get-quotes/checkout?request=${result.requestId}`);
    });
  };

  // ─── Hydration guard ────────────────────────────────────────
  // Persist middleware hydrates async. Before that fires, `draft` is
  // empty and currentStep is 'origin' regardless of what's in
  // localStorage. If we rendered now, returning users would see the
  // form blank for one frame — bad UX. Show a skeleton instead.
  if (!hydrated) {
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
