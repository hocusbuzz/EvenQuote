# Message for the EvenQuote — Main Dev Channel conversation

Posted from the marketing-sprint conversation on 2026-05-01. Two blockers from the live-site marketing audit that need to ship before any paid traffic.

---

🚨 **Two pre-paid-traffic blockers from the marketing audit** (full pack in `/EvenQuote/marketing/`):

### 1. Kill the "v0.1 — pre-launch" footer badge

We're charging $9.99 for real work — that badge tells visitors not to trust us with their card or their move date. 5-min fix, biggest single ROI in the entire audit.

**Acceptance:** No "pre-launch" / "v0.1" / "beta" string anywhere in the user-visible UI on prod. If we want to track release versions internally, put it in an HTML comment or a backend health endpoint.

### 2. Wire analytics before any paid spend

No GA4, Meta Pixel, or Reddit Pixel visible in static HTML right now. Without them every ad dollar is unmeasurable and unrecoverable.

**Acceptance:**
- GA4 wired in `app/layout.tsx` with three custom events firing in prod:
  - `quote_request_started` (intake form first field touched)
  - `quote_request_paid` (Stripe success webhook)
  - `quote_delivered` (Resend send succeeded)
- Meta Pixel + Reddit Pixel installed (same file)
- UTM params (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`) captured into the `quote_requests` row server-side
- Verified end-to-end with one real visit (DebugView in GA4, Pixel Helper extension for Meta, Reddit dashboard)

### Why these two now

Day 8 of the marketing sprint is when the first Google Ads campaign turns on ($8/day, hyper-local San Diego, moving vertical). If items #1 and #2 aren't live before then, every paid click hits a "pre-launch" page we can't measure. That's the ad-budget version of throwing $250 in the ocean.

### Where the rest lives

- `marketing/01_SITE_AUDIT.md` — five fixes total (#3 = per-vertical canonicals, #4 = social-proof bar, #5 = `/pricing` page); these can land within the first 7 days
- `marketing/03_30_DAY_SPRINT.md` — day-by-day what runs when
- `marketing/02_GTM_PLAYBOOK.md` — full strategy + budget allocation if anyone asks "why are we doing this?"

— from the marketing-sprint conversation
