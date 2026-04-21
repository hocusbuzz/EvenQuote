'use client';

// Progress bar for the intake form.
//
// Editorial styling to match the landing page — no mint-green SaaS progress
// bars. Shows numbered step dots connected by a thick top rule, with the
// lime accent marking the active step. Completed steps are ink-filled;
// upcoming steps are outlined.
//
// Per-vertical: takes the STEPS array as a prop so moving, cleaning, and
// future verticals share this component without each hardcoding their
// step count.

import { cn } from '@/lib/utils';

type Step = { id: string; title: string; label: string };

type Props = {
  currentStep: string;
  steps: readonly Step[];
};

export function IntakeProgress({ currentStep, steps: STEPS }: Props) {
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep);

  return (
    <div className="mb-10">
      {/* Eyebrow with current step label */}
      <div className="mb-3 flex items-baseline justify-between">
        <p className="label-eyebrow">{STEPS[currentIndex].label}</p>
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          {Math.round(((currentIndex + 1) / STEPS.length) * 100)}% complete
        </p>
      </div>

      {/* Step dots with connecting rules */}
      <ol className="flex items-center gap-1">
        {STEPS.map((step, i) => {
          const isActive = i === currentIndex;
          const isComplete = i < currentIndex;
          return (
            <li key={step.id} className="flex flex-1 items-center gap-1">
              {/* Dot + label */}
              <div className="flex flex-col items-start gap-1.5">
                <span
                  aria-current={isActive ? 'step' : undefined}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border-2 border-foreground font-mono text-xs font-bold transition-colors',
                    isActive && 'bg-lime text-ink',
                    isComplete && 'bg-foreground text-background',
                    !isActive && !isComplete && 'bg-background text-foreground'
                  )}
                >
                  {i + 1}
                </span>
                <span
                  className={cn(
                    'hidden text-xs font-medium sm:block',
                    isActive ? 'text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {step.title}
                </span>
              </div>
              {/* Connecting rule (not shown after the last item) */}
              {i < STEPS.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    'mb-5 h-0.5 flex-1 bg-foreground/20 transition-colors',
                    i < currentIndex && 'bg-foreground'
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
