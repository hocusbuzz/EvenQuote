'use client';

// Back/Next nav row used by every step.
// Primary (Next/Submit) is the lime CTA to reinforce the brand action.

import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight } from 'lucide-react';

type Props = {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  backLabel?: string;
  // When true, the Back button is hidden (first step)
  hideBack?: boolean;
};

export function StepNav({
  onBack,
  onNext,
  nextLabel = 'Next',
  nextDisabled,
  backLabel = 'Back',
  hideBack,
}: Props) {
  return (
    <div className="mt-8 flex items-center justify-between border-t border-foreground/10 pt-6">
      {hideBack ? (
        <span aria-hidden /> // spacer
      ) : (
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft className="!size-4" />
          {backLabel}
        </Button>
      )}
      <Button type="button" variant="lime" onClick={onNext} disabled={nextDisabled}>
        {nextLabel}
        <ArrowRight className="!size-4" />
      </Button>
    </div>
  );
}
