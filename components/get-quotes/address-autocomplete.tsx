'use client';

// Google Places–backed street-address input with autosuggest dropdown.
//
// UX:
// 1. User types into the street-address field.
// 2. After 250ms of idle typing, we hit /api/places/autocomplete
//    (server-side proxy to Google) and show the predictions as a
//    dropdown below the input.
// 3. User clicks a prediction. We hit /api/places/details to get the
//    structured { address_line, city, state, zip_code } and call
//    `onSelectAddress(parsed)` so the parent can fill its four fields
//    in one shot.
// 4. If the user types freely and never clicks a prediction, we don't
//    block submission — but on blur we show a small "Use this as a
//    custom address?" confirm row. Clicking "Use custom" suppresses
//    further autocomplete for this entry. Clicking "Pick from
//    suggestions" reopens the dropdown (if any).
//
// Session token: one UUID per mounted component, sent with every
// autocomplete + details request. Google bills the whole bundle as
// a single session, which is ~3x cheaper than standalone queries.
//
// This component is deliberately input-only — it doesn't own any
// other state (city/state/zip). The parent form owns those fields
// and updates them via the onSelectAddress callback. Keeps the
// Zustand wiring in one place.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

export type ParsedAddress = {
  address_line: string;
  city: string;
  state: string;
  zip_code: string;
  country: string;
  formatted: string;
  // Optional — present when Place Details returns location.lat/lng
  // (almost always, but PO boxes / fictional addresses can lack them).
  // Persisted as quote_requests.origin_lat / origin_lng for the
  // on-demand business seeder + radius selector.
  latitude?: number | null;
  longitude?: number | null;
};

type Prediction = {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
};

export interface AddressAutocompleteProps {
  /** Current value (controlled). */
  value: string;
  /** Fired on every keystroke — parent should store this as the
   *  field value even before the user picks a prediction. */
  onChange: (value: string) => void;
  /** Fired when the user picks a Google prediction. Parent should
   *  fill its four fields (street/city/state/zip) from the parsed
   *  object. */
  onSelectAddress: (parsed: ParsedAddress) => void;
  /** id attribute for the <input> (accessibility + <label htmlFor>). */
  id?: string;
  placeholder?: string;
  /** autocomplete attr pass-through. */
  autoComplete?: string;
  /** Filters the Google predictions: street → full addresses,
   *  city → localities, zip → postal codes. Defaults to street. */
  type?: 'street' | 'city' | 'zip';
  /** Optional inputMode for the underlying <input>. */
  inputMode?: 'text' | 'numeric';
}

function uuid(): string {
  // Random enough for billing-session scoping — doesn't need to be
  // cryptographically unique, just unlikely to collide within a tab.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelectAddress,
  id,
  placeholder = '123 Main St',
  autoComplete,
  type = 'street',
  inputMode,
}: AddressAutocompleteProps) {
  const [sessionToken] = useState(() => uuid());
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customConfirmed, setCustomConfirmed] = useState(false);
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastQueriedRef = useRef<string>('');

  // ZIP queries become useful at 3 chars (Google can prefix-suggest a
  // ZIP). City/street are fine at 2. Mirrors the server's threshold so
  // we don't fire requests we know will get an empty list back.
  const minQueryLength = type === 'zip' ? 3 : 2;

  // Debounced fetch. We don't use a library for debounce — a ref+
  // timeout is ~10 lines and avoids a dep.
  useEffect(() => {
    if (customConfirmed) return; // user opted out of suggestions
    const q = value.trim();
    if (q.length < minQueryLength) {
      setPredictions([]);
      setOpen(false);
      return;
    }
    if (q === lastQueriedRef.current) return;

    const handle = window.setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      lastQueriedRef.current = q;
      try {
        const res = await fetch(
          `/api/places/autocomplete?q=${encodeURIComponent(q)}&session_token=${sessionToken}&type=${type}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) {
          setPredictions([]);
          setOpen(false);
          return;
        }
        const data = (await res.json()) as { predictions: Prediction[] };
        setPredictions(data.predictions ?? []);
        setOpen((data.predictions ?? []).length > 0);
      } catch {
        // Aborted or network — silent.
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [value, sessionToken, customConfirmed, type, minQueryLength]);

  // Close the dropdown on outside-click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const handleSelect = useCallback(
    async (p: Prediction) => {
      setOpen(false);
      setShowCustomPrompt(false);
      setPredictions([]);
      onChange(p.main_text || p.description);
      try {
        const res = await fetch(
          `/api/places/details?place_id=${encodeURIComponent(p.place_id)}&session_token=${sessionToken}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as ParsedAddress;
        onSelectAddress(data);
      } catch {
        // Silent — the parent already has whatever the user typed.
      }
    },
    [onChange, onSelectAddress, sessionToken]
  );

  const handleBlur = () => {
    // Only show the custom-address prompt if the user has typed
    // something substantive but never picked a suggestion. Don't
    // show it if they're currently selecting (dropdown open).
    window.setTimeout(() => {
      if (customConfirmed) return;
      if (value.trim().length < minQueryLength) return;
      if (predictions.length === 0) return;
      if (!containerRef.current?.contains(document.activeElement)) {
        setShowCustomPrompt(true);
        setOpen(false);
      }
    }, 150);
  };

  const dropdown = useMemo(() => {
    if (!open || predictions.length === 0) return null;
    return (
      <ul
        role="listbox"
        className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border-2 border-foreground/80 bg-background shadow-[4px_4px_0_0_hsl(var(--foreground))]"
      >
        {predictions.map((p) => (
          <li key={p.place_id}>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm hover:bg-lime/60"
              // onMouseDown so the selection fires BEFORE the input's
              // blur handler kicks in and tears down the dropdown.
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(p);
              }}
            >
              <div className="font-medium">{p.main_text}</div>
              {p.secondary_text ? (
                <div className="text-xs text-muted-foreground">{p.secondary_text}</div>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    );
  }, [open, predictions, handleSelect]);

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          // Any typing re-enables autocomplete — user might have opted
          // custom earlier, then decided they do want a Google match.
          if (customConfirmed) setCustomConfirmed(false);
          setShowCustomPrompt(false);
          onChange(e.target.value);
        }}
        onFocus={() => {
          if (predictions.length > 0 && !customConfirmed) setOpen(true);
        }}
        onBlur={handleBlur}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {loading ? (
        <span
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
        >
          …
        </span>
      ) : null}
      {dropdown}

      {/* Custom-address fallback prompt. Appears on blur if the user
          typed a value but didn't pick any suggestion. Keeps the form
          un-blocking — we accept whatever they typed if they confirm. */}
      {showCustomPrompt && !customConfirmed ? (
        <div className="mt-2 rounded-md border-2 border-dashed border-foreground/50 bg-background p-3 text-xs">
          <p className="mb-2 text-muted-foreground">
            Not in Google&rsquo;s suggestions. Use{' '}
            <span className="font-mono text-foreground">{value}</span> as a custom address?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setCustomConfirmed(true);
                setShowCustomPrompt(false);
              }}
              className="rounded-md border-2 border-foreground bg-lime px-2.5 py-1 font-mono uppercase tracking-widest"
            >
              Use custom
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCustomPrompt(false);
                setOpen(predictions.length > 0);
              }}
              className="rounded-md border-2 border-foreground/40 px-2.5 py-1 font-mono uppercase tracking-widest hover:bg-foreground/5"
            >
              Pick from suggestions
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
