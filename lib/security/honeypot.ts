// Form honeypot — invisible decoy fields to catch naive form-fill bots.
//
// HOW IT WORKS
// ────────────
// A real human never sees nor fills the honeypot field (it's hidden via
// CSS + ARIA + an autocomplete='off' hint). Naive scraping bots that
// fill every input they find DO populate it. Server actions check the
// field at the boundary and reject anything non-empty.
//
// FIELD NAME CHOICE
// ─────────────────
// `website_url` is deliberately bait-shaped: bots that scan inputs by
// name often have logic like "if name matches /url|website|link/i,
// inject a spam URL." Naming it `_honeypot` would only catch the
// laziest bots; `website_url` catches a meaningfully larger fraction.
//
// We deliberately do NOT use a name that might collide with a real
// field elsewhere in the system (`url`, `link`, `email`, `phone`).
//
// LIMITATIONS
// ───────────
//   • Only catches DOM-driven bots. An attacker scripting against the
//     server action directly bypasses it entirely. Pair with rate
//     limits + Turnstile for layered defense.
//   • Some browser autofill extensions might auto-fill honeypot fields.
//     Mitigated with `autocomplete='off'`, `tabindex='-1'`, ARIA
//     hidden, and the bait-name choice (autofill is unlikely to map
//     to `website_url`).
//   • A determined bot author who reads our source code can disable
//     the honeypot. The honeypot is for low-effort bots; high-effort
//     attackers cost us more in code complexity than we save.
//
// USAGE
// ─────
// Server side (in the action):
//   import { isHoneypotTripped, HONEYPOT_FIELD_NAME } from '@/lib/security/honeypot';
//   const tripped = isHoneypotTripped(raw);
//   if (tripped) return { ok:false, error: GENERIC_BOT_ERROR };
//   // ... continue with normal validation
//
// Client side (in the form shell):
//   import { HoneypotInput } from '@/components/security/honeypot-input';
//   <HoneypotInput value={hp} onChange={setHp} />
//   // include `[HONEYPOT_FIELD_NAME]: hp` in the payload sent to the
//   // server action.

/**
 * The single hidden field name used across all forms. Keep stable —
 * changing it requires a coordinated UI + server update. Prefer adding
 * a second decoy field over renaming this one if we want more variety.
 */
export const HONEYPOT_FIELD_NAME = 'website_url' as const;

/**
 * Generic error string returned to the client when the honeypot trips.
 * Deliberately matches the rate-limit / validation copy so the bot
 * can't tell from the error message that it got caught — that would
 * leak the trip-condition and let the bot iterate around it.
 */
export const HONEYPOT_GENERIC_ERROR =
  'Could not save your request. Please try again.';

/**
 * Returns `true` if the payload's honeypot field is populated with
 * any non-whitespace content. Returns `false` for missing field,
 * undefined, null, empty string, or whitespace-only string — those
 * are all valid "human didn't see this field" outcomes.
 *
 * Accepts `unknown` because the payload is the raw form submission;
 * we look up the field name without trusting any structural shape.
 */
export function isHoneypotTripped(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const v = (raw as Record<string, unknown>)[HONEYPOT_FIELD_NAME];
  if (v == null) return false;
  if (typeof v !== 'string') {
    // Anything non-string in this field is also a bot signal — humans
    // can't submit anything but a string from a text input.
    return true;
  }
  return v.trim().length > 0;
}
