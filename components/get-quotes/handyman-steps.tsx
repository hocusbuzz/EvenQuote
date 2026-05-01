'use client';

// Handyman intake — 4 step components.
//
// Parallels components/get-quotes/cleaning-steps.tsx and steps.tsx
// (moving). Same visual system (StepNav, FormField, Select primitives).
// Field set is handyman-specific: location / job / contact / review.
//
// Why fewer steps than cleaning (4 vs 5): handyman doesn't have a
// separate "service" step — `job_type` IS the service category, so
// we collapse the equivalent of cleaning's home + service into a
// single "job" step.

import { useHandymanStore } from '@/lib/forms/handyman-store';
import {
  LocationSchema,
  JobSchema,
  ContactSchema,
  HandymanIntakeSchema,
  US_STATES,
  JOB_TYPES,
  JOB_SIZES,
  STEPS,
  type StepId,
  type HandymanIntakeDraft,
} from '@/lib/forms/handyman-intake';
import { useStepValidation } from '@/lib/forms/use-step-validation';
import { FormField } from './form-field';
import { StepNav } from './step-nav';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  const draft = useHandymanStore((s) => s.draft);
  const setField = useHandymanStore((s) => s.setField);
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

  const update = <K extends keyof HandymanIntakeDraft>(
    k: K,
    v: HandymanIntakeDraft[K]
  ) => {
    setField(k, v);
    clearError(k as string);
  };

  // Pick-from-Google handler — fills all four address fields plus
  // lat/lng. The coords feed the on-demand business seeder + the
  // radius selector.
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
        Where is the work?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We use this to find handymen who service your area.
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
// Step 2 — Job
// ────────────────────────────────────────────────────────────────
export function JobStep({ onNext, onBack }: StepProps) {
  const draft = useHandymanStore((s) => s.draft);
  const setField = useHandymanStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(JobSchema);

  const handleNext = () => {
    const data = {
      job_type: draft.job_type,
      job_size: draft.job_size,
      job_description: draft.job_description,
      ideal_date: draft.ideal_date,
      materials_needed: draft.materials_needed,
    };
    if (validate(data)) onNext();
  };

  // Tri-state for materials_needed: Yes / No / Skip. Skip means
  // "leave it for the handyman to ask" — different from a hard No.
  const materialsValue =
    draft.materials_needed === undefined ? 'skip' : draft.materials_needed ? 'yes' : 'no';
  const setMaterials = (v: string) => {
    if (v === 'skip') setField('materials_needed', undefined);
    else if (v === 'yes') setField('materials_needed', true);
    else setField('materials_needed', false);
    clearError('materials_needed');
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        What do you need done?
      </h2>
      <p className="mt-2 text-muted-foreground">
        The more specific, the more accurate your quotes.
      </p>

      <div className="mt-8 space-y-5">
        <FormField label="Job category" htmlFor="job_type" required error={errors.job_type}>
          <Select
            value={draft.job_type}
            onValueChange={(v) => {
              setField('job_type', v as (typeof JOB_TYPES)[number]);
              clearError('job_type');
            }}
          >
            <SelectTrigger id="job_type">
              <SelectValue placeholder="Pick the closest match" />
            </SelectTrigger>
            <SelectContent>
              {JOB_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label="Rough size"
          htmlFor="job_size"
          required
          error={errors.job_size}
          hint="Your best guess — handyman will confirm on the call."
        >
          <Select
            value={draft.job_size}
            onValueChange={(v) => {
              setField('job_size', v as (typeof JOB_SIZES)[number]);
              clearError('job_size');
            }}
          >
            <SelectTrigger id="job_size">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {JOB_SIZES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label="Describe the job"
          htmlFor="job_description"
          required
          error={errors.job_description}
          hint="A sentence or two — what needs doing, any access notes, anything unusual."
        >
          <Textarea
            id="job_description"
            value={draft.job_description ?? ''}
            onChange={(e) => {
              setField('job_description', e.target.value);
              clearError('job_description');
            }}
            maxLength={1000}
            placeholder="e.g., Mount a 65-inch TV on drywall in the living room — studs already located. Bracket purchased."
            rows={4}
          />
        </FormField>

        <FormField
          label="Ideal date"
          htmlFor="ideal_date"
          required
          error={errors.ideal_date}
        >
          <Input
            id="ideal_date"
            type="date"
            value={draft.ideal_date ?? ''}
            min={todayISO()}
            onChange={(e) => {
              setField('ideal_date', e.target.value);
              clearError('ideal_date');
            }}
          />
        </FormField>

        <FormField
          label="Need them to bring materials?"
          htmlFor="materials_needed"
          hint="If unsure, leave it — most handymen will ask on the call."
        >
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
              { value: 'skip', label: 'Not sure' },
            ].map((opt) => {
              const active = materialsValue === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMaterials(opt.value)}
                  className={
                    'rounded-md border px-3 py-2 text-sm transition-colors ' +
                    (active
                      ? 'border-foreground bg-foreground/5 font-medium'
                      : 'border-input hover:bg-foreground/[0.02]')
                  }
                  aria-pressed={active}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
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
  const draft = useHandymanStore((s) => s.draft);
  const setField = useHandymanStore((s) => s.setField);
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
        How should handymen reach you?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We only share this in your final report — never with the handymen we call,
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
  const draft = useHandymanStore((s) => s.draft);
  const setStep = useHandymanStore((s) => s.setStep);
  const { errors, validate } = useStepValidation(HandymanIntakeSchema);

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
      else setStep('job');
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
      heading: 'Job',
      editTo: 'job' as StepId,
      lines: [
        draft.job_type,
        draft.job_size,
        draft.ideal_date
          ? 'Ideal: ' +
            new Date(draft.ideal_date + 'T00:00:00').toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : undefined,
        draft.materials_needed === true
          ? 'Materials: handyman brings'
          : draft.materials_needed === false
            ? 'Materials: customer provides'
            : undefined,
        draft.job_description ? `Notes: ${draft.job_description}` : undefined,
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
  job: JobStep,
  contact: ContactStep,
  review: ReviewStep,
};
