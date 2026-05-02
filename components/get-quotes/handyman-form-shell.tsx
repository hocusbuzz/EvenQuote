'use client';

// Top-level form shell for /get-quotes/handyman.
//
// Structural twin of cleaning-form-shell.tsx. The difference is the
// wiring: this shell talks to the handyman store, handyman steps, and
// submitHandymanIntake. Three single-vertical shells is the threshold
// where we should consider generalizing — flagged for a future
// refactor pass; not blocking for v1.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  useHandymanStore,
  useIsHandymanHydrated,
} from '@/lib/forms/handyman-store';
import { STEPS, type StepId } from '@/lib/forms/handyman-intake';
import { STEP_COMPONENTS } from './handyman-steps';
import { IntakeProgress } from './progress';
import { submitHandymanIntake } from '@/lib/actions/handyman-intake';
import { useUtmsStore, useIsUtmsHydrated } from '@/lib/marketing/utms-store';
import { HoneypotInput } from '@/components/security/honeypot-input';
import { HONEYPOT_FIELD_NAME } from '@/lib/security/honeypot';

export function HandymanFormShell() {
  const hydrated = useIsHandymanHydrated();
  // See form-shell.tsx for the rationale on the second hydration gate.
  const utmsHydrated = useIsUtmsHydrated();
  const currentStep = useHandymanStore((s) => s.currentStep);
  const setStep = useHandymanStore((s) => s.setStep);
  const draft = useHandymanStore((s) => s.draft);
  const utms = useUtmsStore((s) => s.utms);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // See form-shell.tsx (moving) for the honeypot rationale.
  const [honeypot, setHoneypot] = useState('');
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
      // See form-shell.tsx for rationale on merging UTMs + honeypot.
      const result = await submitHandymanIntake({
        ...draft,
        ...utms,
        [HONEYPOT_FIELD_NAME]: honeypot,
      });
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
          else setStep('job');
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

      {/* Honeypot — see form-shell.tsx (moving). */}
      <HoneypotInput value={honeypot} onChange={setHoneypot} />
    </>
  );
}
