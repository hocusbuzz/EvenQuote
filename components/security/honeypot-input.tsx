'use client';

// Hidden honeypot input — never visible to humans, naturally filled by
// naive form-fill bots. See lib/security/honeypot.ts for the full
// rationale.
//
// VISIBILITY CONTRACT
// ───────────────────
// All three layers must hide this field, because each addresses a
// different "human" path:
//   • CSS `display:none` + `visibility:hidden` + position-off-screen
//     → standard sighted users (any one would suffice; we layer for
//     CSS-loading edge cases).
//   • `tabindex={-1}` → keyboard users (can't tab to it).
//   • `aria-hidden="true"` + `aria-label` is OMITTED → screen-reader
//     users (the AT skips the field).
//   • `autocomplete="off"` + bait-y name `website_url` → password
//     managers / autofill extensions skip it (most autofill heuristics
//     map to `email`, `phone`, `address` — `website_url` rarely hits).
//
// If you change anything here, re-verify against:
//   1. Tab through the form with keyboard only — must skip the field.
//   2. Fire VoiceOver / NVDA — must not announce the field.
//   3. 1Password / Chrome autofill — must not pre-fill the field.

import { HONEYPOT_FIELD_NAME } from '@/lib/security/honeypot';

type Props = {
  value: string;
  onChange: (value: string) => void;
};

export function HoneypotInput({ value, onChange }: Props) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: '-9999px',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      <label htmlFor={HONEYPOT_FIELD_NAME}>
        Leave this field blank if you are human:
      </label>
      <input
        type="text"
        id={HONEYPOT_FIELD_NAME}
        name={HONEYPOT_FIELD_NAME}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        tabIndex={-1}
      />
    </div>
  );
}
