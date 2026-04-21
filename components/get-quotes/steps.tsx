'use client';

// All 5 intake-form step components.
//
// Each step:
//   1. Reads its relevant slice from the Zustand store
//   2. Uses useStepValidation(stepSchema) for on-next validation
//   3. Calls the parent-provided onNext / onBack
//
// Kept in one file because each step is under ~60 lines and they share
// a lot of imports. Easier to navigate than 5 tiny files.

import { useIntakeStore } from '@/lib/forms/intake-store';
import {
  OriginSchema,
  DestinationSchema,
  DetailsSchema,
  ContactSchema,
  MovingIntakeSchema,
  HOME_SIZES,
  SPECIAL_ITEMS,
  STEPS,
  type StepId,
} from '@/lib/forms/moving-intake';
import { useStepValidation } from '@/lib/forms/use-step-validation';
import { FormField } from './form-field';
import { AddressBlock } from './address-block';
import { StepNav } from './step-nav';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type StepProps = {
  onNext: () => void;
  onBack?: () => void;
  // Review step also wants to know about submission
  onSubmit?: () => void;
  submitting?: boolean;
};

// Today's date as ISO yyyy-mm-dd for the date input's `min` attribute.
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────
// Step 1 — Origin
// ────────────────────────────────────────────────────────────────
export function OriginStep({ onNext }: StepProps) {
  const draft = useIntakeStore((s) => s.draft);
  const { errors, validate, clearError } = useStepValidation(OriginSchema);

  const handleNext = () => {
    const data = {
      origin_address: draft.origin_address,
      origin_city: draft.origin_city,
      origin_state: draft.origin_state,
      origin_zip: draft.origin_zip,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Where are you moving <em className="not-italic">from</em>?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We use this to find local movers who service your origin ZIP.
      </p>

      <div className="mt-8">
        <AddressBlock
          prefix="origin"
          errors={errors}
          onFieldChange={(field) => clearError(field)}
        />
      </div>

      <StepNav hideBack onNext={handleNext} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 2 — Destination
// ────────────────────────────────────────────────────────────────
export function DestinationStep({ onNext, onBack }: StepProps) {
  const draft = useIntakeStore((s) => s.draft);
  const { errors, validate, clearError } = useStepValidation(DestinationSchema);

  const handleNext = () => {
    const data = {
      destination_address: draft.destination_address,
      destination_city: draft.destination_city,
      destination_state: draft.destination_state,
      destination_zip: draft.destination_zip,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Where are you moving <em className="not-italic">to</em>?
      </h2>
      <p className="mt-2 text-muted-foreground">
        Doesn't have to be an exact address — a ZIP is enough for pricing.
      </p>

      <div className="mt-8">
        <AddressBlock
          prefix="destination"
          errors={errors}
          onFieldChange={(field) => clearError(field)}
        />
      </div>

      <StepNav onNext={handleNext} onBack={onBack} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 3 — Details
// ────────────────────────────────────────────────────────────────
export function DetailsStep({ onNext, onBack }: StepProps) {
  const draft = useIntakeStore((s) => s.draft);
  const setField = useIntakeStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(DetailsSchema);

  const specialItems = draft.special_items ?? [];

  const toggleSpecialItem = (item: (typeof SPECIAL_ITEMS)[number]) => {
    const next = specialItems.includes(item)
      ? specialItems.filter((x) => x !== item)
      : [...specialItems, item];
    setField('special_items', next);
  };

  const handleNext = () => {
    const data = {
      home_size: draft.home_size,
      move_date: draft.move_date,
      flexible_dates: draft.flexible_dates ?? false,
      special_items: specialItems,
      additional_notes: draft.additional_notes,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Tell us about your move.
      </h2>
      <p className="mt-2 text-muted-foreground">
        Movers need the basics to give you an accurate range.
      </p>

      <div className="mt-8 space-y-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            label="Home size"
            htmlFor="home_size"
            required
            error={errors.home_size}
          >
            <Select
              value={draft.home_size ?? undefined}
              onValueChange={(v) => {
                setField('home_size', v as (typeof HOME_SIZES)[number]);
                clearError('home_size');
              }}
            >
              <SelectTrigger id="home_size">
                <SelectValue placeholder="Select size" />
              </SelectTrigger>
              <SelectContent>
                {HOME_SIZES.map((h) => (
                  <SelectItem key={h} value={h}>
                    {h}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Move date"
            htmlFor="move_date"
            required
            error={errors.move_date}
          >
            <Input
              id="move_date"
              type="date"
              min={todayISO()}
              value={draft.move_date ?? ''}
              onChange={(e) => {
                setField('move_date', e.target.value);
                clearError('move_date');
              }}
            />
          </FormField>
        </div>

        {/* Flexible dates checkbox */}
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-input p-4 hover:bg-foreground/[0.02]">
          <Checkbox
            id="flexible_dates"
            checked={draft.flexible_dates ?? false}
            onCheckedChange={(checked) => setField('flexible_dates', checked === true)}
            className="mt-0.5"
          />
          <div>
            <p className="text-sm font-medium">Dates are flexible</p>
            <p className="text-xs text-muted-foreground">
              Movers can suggest a better price for nearby days.
            </p>
          </div>
        </label>

        {/* Special items multi-select */}
        <div className="space-y-3">
          <p className="text-sm font-medium">
            Any special items? <span className="text-muted-foreground">(optional)</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SPECIAL_ITEMS.map((item) => {
              const checked = specialItems.includes(item);
              return (
                <label
                  key={item}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-foreground/[0.02] has-[:checked]:border-foreground has-[:checked]:bg-foreground/5"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleSpecialItem(item)}
                    className="h-4 w-4"
                  />
                  <span>{item}</span>
                </label>
              );
            })}
          </div>
        </div>

        <FormField
          label="Anything else?"
          htmlFor="additional_notes"
          hint="Stairs, parking, access issues — anything that might affect the quote."
          error={errors.additional_notes}
        >
          <Textarea
            id="additional_notes"
            value={draft.additional_notes ?? ''}
            onChange={(e) => {
              setField('additional_notes', e.target.value);
              clearError('additional_notes');
            }}
            maxLength={1000}
            placeholder="Optional"
          />
        </FormField>
      </div>

      <StepNav onNext={handleNext} onBack={onBack} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 4 — Contact
// ────────────────────────────────────────────────────────────────
export function ContactStep({ onNext, onBack }: StepProps) {
  const draft = useIntakeStore((s) => s.draft);
  const setField = useIntakeStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(ContactSchema);

  const handleNext = () => {
    const data = {
      contact_name: draft.contact_name,
      contact_phone: draft.contact_phone,
      contact_email: draft.contact_email,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        How should movers reach you?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We only share this with the movers in your final report — never for marketing.
      </p>

      <div className="mt-8 space-y-5">
        <FormField label="Full name" htmlFor="contact_name" required error={errors.contact_name}>
          <Input
            id="contact_name"
            autoComplete="name"
            value={draft.contact_name ?? ''}
            onChange={(e) => {
              setField('contact_name', e.target.value);
              clearError('contact_name');
            }}
          />
        </FormField>

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            label="Phone"
            htmlFor="contact_phone"
            required
            error={errors.contact_phone}
          >
            <Input
              id="contact_phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={draft.contact_phone ?? ''}
              onChange={(e) => {
                setField('contact_phone', e.target.value);
                clearError('contact_phone');
              }}
              placeholder="(555) 123-4567"
            />
          </FormField>

          <FormField
            label="Email"
            htmlFor="contact_email"
            required
            error={errors.contact_email}
          >
            <Input
              id="contact_email"
              type="email"
              autoComplete="email"
              value={draft.contact_email ?? ''}
              onChange={(e) => {
                setField('contact_email', e.target.value);
                clearError('contact_email');
              }}
              placeholder="you@example.com"
            />
          </FormField>
        </div>
      </div>

      <StepNav onNext={handleNext} onBack={onBack} nextLabel="Review" />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 5 — Review
// ────────────────────────────────────────────────────────────────
export function ReviewStep({
  onBack,
  onSubmit,
  submitting,
}: StepProps) {
  const draft = useIntakeStore((s) => s.draft);
  const setStep = useIntakeStore((s) => s.setStep);
  const { errors, validate } = useStepValidation(MovingIntakeSchema);

  // Final-gate validation — if anything is still invalid we bounce back
  // to the offending step rather than showing errors inline on Review.
  const handleSubmit = () => {
    if (!validate(draft)) {
      // Find first failing step. Could be smarter, but good enough.
      const firstError = Object.keys(errors)[0] ?? '';
      if (firstError.startsWith('origin')) setStep('origin');
      else if (firstError.startsWith('destination')) setStep('destination');
      else if (firstError.startsWith('contact')) setStep('contact');
      else setStep('details');
      return;
    }
    onSubmit?.();
  };

  const summary = [
    {
      heading: 'From',
      editTo: 'origin' as StepId,
      lines: [
        draft.origin_address,
        `${draft.origin_city ?? ''}, ${draft.origin_state ?? ''} ${draft.origin_zip ?? ''}`.trim(),
      ],
    },
    {
      heading: 'To',
      editTo: 'destination' as StepId,
      lines: [
        draft.destination_address,
        `${draft.destination_city ?? ''}, ${draft.destination_state ?? ''} ${draft.destination_zip ?? ''}`.trim(),
      ],
    },
    {
      heading: 'Move details',
      editTo: 'details' as StepId,
      lines: [
        draft.home_size,
        draft.move_date
          ? new Date(draft.move_date + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : undefined,
        draft.flexible_dates ? 'Dates flexible' : undefined,
        (draft.special_items?.length ?? 0) > 0
          ? `Special items: ${draft.special_items!.join(', ')}`
          : undefined,
        draft.additional_notes ? `Notes: ${draft.additional_notes}` : undefined,
      ],
    },
    {
      heading: 'Contact',
      editTo: 'contact' as StepId,
      lines: [draft.contact_name, draft.contact_phone, draft.contact_email],
    },
  ];

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Look right?
      </h2>
      <p className="mt-2 text-muted-foreground">
        Double-check before we start calling. After this you'll pay $9.99 and we'll begin
        dialing within minutes.
      </p>

      <div className="mt-8 space-y-5">
        {summary.map((section) => (
          <div
            key={section.heading}
            className="rounded-lg border border-border bg-card p-5"
          >
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <p className="label-eyebrow">{section.heading}</p>
              <button
                type="button"
                onClick={() => setStep(section.editTo)}
                className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
              >
                Edit
              </button>
            </div>
            <div className="space-y-1 text-sm">
              {section.lines
                .filter((l): l is string => Boolean(l && l.replace(/[\s,]/g, '')))
                .map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
            </div>
          </div>
        ))}
      </div>

      <StepNav
        onBack={onBack}
        onNext={handleSubmit}
        nextLabel={submitting ? 'Continuing…' : 'Continue to payment'}
        nextDisabled={submitting}
      />
    </section>
  );
}

// Helper for the shell: look up a step component by id.
export const STEP_COMPONENTS: Record<StepId, React.ComponentType<StepProps>> = {
  origin: OriginStep,
  destination: DestinationStep,
  details: DetailsStep,
  contact: ContactStep,
  review: ReviewStep,
};

// Also export STEPS for convenience
export { STEPS };
