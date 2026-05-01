'use client';

// Junk-removal intake — 4 step components.
//
// Parallels components/get-quotes/lawn-care-steps.tsx and the other
// vertical step files. Same visual system. Field set is junk-removal-
// specific: location / load / contact / review.

import { useJunkRemovalStore } from '@/lib/forms/junk-removal-store';
import {
  LocationSchema,
  LoadSchema,
  ContactSchema,
  JunkRemovalIntakeSchema,
  US_STATES,
  VOLUME_BUCKETS,
  HEAVY_ITEMS,
  PICKUP_LOCATIONS,
  STEPS,
  type StepId,
  type JunkRemovalIntakeDraft,
} from '@/lib/forms/junk-removal-intake';
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
  const draft = useJunkRemovalStore((s) => s.draft);
  const setField = useJunkRemovalStore((s) => s.setField);
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

  const update = <K extends keyof JunkRemovalIntakeDraft>(
    k: K,
    v: JunkRemovalIntakeDraft[K]
  ) => {
    setField(k, v);
    clearError(k as string);
  };

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
        Where is the pickup?
      </h2>
      <p className="mt-2 text-muted-foreground">
        We use this to find junk removal crews who service your area.
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
// Step 2 — Load
// ────────────────────────────────────────────────────────────────
export function LoadStep({ onNext, onBack }: StepProps) {
  const draft = useJunkRemovalStore((s) => s.draft);
  const setField = useJunkRemovalStore((s) => s.setField);
  const { errors, validate, clearError } = useStepValidation(LoadSchema);

  const heavyItems = draft.heavy_items ?? [];

  const toggleHeavyItem = (item: (typeof HEAVY_ITEMS)[number]) => {
    const next = heavyItems.includes(item)
      ? heavyItems.filter((x) => x !== item)
      : [...heavyItems, item];
    setField('heavy_items', next);
    clearError('heavy_items');
  };

  // Tri-state for same_day_needed: Yes / No / Skip. Skip means
  // "no urgency" — different from a hard No which is also "no urgency"
  // but signals to the assistant the customer thought about it.
  const sameDayValue =
    draft.same_day_needed === undefined ? 'skip' : draft.same_day_needed ? 'yes' : 'no';
  const setSameDay = (v: string) => {
    if (v === 'skip') setField('same_day_needed', undefined);
    else if (v === 'yes') setField('same_day_needed', true);
    else setField('same_day_needed', false);
    clearError('same_day_needed');
  };

  const handleNext = () => {
    const data = {
      volume_bucket: draft.volume_bucket,
      heavy_items: heavyItems,
      pickup_location: draft.pickup_location,
      same_day_needed: draft.same_day_needed,
      preferred_date: draft.preferred_date,
      additional_notes: draft.additional_notes,
    };
    if (validate(data)) onNext();
  };

  return (
    <section>
      <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        About the load.
      </h2>
      <p className="mt-2 text-muted-foreground">
        Volume drives the base price; heavy items are surcharged on top.
      </p>

      <div className="mt-8 space-y-5">
        <FormField
          label="Roughly how much?"
          htmlFor="volume_bucket"
          required
          error={errors.volume_bucket}
          hint="Your best guess — crews will confirm on the call."
        >
          <Select
            value={draft.volume_bucket}
            onValueChange={(v) => {
              setField('volume_bucket', v as (typeof VOLUME_BUCKETS)[number]);
              clearError('volume_bucket');
            }}
          >
            <SelectTrigger id="volume_bucket">
              <SelectValue placeholder="Pick a bucket" />
            </SelectTrigger>
            <SelectContent>
              {VOLUME_BUCKETS.map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <div className="space-y-3">
          <p className="text-sm font-medium">
            Any heavy or specialty items? <span className="text-muted-foreground">(optional)</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Each is usually surcharged separately — pick everything that applies.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {HEAVY_ITEMS.map((item) => {
              const checked = heavyItems.includes(item);
              return (
                <label
                  key={item}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-foreground/[0.02] has-[:checked]:border-foreground has-[:checked]:bg-foreground/5"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleHeavyItem(item)}
                    className="h-4 w-4"
                  />
                  <span>{item}</span>
                </label>
              );
            })}
          </div>
        </div>

        <FormField
          label="Where is it?"
          htmlFor="pickup_location"
          required
          error={errors.pickup_location}
          hint="Interior + upstairs usually means a labor surcharge."
        >
          <Select
            value={draft.pickup_location}
            onValueChange={(v) => {
              setField('pickup_location', v as (typeof PICKUP_LOCATIONS)[number]);
              clearError('pickup_location');
            }}
          >
            <SelectTrigger id="pickup_location">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {PICKUP_LOCATIONS.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label="Preferred pickup date"
          htmlFor="preferred_date"
          required
          error={errors.preferred_date}
        >
          <Input
            id="preferred_date"
            type="date"
            value={draft.preferred_date ?? ''}
            min={todayISO()}
            onChange={(e) => {
              setField('preferred_date', e.target.value);
              clearError('preferred_date');
            }}
          />
        </FormField>

        <FormField
          label="Need it gone today?"
          htmlFor="same_day_needed"
          hint="Most crews need 24-48h notice; same-day usually carries a rush fee."
        >
          <div className="grid grid-cols-3 gap-2">
            {[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
              { value: 'skip', label: 'Not sure' },
            ].map((opt) => {
              const active = sameDayValue === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSameDay(opt.value)}
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

        <FormField
          label="Anything else?"
          htmlFor="additional_notes"
          hint="Access notes, fragile / hazardous items, gate code, etc."
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
            placeholder="e.g., Behind the side gate, code 1234. One TV is glass — please don't smash."
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
  const draft = useJunkRemovalStore((s) => s.draft);
  const setField = useJunkRemovalStore((s) => s.setField);
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
  const draft = useJunkRemovalStore((s) => s.draft);
  const setStep = useJunkRemovalStore((s) => s.setStep);
  const { errors, validate } = useStepValidation(JunkRemovalIntakeSchema);

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
      else setStep('load');
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
      heading: 'Load',
      editTo: 'load' as StepId,
      lines: [
        draft.volume_bucket,
        (draft.heavy_items?.length ?? 0) > 0
          ? `Heavy items: ${draft.heavy_items!.join(', ')}`
          : undefined,
        draft.pickup_location ? `Pickup: ${draft.pickup_location}` : undefined,
        draft.same_day_needed === true
          ? 'Same-day needed'
          : draft.same_day_needed === false
            ? 'No rush — pick a fair day'
            : undefined,
        draft.preferred_date
          ? 'Preferred: ' +
            new Date(draft.preferred_date + 'T00:00:00').toLocaleDateString(undefined, {
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
  load: LoadStep,
  contact: ContactStep,
  review: ReviewStep,
};
