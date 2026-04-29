'use client';

// Cleaning intake — 5 step components.
//
// Parallels components/get-quotes/steps.tsx (moving). Shares the same
// visual system (StepNav, FormField, Select primitives) but the field
// set is cleaning-specific: location / home / service / contact / review.
//
// Kept in one file for the same reason the moving steps are — each
// step is small, and they share a lot of imports.

import { useCleaningStore } from '@/lib/forms/cleaning-store';
import {
  LocationSchema,
  HomeSchema,
  ServiceSchema,
  ContactSchema,
  CleaningIntakeSchema,
  US_STATES,
  HOME_SIZES,
  BATHROOMS,
  PET_OPTIONS,
  CLEANING_TYPES,
  CLEANING_FREQUENCIES,
  CLEANING_EXTRAS,
  STEPS,
  type StepId,
  type CleaningIntakeDraft,
} from '@/lib/forms/cleaning-intake';
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
  const draft = useCleaningStore((s) => s.draft);
  const setField = useCleaningStore((s) => s.setField);
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

  // Typed setter + clearError convenience.
  const update = <K extends keyof CleaningIntakeDraft>(
    k: K,
    v: CleaningIntakeDraft[K]
  ) => {
    setField(k, v);
    clearError(k as string);
  };

  // Pick-from-Google handler — fills all four address fields plus
  // lat/lng. The coords feed the on-demand business seeder + the
  // radius selector. They're optional on the schema, so manual
  // ("Use custom") entries that lack them still pass validation.
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
        Where should we clean?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We use this to find cleaners who service your ZIP.
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
            autoComplete="address-line1"
            value={draft.address ?? ''}
            onChange={(v) => update('address', v)}
            onSelectAddress={handleAutocompletePick}
            placeholder="Start typing — we'll suggest addresses"
          />
        </FormField>

        <div className="grid gap-5 sm:grid-cols-[1fr_auto_auto]">
          <FormField label="City" htmlFor="city" required error={errors.city}>
            <AddressAutocomplete
              id="city"
              type="city"
              autoComplete="address-level2"
              value={draft.city ?? ''}
              onChange={(v) => update('city', v)}
              onSelectAddress={handleAutocompletePick}
              placeholder="San Diego"
            />
          </FormField>

          <FormField
            label="State"
            htmlFor="state"
            required
            error={errors.state}
            className="sm:w-32"
          >
            <Select
              value={draft.state ?? undefined}
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

          <FormField
            label="ZIP"
            htmlFor="zip"
            required
            error={errors.zip}
            className="sm:w-36"
          >
            <AddressAutocomplete
              id="zip"
              type="zip"
              inputMode="numeric"
              autoComplete="postal-code"
              value={draft.zip ?? ''}
              onChange={(v) => update('zip', v)}
              onSelectAddress={handleAutocompletePick}
              placeholder="92101"
            />
          </FormField>
        </div>
      </div>

      <StepNav hideBack onNext={handleNext} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 2 — Home
