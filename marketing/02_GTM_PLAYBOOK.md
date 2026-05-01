# EvenQuote — Go-to-Market Playbook

The full strategy. Read once, refer back monthly. Tactics live in `03_30_DAY_SPRINT.md`.

## 1. The product in one sentence

EvenQuote is a $9.99 service that calls local moving and cleaning companies on your behalf and emails you a clean comparison of their real quotes within an hour.

## 2. The job-to-be-done

When a homeowner needs a service quote, the existing options are all painful:

| Option | Why it sucks |
|---|---|
| Call 5 contractors yourself | Takes 3–4 hours. Some don't pick up. Quotes vary wildly. You take notes on a napkin. |
| Thumbtack / HomeAdvisor / Angi | You become the lead. 5+ companies spam-call you for 2 weeks. Quotes are anchored on the platform's bidding model, not your job. |
| Yelp / Google + manual outreach | Reviews don't translate to pricing. Same phone-tag problem. |
| Ask Reddit / Nextdoor | Recommendations, no quotes. Still have to make calls. |

Customer hires EvenQuote to **eliminate phone tag and present apples-to-apples quotes**, while keeping their phone number out of the contractor lead-gen ecosystem. That's the wedge.

## 3. Positioning

**Category:** Quote brokerage / "concierge for service quotes"

**Against the obvious competitors:**

- vs **Thumbtack/HomeAdvisor**: We don't sell your contact info. You stay anonymous until you pick a winner. One charge, no spam.
- vs **DIY phone calls**: We do the calling. Your time back, no awkward "can you beat that price" conversations.
- vs **Yelp**: Reviews are not quotes. We get you the actual number.

**Positioning statement:**
> For homeowners who need a service quote without becoming a sales lead, EvenQuote is the $9.99 concierge that calls local pros on your behalf and emails you a clean comparison in under an hour. Unlike lead-gen marketplaces, we never sell your contact info — you stay anonymous until you pick a winner.

**Brand voice:** Plain English. No corporate mush. Slightly skeptical of the home-services industry. Treats the customer as a smart adult who has been burned before.

## 4. ICP — who you're acquiring first

### Primary ICP A — Mid-move homeowner (Moving)

- Age 28–45, household income $75k+
- Just signed a lease or bought a house, move date in 14–45 days
- Has tried calling 1–2 movers, hit voicemail, doesn't want to do it 5 more times
- Geo for first 90 days: top 10 US metros by moving volume (NYC, LA, San Diego, SF Bay, Seattle, Austin, Dallas, Denver, Phoenix, Atlanta)
- Pain peak: 3 weeks before move date. That's when you want the ad to find them.

**Where they hang out:**
- Google search (high intent — "moving companies [city] quotes", "how much does a 2 bedroom move cost")
- r/movingout, r/HomeImprovement, r/[city] subreddits
- Local Facebook groups ("Moving to [city]", "[city] newcomers")
- Apartment complex / leasing office handoffs

### Primary ICP B — Move-out cleaner (Cleaning)

- Renter at end of lease, needs a deep clean to recover deposit
- Age 24–38, often a first or second-time renter
- Spike of need: 2 weeks before lease end
- Geo same as above

**Where they hang out:**
- Google ("move out cleaning [city]", "deposit cleaning checklist")
- Reddit (r/CleaningTips, r/PersonalFinance for deposit-recovery posts)
- TikTok cleaning content
- Nextdoor

### Secondary ICPs (later)

- Recurring-cleaning shopper (lower urgency, higher LTV) — defer to month 3
- Handyman / lawn-care (your bonus verticals) — let SEO carry these for now; no paid spend until volume justifies it

## 5. Channel mix for sub-$500/month

| Channel | Monthly $ | Stage | Why this channel |
|---|---|---|---|
| Google Search Ads | $250 | Acquire | Highest intent. Bid on long-tail "[vertical] quotes [city]" terms. CPCs $1–$3. Aim for 80–250 clicks/month. |
| Meta retargeting | $100 | Recover | Pixel form-abandoners + homepage visitors. Cheap, captures the people you already paid to bring once. |
| Reddit Ads (test) | $75 | Test | $5/day on r/movingout + r/CleaningTips with geo overlay. Cheapest paid test you can run. Kill or scale by Week 3. |
| Buffer | $75 | Scale winner | At end of week 2, take this and pour it into whichever of the above is showing positive unit economics. |

Skip in month one (do not negotiate with yourself):

