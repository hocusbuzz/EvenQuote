'use client';

// Lawn-care intake — 4 step components.
//
// Parallels components/get-quotes/handyman-steps.tsx and the cleaning
// + moving step files. Same visual system (StepNav, FormField, Select,
// Checkbox primitives). Field set is lawn-care-specific:
// location / yard / contact / review.
//
// Why fewer steps than cleaning (4 vs 5): lawn care doesn't have a
// separate "service" step — service_type is captured inside the yard
// step alongside lot_size and frequency, mirroring handyman's
// collapsed shape.

import { useLawnCareStore } from '@/lib/forms/lawn-care-store';
import {
  LocationSchema,
  YardSchema,
  ContactSchema,
  LawnCareIntakeSchema,
  US_STATES,
  LOT_SIZES,
  SERVICE_TYPES,
  FREQUENCIES,
  STEPS,
  type StepId,
  type LawnCareIntakeDraft,
} from '@/lib/forms/lawn-care-intake';
import { useStepValidation } from '@/lib/forms/use-step-validation';
import { FormField } from './form-field';
import { StepNav } from './step-nav';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { AddressAutocomplete, type ParsedAddress } from './address-autocomplete';
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
  onSubmit?: () => void;
  submitting?: boolean;
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────
// Step 1 — Location
// ────────────────────────────────────────────────────────────────
export function LocationStep({ onNext }: StepProps) {
  const draft = useLawnCareStore((s) => s.draft);
  const setField = useLawnCareStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(LocationSchema);

  const handleNext = () => {
    const data = {
      address: draft.address,
      city: draft.city,
      state: draft.state,
      zip: draft.zip,
    };
    if (validate(data)) onNext();
  };

  const update = <K extends keyof LawnCareIntakeDraft>(
    k: K,
    v: LawnCareIntakeDraft[K]
  ) => {
    setField(k, v);
    clearError(k as string);
  };

  // Pick-from-Google handler — fills address fields plus lat/lng. The
  // coords feed the on-demand business seeder + the radius selector.
  const handleAutocompletePick = (parsed: ParsedAddress) => {
    if (parsed.address_line) update('address', parsed.address_line);
    if (parsed.city) update('city', parsed.city);
    if (parsed.state && (US_STATES as readonly string[]).includes(parsed.state)) {
      update('state', parsed.state as (typeof US_STATES)[number]);
    }
    if (parsed.zip_code) update('zip', parsed.zip_code);
    if (typeof parsed.latitude === 'number') {
      setField('lat', parsed.latitude);
    }
    if (typeof parsed.longitude === 'number') {
      setField('lng', parsed.longitude);
    }
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Where is the yard?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We use this to find lawn crews who service your area.
      </p>

      <div className="mt-8 space-y-5">
        <FormField
          label="Street address"
          htmlFor="address"
          required
          error={errors.address}
        >
          <AddressAutocomplete
            id="address"
            value={draft.address ?? ''}
            onChange={(v) => update('address', v)}
            onSelectAddress={handleAutocompletePick}
            placeholder="Start typing your address…"
            autoComplete="street-address"
          />
        </FormField>

        <div className="grid gap-5 sm:grid-cols-[2fr_1fr_1fr]">
          <FormField label="City" htmlFor="city" required error={errors.city}>
            <Input
              id="city"
              autoComplete="address-level2"
              value={draft.city ?? ''}
              onChange={(e) => update('city', e.target.value)}
            />
          </FormField>

          <FormField label="State" htmlFor="state" required error={errors.state}>
            <Select
              value={draft.state}
              onValueChange={(v) => update('state', v as (typeof US_STATES)[number])}
            >
              <SelectTrigger id="state">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {US_STATES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="ZIP" htmlFor="zip" required error={errors.zip}>
            <Input
              id="zip"
              inputMode="numeric"
              autoComplete="postal-code"
              value={draft.zip ?? ''}
              onChange={(e) => update('zip', e.target.value)}
              maxLength={10}
            />
          </FormField>
        </div>
      </div>

      <StepNav onNext={handleNext} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 2 — Yard
// ────────────────────────────────────────────────────────────────
export function YardStep({ onNext, onBack }: StepProps) {
  const draft = useLawnCareStore((s) => s.draft);
  const setField = useLawnCareStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(YardSchema);

  const services = draft.service_type ?? [];

  const toggleService = (s: (typeof SERVICE_TYPES)[number]) => {
    const next = services.includes(s)
      ? services.filter((x) => x !== s)
      : [...services, s];
    setField('service_type', next);
    clearError('service_type');
  };

  const handleNext = () => {
    const data = {
      lot_size: draft.lot_size,
      service_type: services,
      frequency: draft.frequency,
      start_date: draft.start_date,
      additional_notes: draft.additional_notes,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Tell us about the yard.
      </h2>
      <p className="mt-2 text-muted-foreground">
        Lot size + frequency drive most of the price. Pick the closest match.
      </p>

      <div className="mt-8 space-y-5">
        <FormField label="Lot size" htmlFor="lot_size" required error={errors.lot_size}>
          <Select
            value={draft.lot_size}
            onValueChange={(v) => {
              setField('lot_size', v as (typeof LOT_SIZES)[number]);
              clearError('lot_size');
            }}
          >
            <SelectTrigger id="lot_size">
              <SelectValue placeholder="Pick a range" />
            </SelectTrigger>
            <SelectContent>
              {LOT_SIZES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <div className="space-y-3">
          <p className="text-sm font-medium">
            Services needed <span className="text-destructive">*</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Pick everything that applies — crews will price each on the call.
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SERVICE_TYPES.map((item) => {
              const checked = services.includes(item);
              return (
                <label
                  key={item}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-foreground/[0.02] has-[:checked]:border-foreground has-[:checked]:bg-foreground/5"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleService(item)}
                    className="h-4 w-4"
                  />
                  <span>{item}</span>
                </label>
              );
            })}
          </div>
          {errors.service_type ? (
            <p className="text-xs text-destructive">{errors.service_type}</p>
          ) : null}
        </div>

        <FormField label="How often?" htmlFor="frequency" required error={errors.frequency}>
          <Select
            value={draft.frequency}
            onValueChange={(v) => {
              setField('frequency', v as (typeof FREQUENCIES)[number]);
              clearError('frequency');
            }}
          >
            <SelectTrigger id="frequency">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {FREQUENCIES.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label="Preferred start date"
          htmlFor="start_date"
          required
          error={errors.start_date}
        >
          <Input
            id="start_date"
            type="date"
            value={draft.start_date ?? ''}
            min={todayISO()}
            onChange={(e) => {
              setField('start_date', e.target.value);
              clearError('start_date');
            }}
          />
        </FormField>

        <FormField
          label="Anything else?"
          htmlFor="additional_notes"
          hint="Gate code, dog in yard, slope/access notes — anything crews should know."
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
            placeholder="e.g., Side gate code 1234. Steep front slope — push mower preferred."
            rows={4}
          />
        </FormField>
      </div>

      <StepNav onNext={handleNext} onBack={onBack} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 3 — Contact
// ────────────────────────────────────────────────────────────────
export function ContactStep({ onNext, onBack }: StepProps) {
  const draft = useLawnCareStore((s) => s.draft);
  const setField = useLawnCareStore((s) => s.setField);
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
        How should we reach you when the quotes are ready?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We only share this in your final report — never with the crews we call,
        and never for marketing.
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
          <FormField label="Phone" htmlFor="contact_phone" required error={errors.contact_phone}>
            <Input
              id="contact_phone"
              type="tel"
              autoComplete="tel"
              value={draft.contact_phone ?? ''}
              onChange={(e) => {
                setField('contact_phone', e.target.value);
                clearError('contact_phone');
              }}
              placeholder="(555) 555-5555"
            />
          </FormField>

          <FormField label="Email" htmlFor="contact_email" required error={errors.contact_email}>
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
// Step 4 — Review
// ────────────────────────────────────────────────────────────────
export function ReviewStep({ onBack, onSubmit, submitting }: StepProps) {
  const draft = useLawnCareStore((s) => s.draft);
  const setStep = useLawnCareStore((s) => s.setStep);
  const { errors, validate } = useStepValidation(LawnCareIntakeSchema);

  const handleSubmit = () => {
    if (!validate(draft)) {
      const firstError = Object.keys(errors)[0] ?? '';
      if (
        firstError === 'address' ||
        firstError === 'city' ||
        firstError === 'state' ||
        firstError === 'zip'
      )
        setStep('location');
      else if (firstError.startsWith('contact')) setStep('contact');
      else setStep('yard');
      return;
    }
    onSubmit?.();
  };

  const summary = [
    {
      heading: 'Where',
      editTo: 'location' as StepId,
      lines: [
        draft.address,
        `${draft.city ?? ''}, ${draft.state ?? ''} ${draft.zip ?? ''}`.trim(),
      ],
    },
    {
      heading: 'Yard',
      editTo: 'yard' as StepId,
      lines: [
        draft.lot_size,
        (draft.service_type?.length ?? 0) > 0
          ? `Services: ${draft.service_type!.join(', ')}`
          : undefined,
        draft.frequency,
        draft.start_date
          ? 'Start: ' +
            new Date(draft.start_date + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
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
        Double-check before we start calling. After this you'll pay $9.99 (+ tax if applicable)
        and we'll begin dialing within minutes.
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

export const STEP_COMPONENTS: Record<StepId, React.ComponentType<StepProps>> = {
  location: LocationStep,
  yard: YardStep,
  contact: ContactStep,
  review: ReviewStep,
};
