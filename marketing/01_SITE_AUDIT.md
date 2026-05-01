# Site Audit — evenquote.com (2026-05-01)

Live audit of the production site. What's there, what's broken, what to fix before sending paid traffic.

## What's live

- Homepage with hero, footer, schema.org markup
- Four intake verticals working: `/get-quotes/moving`, `/get-quotes/cleaning`, `/get-quotes/handyman`, `/get-quotes/lawn-care`
- $9.99 flat fee per quote request
- Robots.txt + sitemap.xml properly configured (6 URLs indexed-eligible)
- OG tags + Twitter card + Organization JSON-LD
- 7-day refund policy (per legal pages)
- Footer: "© 2026 EvenQuote · Hocusbuzz LLC"

## Current copy (verbatim)

| Slot | Text |
|---|---|
| Title tag | "EvenQuote — Get real quotes in an hour, not a week" |
| Meta description | "We dial local pros for you. You get a clean comparison report in your inbox. $9.99 flat." |
| Tagline (footer/schema) | "Stop chasing quotes. Start comparing them." |
| Intake H1 | "Let's get you some numbers." |
| Intake category eyebrow | "Moving quote" / "House Cleaning quote" |
| Form helper | "Progress is saved in your browser. Close this tab — it'll be here when you come back." |
| 404 copy | "No harm done — we didn't call anyone." |

The tagline + meta description are strong. The intake H1 is weak — generic, doesn't sell the outcome. Fix list below.

## Five fixes to ship before any paid traffic

These are blockers. Fixing them costs hours, not dollars, and 10x's the ROI of every ad you'll run.

### Fix 1: Kill "v0.1 — pre-launch" in footer

The footer (or somewhere on-site) carries a "v0.1 — pre-launch" badge. You're charging real money. A pre-launch badge tells visitors: "this might not work, don't trust us with your $9.99 or your moving date."

**Action:** Remove the badge entirely. If you want to track release versions internally, put it in an HTML comment or a backend health endpoint, not the user-facing UI.

### Fix 2: Add an analytics tag

No GA4, PostHog, or Plausible visible in the static HTML. You cannot run paid ads without conversion measurement. Every dollar is wasted otherwise.

**Action:** Wire GA4 (free) with three custom events:
- `quote_request_started` (intake form first field touched)
- `quote_request_paid` (Stripe success webhook)
- `quote_delivered` (email send succeeded)

Then add Meta Pixel + Reddit Pixel for retargeting. These take ~30 minutes each via GTM if you'd rather not touch Next.js. (Honestly, just do it directly in `app/layout.tsx` — fewer moving parts.)

### Fix 3: Per-vertical canonical URLs + per-vertical meta

Today every page has the same canonical pointing to the homepage. Google can't distinguish your moving page from your cleaning page, which kills your chance at long-tail SEO.

**Action:** In each `app/get-quotes/[vertical]/page.tsx`, set:
- `canonical: https://evenquote.com/get-quotes/{vertical}`
- Title: `Get [Vertical] Quotes in an Hour — EvenQuote`
- Meta description rewritten per vertical (see ad copy doc for examples)

### Fix 4: Add a social-proof bar above the fold

Zero testimonials, reviews, or stats on the live site. For a marketplace where the customer is asked to give you their phone number AND their money before seeing results, this is fatal.

**Action:** Even before you have 100 reviews, do this:
- Pick three early customers, get their permission, put their first name + city + one-sentence quote on the homepage hero ("Saved me 4 hours of phone calls — Marcus, San Diego")
- A counter ("X local pros called on your behalf last month") — count from your DB, refresh weekly
- A small "Powered by Stripe + verified businesses" badge row near the CTA

If you have zero customers today, run the first 5 yourself at cost (or free) just to harvest the testimonials. No paid traffic until you have 3 to display.

### Fix 5: Build a /pricing page

There's no dedicated pricing page. The $9.99 number is in the meta description but not anchored on a page that explains what it includes vs doesn't.

**Action:** Single-page `/pricing` covering:
- What you get for $9.99 (number of pros called, format of report, turnaround time)
- 7-day refund window in plain English
- Two real comparison rows: "DIY (call 5 pros yourself) ~ 4 hours of your time" vs "EvenQuote $9.99, 1 hour, done in your inbox"
- FAQ: 5 questions max ("What if no one answers?", "What if the quotes are too high?", "How do I get a refund?", "Are these contractors vetted?", "Can I talk to a human?")

This page becomes your highest-converting destination URL for paid Google Search ads.

## Six fixes that can wait two weeks

These matter, but won't make or break the first paid traffic test.

1. **Per-vertical landing pages with city modifiers** (`/get-quotes/moving/san-diego`, `/get-quotes/cleaning/los-angeles`). Each becomes a long-tail SEO asset and a programmatic landing page for Google Ads. Start with the top 5 metros only.
2. **Exit-intent email capture** on intake forms. Use Resend or a free tool like ConvertKit's free tier. "Not ready? We'll send a 5-minute checklist for picking a [vertical] pro."
3. **/reviews page** that aggregates testimonials + a Google Reviews embed. Drives schema.org Review markup → star ratings in SERPs.
4. **Live chat widget** (Crisp free tier or Intercom messenger). Pre-purchase questions get answered, conversion rate climbs.
5. **/blog with 5 cornerstone posts** ("How to spot a moving company scam in 5 minutes", "What does a one-bedroom move cost in 2026?", etc.). SEO compounds.
6. **Sentry + PostHog** for product analytics on the funnel (already on the prod-readiness backlog as #1; tag it with "marketing measurement also blocked" so it gets prioritized).

## Three fixes that are nice-to-have

1. Better intake H1 — see ad copy doc for variants to test.
2. A founder photo + 2-line story on the about page. Solo-founder credibility plays well in DTC services.
3. Press kit page (`/press`) with logos, screenshots, and a one-paragraph blurb reporters can copy. Free PR is achievable for the launch story.

## Won't-do (explicitly)

- Don't redesign. The site is clean. Spending on a rebrand is the classic founder mistake.
- Don't add a video hero. Adds weight, untested ROI, expensive to make.
- Don't add a chatbot AI assistant on the homepage. The site already takes intake; another bot creates decision fatigue.
- Don't switch to a different tech stack to "improve speed." Next.js bundle is fine.
