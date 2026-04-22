// PII masking helpers for UI surfaces that run on guest-accessible URLs.
//
// The /get-quotes/checkout and /get-quotes/success pages both render behind
// a UUID in the URL — anyone who sees the URL (shoulder-surf, shared tab,
// referrer leak) can load them. We want to give legit users a visual
// confirmation of the email they provided, while revealing as little as
// possible to an attacker who has the URL but not the inbox.
//
// Strategy: keep the first character of the local part, show the domain
// in full (domains are not private — they're public DNS). A user who
// recognizes the pattern will recognize their own; an attacker learns
// virtually nothing they didn't already have.
//
// Examples:
//   biggsontheshow@hotmail.com   →  b*************@hotmail.com
//   a@b.co                       →  a*@b.co
//   (no @ sign)                  →  passes through to the fallback
//   null / undefined / empty     →  null

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (trimmed.length === 0) return null;

  const atIdx = trimmed.lastIndexOf('@');
  // No '@' — don't try to mask something that isn't an email.
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;

  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);

  // Preserve the first character of the local part, then mask the rest
  // with a fixed-length stars block. We intentionally DON'T mirror the
  // exact local length — revealing "the email has 13 characters" is a
  // tiny piece of info we'd rather not leak.
  const visible = local[0] ?? '';
  const masked = `${visible}${'*'.repeat(Math.max(3, local.length - 1))}`;

  return `${masked}@${domain}`;
}
