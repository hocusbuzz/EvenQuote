# 30-Day Launch Sprint

Day-by-day. Pick it up, do the day's actions, log progress in the dashboard. Each day is sized for ~60–90 min of solo-founder time on top of your dev work.

Legend: 🛠 = product/site fix · 📊 = measurement · 📣 = paid · 🌱 = organic · 📝 = content · 🤝 = partnerships · 📞 = ops

---

## Week 1 — Plumbing (no paid spend yet)

### Day 1 (Friday)
- 🛠 Remove "v0.1 — pre-launch" footer badge. Push to prod.
- 📊 Create GA4 property at analytics.google.com. Get measurement ID.
- 📊 Add GA4 script to `app/layout.tsx` with custom events: `quote_request_started`, `quote_request_paid`, `quote_delivered`.
- ✅ End of day: GA4 firing on real visit (check DebugView).

### Day 2 (Saturday)
- 🛠 Per-vertical canonical URLs + per-vertical title/meta on all 4 vertical pages.
- 📊 Submit sitemap to Google Search Console + Bing Webmaster Tools.
- 📊 Wire Meta Pixel + Reddit Pixel to layout.tsx. Test fires using Meta Pixel Helper extension.
- ✅ End of day: All four pages indexed-eligible with unique meta. Pixels firing.

### Day 3 (Sunday)
- 🛠 Build `/pricing` page using copy in this folder (`02_GTM_PLAYBOOK.md` Section 4 + audit Fix 5). Single page, minimal CSS.
- 🛠 Add basic social-proof bar to homepage: "Powered by Stripe + verified local pros". Even without testimonials, this trust signal helps.
- ✅ End of day: /pricing live and linked from homepage.

### Day 4 (Monday)
- 📞 Run 3 EvenQuote requests yourself (or for friends/family) at cost. Document the experience. Ask the 3 customers for permission to use first name + city + quote.
- 📝 Write Resend email templates (use copy from `05_EMAIL_SEQUENCES.md`). Confirmation + Results-delivered first.
- ✅ End of day: 3 testimonials in your back pocket. Confirmation email sending in prod.

### Day 5 (Tuesday)
- 🛠 Add testimonial bar to homepage hero (3 testimonials harvested Day 4).
- 📝 Write No-result email + Win-back email templates. Wire up.
- 🌱 Create Reddit account if you don't have one (separate from personal). Username = real first name + last initial. Add a real bio sentence. Comment helpfully on 3 r/movingout threads. NO mention of EvenQuote yet.
- ✅ End of day: 3 testimonials live, full email lifecycle wired, Reddit account warming up.

### Day 6 (Wednesday)
- 📊 Create conversion goal in GA4 + Meta Ads Manager + Google Ads = `quote_request_paid` event.
- 📊 Set up UTM parameter convention. Document in spreadsheet (`utm_source/medium/campaign/content/term`).
- 🛠 Add UTM-aware logging server-side (capture from URL into `quote_request` row).
- ✅ End of day: end-to-end attribution chain working.

### Day 7 (Thursday)
- 🌱 Comment on 3 more Reddit threads in r/movingout, r/CleaningTips. Still no link.
- 📊 Verify GA4 → ad platform conversion handoff is working with a self-test (run a $5 test campaign with one impression).
- 📞 Operations check: Vapi cost per call (last 7 days), refund rate, completion rate. Capture as Week 1 baseline.
- ✅ End of week 1: Plumbing done. Ready for paid traffic Monday.

---

## Week 2 — First paid spend

### Day 8 (Friday)
- 📣 Create Google Ads account if needed. Add billing.
- 📣 Build first Search campaign: "Moving Quotes — San Diego" (start hyper-local). Bid on:
  - "moving company quotes san diego"
  - "moving quotes san diego"
  - "best movers san diego"
  - "[city] moving estimate" (negative match: "free")
- 📣 Daily budget: $8/day. Single ad group. Max-clicks bidding to gather data fast.
- 📣 Use ad copy from `04_AD_COPY.md` Variant A. Two ads minimum.
- ✅ End of day: Campaign live, $8 deployed.

### Day 9 (Saturday)
- 📣 Mirror campaign for cleaning: "Cleaning Quotes — San Diego". $8/day. Same structure.
- 🌱 Reddit: 5th day of helpful comments. STILL no EvenQuote mention.
- 📊 Check GA4 → did the test impression yesterday show up? Fix attribution if not.
- ✅ End of day: Both verticals running paid traffic.

### Day 10 (Sunday)
- 📊 Review Day 8–9 Google Ads data. Two metrics: CTR and impression share. If CTR < 3%, your ad copy is wrong → swap to Variant B from `04_AD_COPY.md`.
- 📣 Add 2 negative keywords from impression report (likely: "free", "jobs", "near me cheap" if junk traffic).
- ✅ End of day: First 24h of campaign analyzed.

