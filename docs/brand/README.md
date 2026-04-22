# EvenQuote — brand assets

This folder is the source of truth for the EvenQuote brand at v0.1.
Everything here is editable — don't treat it as external / vendored.

## Files

- **`BRAND.html`** — the visual one-pager. Open in a browser for full
  fidelity (uses Fraunces + Geist from Google Fonts). Covers: wordmark
  lockups, logo mark direction, palette with contrast guidance, type
  specimen, voice & tone do/don't, favicon grid, OG image mockup, and a
  full DNS / email setup cheatsheet for `evenquote.com`.
- **`mark.svg`** — the primary logo mark ("even bars"). Uses
  `fill="currentColor"` so you can recolor via CSS.
- **`wordmark.svg`** — the Fraunces wordmark, with the "Quote" half
  tagged `.accent` so you can split-color it (ink + lime) from CSS.

## Quick reference

| Token      | Hex        | Use                                       |
|------------|------------|-------------------------------------------|
| `ink`      | `#0A0A0A`  | Body text, dark surfaces, CTA borders.    |
| `cream`    | `#F5F1E8`  | Page background, cards.                   |
| `lime`     | `#CEFF00`  | Accent panels, CTAs on ink.               |
| `lime-deep`| `#9FCC00`  | Hover states, wordmark accent on cream.   |

Display type: **Fraunces** (700–900, tight tracking).
Body type: **Geist** (400–600).
Mono: **Geist Mono** (400–500) for eyebrows, IDs, timestamps.

## Day-one todos for the domain

1. Register mailboxes: `antonio@`, `support@`, `noreply@`, `dmarc@`,
   `hello@`, `legal@` on evenquote.com.
2. Publish **one** SPF record including every sender (Workspace, Resend,
   etc.). Two SPF records = both invalid.
3. Start DMARC at `p=none` with a reporting address. Tighten to
   `p=quarantine` after 2 clean weeks.
4. Add DKIM per sender (Workspace has its own; Resend/SES have theirs).
5. Point apex + www to Vercel (A + CNAME), TLS will auto-issue.

Full DNS examples are in `BRAND.html` → "Domain & email setup".

## When to upgrade this

If we hire a designer, hand them `BRAND.html` as the starting brief.
Everything here is deliberately minimum-viable-brand — enough to ship,
not so much that a real designer feels locked in.
