'use client';

// Address block — 4 fields (street / city / state / ZIP).
//
// Shared by the Origin and Destination steps. Field names are prefixed
// via the `prefix` prop so a single block renders correctly in both
// contexts ('origin_zip' vs 'destination_zip').
//
// We stage values through local handlers that both update the global
// store and clear any existing error on that field, so the error
// disappears as soon as the user starts fixing it.

import { useIntakeStore } from '@/lib/forms/intake-store';
import { US_STATES, type MovingIntakeDraft } from '@/lib/forms/moving-intake';
import { FormField } from './form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FieldErrors } from '@/lib/forms/use-step-validation';
import { AddressAutocomplete, type ParsedAddress } from './address-autocomplete';

type AddressPrefix = 'origin' | 'destination';

type AddressKeys<P extends AddressPrefix> =
  | `${P}_address`
  | `${P}_city`
  | `${P}_state`
  | `${P}_zip`
  | `${P}_lat`
  | `${P}_lng`;

type Props<P extends AddressPrefix> = {
  prefix: P;
  errors: FieldErrors;
  onFieldChange?: (field: AddressKeys<P>) => void;
};

export function AddressBlock<P extends AddressPrefix>({
  prefix,
  errors,
  onFieldChange,
}: Props<P>) {
  const draft = useIntakeStore((s) => s.draft);
  const setField = useIntakeStore((s) => s.setField);

  const keyAddress = `${prefix}_address` as const;
  const keyCity = `${prefix}_city` as const;
  const keyState = `${prefix}_state` as const;
  const keyZip = `${prefix}_zip` as const;

  // Typed getter — casts the draft value to its expected type.
  // Draft values may be undefined while partially filled.
  const get = <K extends keyof MovingIntakeDraft>(k: K) =>
    (draft[k] ?? '') as string;

  const update = (field: AddressKeys<P>, value: string) => {
    setField(field as keyof MovingIntakeDraft, value as never);
    onFieldChange?.(field);
  };

  const keyLat = `${prefix}_lat` as const;
  const keyLng = `${prefix}_lng` as const;

  // When the user picks a Google prediction, fill all four fields at
  // once. Only overwrite city/state/zip if Google returned something
  // — preserves whatever the user may have already typed if Google's
  // parse is incomplete (rare, but happens for PO boxes etc.).
  // Also stash lat/lng on the draft when present — the on-demand
  // business seeder + radius selector need them, and they're "free"
  // here because Place Details already returned them.
  const handleAutocompletePick = (parsed: ParsedAddress) => {
    if (parsed.address_line) update(keyAddress as AddressKeys<P>, parsed.address_line);
    if (parsed.city) update(keyCity as AddressKeys<P>, parsed.city);
    if (parsed.state) update(keyState as AddressKeys<P>, parsed.state);
    if (parsed.zip_code) update(keyZip as AddressKeys<P>, parsed.zip_code);
    // setField is typed as <K, V extends Draft[K]> — the cast funnels
    // a number through the same typed setter the address-string fields
    // use. Numeric typing is enforced by Zod on submit.
    if (typeof parsed.latitude === 'number') {
      setField(keyLat as keyof MovingIntakeDraft, parsed.latitude as never);
    }
    if (typeof parsed.longitude === 'number') {
      setField(keyLng as keyof MovingIntakeDraft, parsed.longitude as never);
    }
  };

  return (
    <div className="space-y-5">
      <FormField
        label="Street address"
        htmlFor={keyAddress}
        required
        error={errors[keyAddress]}
      >
        <AddressAutocomplete
          id={keyAddress}
          autoComplete={prefix === 'origin' ? 'address-line1' : 'shipping address-line1'}
          value={get(keyAddress)}
          onChange={(v) => update(keyAddress as AddressKeys<P>, v)}
          onSelectAddress={handleAutocompletePick}
          placeholder="Start typing — we'll suggest addresses"
        />
      </FormField>

      <div className="grid gap-5 sm:grid-cols-[1fr_auto_auto]">
        <FormField label="City" htmlFor={keyCity} required error={errors[keyCity]}>
          <AddressAutocomplete
            id={keyCity}
            type="city"
            autoComplete={prefix === 'origin' ? 'address-level2' : 'shipping address-level2'}
            value={get(keyCity)}
            onChange={(v) => update(keyCity as AddressKeys<P>, v)}
            onSelectAddress={handleAutocompletePick}
            placeholder="San Diego"
          />
        </FormField>

        <FormField
          label="State"
          htmlFor={keyState}
          required
          error={errors[keyState]}
          className="sm:w-32"
        >
          <Select
            value={get(keyState) || undefined}
            onValueChange={(v) => update(keyState as AddressKeys<P>, v)}
          >
            <SelectTrigger id={keyState}>
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
          htmlFor={keyZip}
          required
          error={errors[keyZip]}
          className="sm:w-36"
        >
          <AddressAutocomplete
            id={keyZip}
            type="zip"
            inputMode="numeric"
            autoComplete="postal-code"
            value={get(keyZip)}
            onChange={(v) => update(keyZip as AddressKeys<P>, v)}
            onSelectAddress={handleAutocompletePick}
            placeholder="92101"
          />
        </FormField>
      </div>
    </div>
  );
}