### Day 11 (Monday)
- 📣 Build Meta retargeting campaign. Custom audiences:
  - "Visited evenquote.com last 30 days, didn't convert"
  - "Touched intake form, didn't pay"
- 📣 Daily budget $3/day across both. Single Reels-format video (quick screencast of intake → email arriving).
- ✅ End of day: Retargeting live.

### Day 12 (Tuesday)
- 🌱 Reddit Day 8 — first product mention. Find a thread where someone explicitly says "I wish there was a way to compare moving quotes without getting spammed" or similar. Reply with FULL disclosure: "I built exactly this — happy to send you a free comparison if useful, link in bio." Tag for transparency.
- 📝 Write blog post #1: "Moving company quote scams: how to spot them in 5 minutes". Post to `/blog/moving-quote-scams`. Submit to Search Console for indexing.
- ✅ End of day: First content asset live.

### Day 13 (Wednesday)
- 🤝 Email outreach: 5 local SD apartment leasing offices. Pitch: "We're a free service that helps your incoming residents get moving quotes — want a flyer/QR for your move-in packet?" Use template in `07_PARTNERSHIP_PITCHES.md`.
- 📊 Daily check: spend, requests, CAC by channel.
- ✅ End of day: 5 partnership emails out.

### Day 14 (Thursday)
- 📣 Reddit Ads test: $5/day on r/movingout (geo: California). Use ad copy `04_AD_COPY.md` Reddit Variant.
- 📊 End-of-week-2 review: total spend, total requests, CAC blended + by channel, refund rate.
- 🌱 Reply to comments on the post you made Day 12. Be helpful, no hard-selling.
- ✅ End of week 2: First paid acquisition data in the books.

---

## Week 3 — Cut losers, scale winners

### Day 15 (Friday)
- 📊 Channel decision day. For each channel, compute:
  - CAC = spend ÷ paid requests
  - Quality = refund rate of those requests
  - Promise = trajectory (improving or flat?)
- 📣 Kill bottom channel. Take that budget and add it to top channel. (No mercy. Solo founders cannot afford "let's give it another week".)
- ✅ End of day: Budget reallocated.

### Day 16 (Saturday)
- 📝 Write blog post #2: "What does a 2-bedroom move actually cost in San Diego in 2026?" Embed live data from your Vapi calls (anonymized averages). Schema.org Article markup.
- 🌱 Comment on 2 more Reddit threads. Mention EvenQuote when asked, not before.
- ✅ End of day: Second SEO asset live.

### Day 17 (Sunday)
- 🛠 Programmatic SEO page: `/get-quotes/moving/los-angeles` (just LA for now — second-largest moving market in CA). Same template as San Diego page, swap city in title/meta/H1.
- 📣 Expand Google Ads geo to include LA on the moving campaign. Same daily budget — let Google distribute.
- ✅ End of day: 2 cities live.

### Day 18 (Monday)
- 🤝 Follow up with the 5 leasing offices from Day 13. Polite second-touch.
- 📞 Operations: Listen to 5 actual Vapi call recordings end-to-end. What's working in the calls? What's awkward? Document in `docs/vapi-call-quality-notes.md`.
- ✅ End of day: First-hand quality check done.

### Day 19 (Tuesday)
- 📝 Blog post #3: "10 questions to ask a mover before you book". Schema.org Article. Link from intake page.
- 🌱 Cross-post Day 16 blog to r/SanDiego with title "Made a free guide on what 2-bdrm moves actually cost here" — value-first, mention EvenQuote in passing only if relevant.
- ✅ End of day: Third asset live, distribution test running.

### Day 20 (Wednesday)
- 🛠 Add Google Reviews / Trustpilot embed to /pricing page (if you have ≥3 reviews, ask the 3 testimonial customers to drop them).
- 📊 Mid-week check: paid spend pacing, refund rate, top-of-funnel volume.
- ✅ End of day: Trust widget live.

### Day 21 (Thursday)
- 📣 If Reddit Ads is winning: bump to $8/day on r/movingout, add r/CleaningTips at $5/day.
- 📣 If Reddit Ads is losing: kill it, redirect that $5/day into Google Ads on the best-performing keyword cluster.
- 📊 Week 3 review. CAC trend? Refund trend? Repeat customer detected yet?
- ✅ End of week 3: $250-ish spent. CAC delta from week 2 should be visible.

---

## Week 4 — Launch story + lock-in

