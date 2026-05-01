# EvenQuote — Marketing Pack

Built 2026-05-01 as a parallel workstream to the production-readiness sprint. Goal: turn the live portal at evenquote.com into a customer-acquisition machine on a sub-$500/month budget.

## What's in this folder

| File | What it's for |
|---|---|
| `01_SITE_AUDIT.md` | What's live today, what's broken for marketing, the 5 fixes to ship before any paid traffic |
| `02_GTM_PLAYBOOK.md` | Positioning, ICP, channel mix, KPIs, 90-day milestones |
| `03_30_DAY_SPRINT.md` | Day-by-day calendar for the first 30 days. Pick it up and execute. |
| `04_AD_COPY.md` | Google Search Ads + Meta + Reddit copy variants for moving and cleaning, ready to paste |
| `05_EMAIL_SEQUENCES.md` | Confirmation, results-delivered, no-result, win-back. Ready for Resend templates. |
| `06_REDDIT_AND_COMMUNITY.md` | Subreddit list, value-first comment templates, FB groups, Nextdoor playbook |
| `07_PARTNERSHIP_PITCHES.md` | Cold outreach scripts for Realtors, leasing offices, property managers |

Plus a live dashboard artifact (Cowork sidebar) you can re-open daily to log spend, requests, and progress against the 30-day plan.

## How to use this

1. **Today (Day 0):** Read `01_SITE_AUDIT.md`. Ship the 5 critical fixes. Most importantly: kill the "v0.1 — pre-launch" footer badge. You can't charge $9.99 for a service that brands itself as pre-launch.
2. **This week:** Execute Days 1–7 of `03_30_DAY_SPRINT.md`. Wire up GA4 + Meta Pixel + Reddit Pixel. Set up the Resend email templates from `05_EMAIL_SEQUENCES.md`.
3. **Daily:** Open the marketing dashboard. Log yesterday's spend + requests. Take the day's actions from the sprint plan. Move on.
4. **Weekly:** Review CAC by channel. Kill the worst-performing channel, double down on the best.

## The brutal truth (so you don't waste money)

You have a **product problem** and a **distribution problem**, in that order. The audit found:

- Zero social proof on the live site. No testimonials, no review widget, no trust signals.
- Footer literally says "v0.1 — pre-launch" while you're charging real money.
- No analytics tag visible — every dollar of paid spend right now is unmeasurable.
- All pages share one canonical URL. SEO can't differentiate moving from cleaning.

**Fix the trust + measurement gaps first.** Otherwise, paid traffic burns and you can't learn from what burned. The first week of this sprint is intentionally heavy on plumbing for that reason.

## Budget allocation (recommended for $500/mo)

| Channel | Monthly $ | Why |
|---|---|---|
| Google Search Ads | $250 | Highest intent — people searching "moving company quotes [city]" |
| Meta retargeting | $100 | Catch the form abandoners (your conversion will not be 100%) |
| Reddit Ads (small test) | $75 | Cheap CPMs, r/movingout, r/CleaningTips, geo-targeted |
| Tools (Search Console, Plausible/GA4 free, Mailchimp/Resend free) | $0 | Free tier covers month one |
| Buffer / contingency | $75 | Burn on the channel that's working by week 3 |

Skip everything else for month one. No SEO tools subscriptions, no Webflow rebuild, no influencer spend, no PR firm. You're a solo founder validating a $9.99 product — survive month one with hard data, then expand.