- Influencer marketing — overpriced for $9.99 ARPU
- TikTok Ads — too expensive for narrow geo + low-AOV product
- LinkedIn — wrong audience entirely
- Display Ads / Programmatic — burns money on view-throughs you can't measure
- Press release services / PRWeb — pure waste at this size
- Affiliate networks — not enough margin at $9.99
- A new brand redesign / Webflow rebuild — that money is six months of paid ads

## 6. Organic motion (free, compounds slowly)

Run these in parallel — they're not optional, they're how you stop being dependent on paid.

### SEO

- Per-vertical, per-city programmatic pages (`/get-quotes/moving/san-diego`)
- Five cornerstone blog posts targeting top-of-funnel queries:
  1. "How much does a 2-bedroom move cost in [city]?"
  2. "10 questions to ask a mover before you book"
  3. "The complete move-out cleaning checklist landlords actually use"
  4. "Moving company red flags: how to spot a scam in 5 minutes"
  5. "What's the cheapest day of the week to move?"
- Schema.org `Service` and `LocalBusiness` markup on each vertical/city page
- Submit sitemap to Google Search Console + Bing Webmaster Tools

Realistic timeline: zero traffic month 1, indexed by month 2, 50–200 organic visits/mo by month 4. SEO is a pension, not a paycheck — start now, harvest later.

### Community

- Reddit: be a real human in r/movingout (and city subs) for 30 days before mentioning EvenQuote. Comment helpfully on 3 threads/day. When someone explicitly asks for a tool that does what you do, link with full disclosure.
- Nextdoor: offer free service to the first 10 neighbors who reply to a post. Harvest testimonials.
- Local Facebook groups (per city): same playbook.

### Press / launch story

- ProductHunt launch in week 4 (timed for max signal)
- BetaList listing (free)
- IndieHackers post documenting "I built an AI quote concierge as a solo founder" — Antonio's story is the hook
- Pitch one local SD outlet (Voice of San Diego, Times of SD): "San Diego founder builds tool to fix the home-services nightmare"

## 7. KPIs and unit economics

### What to measure (top 5)

1. **CAC by channel** — paid spend ÷ paid quote requests, per channel, per week
2. **Activation rate** — paid requests ÷ unique homepage visitors
3. **Completion rate** — quotes successfully delivered ÷ paid requests (your refund risk indicator)
4. **Refund rate** — refunds issued ÷ paid requests (target <8%)
5. **NPS / CSAT proxy** — % of customers who say they'd use again (single email survey question)

### Unit economics — the math you can't dodge

At $9.99 ARPU and ~$2–4 in variable cost (Vapi minutes, Stripe fee, Resend), gross margin per request is roughly $5–7. Your CAC ceiling for sustainable paid acquisition without repeat purchase is therefore ~$5.

That's brutal. Repeat purchase is what saves you. Real targets:

| Metric | Month 1 target | Month 3 target | Month 6 target |
|---|---|---|---|
| Paid requests / mo | 30 | 150 | 500 |
| Blended CAC | $15 (loss-leader OK to learn) | $8 | $4 |
| Refund rate | <12% (early kinks) | <8% | <5% |
| Repeat / referral % | 5% | 15% | 25% |
| Org traffic % of total | 5% | 25% | 50% |

If by end of month 3 your blended CAC is still above $10 and repeat is still below 10%, the unit economics don't work at $9.99 — go to $14.99 or add a second SKU (e.g., $29 "rush" tier with 30-min turnaround). Don't ride a losing horse hoping it gets faster.

## 8. The 90-day milestones

| When | Milestone |
|---|---|
| End of week 1 | Site fixes shipped, GA4 live, first $1 of paid spend deployed |
| End of week 2 | First 20 paid requests, baseline CAC measured, refund rate measured |
| End of week 4 | ProductHunt launch, first 100 paid requests, kill worst channel, double winner |
| End of month 2 | First 5 testimonials live on site, first organic blog post indexed, $300 weekly spend if unit economics allow |
| End of month 3 | 500 cumulative paid requests, repeat rate >15%, decision point on price test |

## 9. Risks to watch

- **Vapi cost spike** — if AI minutes blow past $4/request, gross margin collapses. Monitor weekly.
- **Refund rate >15%** — means the product isn't delivering. Stop ad spend, fix the product.
- **Contractor backlash** — local pros may not love being called by AI. Have a pleasant opt-out flow ready (and a press response).
- **Single-channel dependency** — if 90% of growth is Google Ads and Google bans your account or CPCs spike, you're dead. Diversify by month 3.

## 10. The one-line plan

> Fix the trust gaps, ship the analytics, send $250/month to Google Search for high-intent moving + cleaning queries, retarget the abandoners on Meta, seed Reddit organically, harvest testimonials in real-time, and decide by Day 30 whether the unit economics deserve more capital.