// ────────────────────────────────────────────────────────────────
export function HomeStep({ onNext, onBack }: StepProps) {
  const draft = useCleaningStore((s) => s.draft);
  const setField = useCleaningStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(HomeSchema);

  const handleNext = () => {
    const data = {
      home_size: draft.home_size,
      bathrooms: draft.bathrooms,
      pets: draft.pets,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        Tell us about your home.
      </h2>
      <p className="mt-2 text-muted-foreground">
        Size and bathroom count drive the quote more than anything else.
      </p>

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
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
          label="Bathrooms"
          htmlFor="bathrooms"
          required
          error={errors.bathrooms}
        >
          <Select
            value={draft.bathrooms ?? undefined}
            onValueChange={(v) => {
              setField('bathrooms', v as (typeof BATHROOMS)[number]);
              clearError('bathrooms');
            }}
          >
            <SelectTrigger id="bathrooms">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {BATHROOMS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label="Pets in the home?"
          htmlFor="pets"
          hint="Optional — helps cleaners bring the right supplies."
          error={errors.pets}
        >
          <Select
            value={draft.pets ?? undefined}
            onValueChange={(v) => {
              setField('pets', v as (typeof PET_OPTIONS)[number]);
              clearError('pets');
            }}
          >
            <SelectTrigger id="pets">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              {PET_OPTIONS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>

      <StepNav onNext={handleNext} onBack={onBack} />
    </section>
  );
}

// ────────────────────────────────────────────────────────────────
// Step 3 — Service
// ────────────────────────────────────────────────────────────────
export function ServiceStep({ onNext, onBack }: StepProps) {
  const draft = useCleaningStore((s) => s.draft);
  const setField = useCleaningStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(ServiceSchema);

  const extras = draft.extras ?? [];

  const toggleExtra = (e: (typeof CLEANING_EXTRAS)[number]) => {
    const next = extras.includes(e) ? extras.filter((x) => x !== e) : [...extras, e];
    setField('extras', next);
  };

  const handleNext = () => {
    const data = {
      cleaning_type: draft.cleaning_type,
      frequency: draft.frequency,
      earliest_date: draft.earliest_date,
      extras,
      additional_notes: draft.additional_notes,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        What kind of clean?
      </h2>
      <p className="mt-2 text-muted-foreground">
        The type and cadence both change the price.
      </p>

      <div className="mt-8 space-y-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            label="Type of cleaning"
            htmlFor="cleaning_type"
            required
            error={errors.cleaning_type}
          >
            <Select
              value={draft.cleaning_type ?? undefined}
              onValueChange={(v) => {
                setField('cleaning_type', v as (typeof CLEANING_TYPES)[number]);
                clearError('cleaning_type');
              }}
            >
              <SelectTrigger id="cleaning_type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {CLEANING_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="How often?"
            htmlFor="frequency"
            required
            error={errors.frequency}
          >
            <Select
              value={draft.frequency ?? undefined}
              onValueChange={(v) => {
                setField('frequency', v as (typeof CLEANING_FREQUENCIES)[number]);
                clearError('frequency');
              }}
            >
              <SelectTrigger id="frequency">
                <SelectValue placeholder="Select cadence" />
              </SelectTrigger>
              <SelectContent>
                {CLEANING_FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>

        <FormField
          label="Earliest date that works"
          htmlFor="earliest_date"
          required
          error={errors.earliest_date}
        >
          <Input
            id="earliest_date"
            type="date"
            min={todayISO()}
            value={draft.earliest_date ?? ''}
            onChange={(e) => {
              setField('earliest_date', e.target.value);
              clearError('earliest_date');
            }}
          />
        </FormField>

        <div className="space-y-3">
          <p className="text-sm font-medium">
            Any extras? <span className="text-muted-foreground">(optional)</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CLEANING_EXTRAS.map((item) => {
              const checked = extras.includes(item);
              return (
                <label
                  key={item}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-foreground/[0.02] has-[:checked]:border-foreground has-[:checked]:bg-foreground/5"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleExtra(item)}
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
          hint="Access instructions, problem areas, allergies — anything cleaners should know."
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
  const draft = useCleaningStore((s) => s.draft);
  const setField = useCleaningStore((s) => s.setField);
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
        How should cleaners reach you?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We only share this with the cleaners in your final report — never for marketing.
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
export function ReviewStep({ onBack, onSubmit, submitting }: StepProps) {
  const draft = useCleaningStore((s) => s.draft);
  const setStep = useCleaningStore((s) => s.setStep);
  const { errors, validate } = useStepValidation(CleaningIntakeSchema);

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
      else if (firstError === 'home_size' || firstError === 'bathrooms' || firstError === 'pets')
        setStep('home');
      else if (firstError.startsWith('contact')) setStep('contact');
      else setStep('service');
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
      heading: 'Home',
      editTo: 'home' as StepId,
      lines: [
        draft.home_size,
        draft.bathrooms ? `${draft.bathrooms} bathroom(s)` : undefined,
        draft.pets && draft.pets !== 'None' ? `Pets: ${draft.pets}` : undefined,
      ],
    },
    {
      heading: 'Service',
      editTo: 'service' as StepId,
      lines: [
        draft.cleaning_type,
        draft.frequency,
        draft.earliest_date
          ? 'Earliest: ' +
            new Date(draft.earliest_date + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : undefined,
        (draft.extras?.length ?? 0) > 0 ? `Extras: ${draft.extras!.join(', ')}` : undefined,
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
  home: HomeStep,
  service: ServiceStep,
  contact: ContactStep,
  review: ReviewStep,
};

export { STEPS };