### Day 22 (Friday)
- 📝 Write your ProductHunt launch post. Hook: "I built EvenQuote — a $9.99 AI concierge that calls movers and cleaners for you so you don't have to". Include 3 testimonials, GIF of the experience, the founder story.
- 📝 Schedule for Tuesday Day 26 launch (PH traffic peaks Tuesday/Wednesday US morning).
- ✅ End of day: PH launch ready.

### Day 23 (Saturday)
- 🤝 Cold outreach to 1 local SD outlet (Voice of San Diego, Times of SD): "Solo SD founder ships AI tool to fix the home-services nightmare". Personal, not press-release-y. Use template in `07_PARTNERSHIP_PITCHES.md`.
- 📝 BetaList submission. Free.
- 🌱 Indie Hackers post: "I'm building EvenQuote — month 1 numbers". Transparent metrics build credibility.
- ✅ End of day: 3 distribution shots queued/sent.

### Day 24 (Sunday)
- 📝 Blog post #4: "The complete move-out cleaning checklist landlords actually use". Targets renter-deposit-recovery search intent. Schema.org Article + Checklist.
- 🛠 Add the checklist as a downloadable PDF lead magnet on the cleaning intake page. (Email gate — feeds your win-back list.)
- ✅ End of day: First lead magnet live.

### Day 25 (Monday)
- 📊 Pre-launch metrics snapshot. Week 4 baseline.
- 🤝 Email your 3 testimonial customers — ask them to upvote on PH tomorrow morning.
- 🌱 Schedule a Twitter/X thread for PH launch morning (if you use Twitter): "Today I'm launching EvenQuote — here's the story behind it". 7-tweet thread.
- ✅ End of day: PH ready to fire.

### Day 26 (Tuesday) — LAUNCH DAY
- 📣 Pause Google Ads for 24h (you'll get free traffic, don't waste paid clicks)
- 📝 ProductHunt: post live at 12:01 AM PT. Reply to every comment same day.
- 📝 Indie Hackers: launch post live by 9 AM ET.
- 🌱 Twitter thread live, 9 AM ET.
- 🌱 Reply to anyone who tries the product on launch day within 1 hour.
- 📞 Be on call all day for any product issues — launch day failures are unforgiving.
- ✅ End of day: Real launch in the books.

### Day 27 (Wednesday)
- 📞 Email every Day-26 customer personally (not auto-mailer): "thanks, here's my real email if anything broke". Founder touch wins reviews.
- 📣 Re-enable Google Ads. Add new campaign targeting branded searches ("evenquote") — spike will be coming.
- 📊 Capture launch-day numbers separately so you can model "lift from launch" vs "BAU".
- ✅ End of day: Launch wave converted into recurring traffic.

### Day 28 (Thursday)
- 📊 Day 28 audit: cumulative spend, cumulative paid requests, blended CAC, refund rate, completion rate, NPS-proxy from email survey.
- 📝 Write a "Lessons from Month 1" blog/Indie Hackers post. Transparent. Numbers. People love this and it backlinks.
- ✅ End of day: Month-end transparency post drafted.

### Day 29 (Friday)
- 🛠 Based on Day 28 numbers, decide:
  - Does the unit economics work? → continue current plan, scale spend to $750/mo for month 2
  - Does it not work? → pause paid, talk to 10 customers, revisit pricing, defer to month 3 plan
- 📊 Update the marketing dashboard with month-end metrics.
- 📝 Write `marketing/MONTH_1_RETROSPECTIVE.md` — what worked, what didn't, what month 2 looks like.
- ✅ End of day: Decision committed.

### Day 30 (Saturday)
- Rest. Take a full day off. You earned it.
- Wake up Sunday. Open the dashboard. Start month 2.

---

## What success looks like at Day 30

- 60–120 paid quote requests delivered
- Blended CAC under $15 (under $8 if you're killing it)
- Refund rate under 12%
- 3+ on-site testimonials
- 4 indexed blog posts
- 2 cities of programmatic SEO pages live
- ProductHunt launch in the rearview with at least 50 upvotes
- Clear answer to: "Should I scale month 2?"

## What "trouble" looks like at Day 30

- Spend is up but paid requests aren't moving → ad copy/landing-page mismatch, fix copy first
- Paid requests up but refund rate >15% → product/Vapi failure rate, stop scaling, fix product
- CAC stuck above $25 with no improvement → channel-mix is wrong OR price is too low; test $14.99 next month

---

## What goes in the dashboard each day

(See the live HTML dashboard artifact — same fields)

- Date
- Channel: Google / Meta / Reddit / Organic / Direct
- Spend ($)
- Visits
- Quote requests started
- Quote requests paid
- Refunds issued
- One-line note (anything notable)

That's it. Don't over-instrument month one.
