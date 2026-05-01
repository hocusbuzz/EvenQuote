# EvenQuote Improvement Backlog

Generated 2026-04-30 after the launch-week shipping sprint. Priorities
ordered by ROI (impact ÷ effort), not size. Each spec is structured
enough to drop straight into a planning session — DB changes, files
to touch, test plan, acceptance criteria.

Tier 1 = this week. Tier 2 = next week. Tier 3 = strategic, slow burn.

---

## Tier 0 — Highest leverage of all (vertical expansion)

### #0 — Ship pending categories + add high-fit new ones

**Goal.** Two parallel tracks:

  (a) Finish the verticals the public FAQ already promises ("handymen
      and lawn care are rolling out next").
  (b) Add NEW verticals scored on two axes — AI dialing fit (can a
      structured phone conversation produce a real quote?) and market
      demand for hard-to-find quotes (no transparent online pricing,
      phone-driven local industry).

**Why this is Tier 0.** Every other improvement compounds on the
existing 2 categories (moving + cleaning). Adding a vertical multiplies
the addressable market without multiplying the engineering surface —
intake schema + assistant prompt tweaks + Places-category seed
config. Plus it compounds with #8 (programmatic SEO): 200 city pages
× 4 verticals = 800 pages; 200 × 8 = 1,600.

**Effort.** ~1-2 days per vertical end-to-end (schema + form + AI
prompt + Places seeding). 8 verticals on this list ≈ 12-15 days
spread over weeks.

---

#### A. Already promised — ship FIRST (Tier 0a)

These are public commitments. Customers reading the FAQ are expecting
them. Ship before any new vertical to avoid shipping breadth before
depth.

**A1. Handyman** — rolling out per FAQ.
- AI fit: **A**. Pricing varies hugely by job type ($60 mount-TV vs
  $400 install-faucet vs $1500 drywall-repair).
- Hard-to-find: **A**. No published rates, depends entirely on the
  task.
- Schema: task category (mount/hang/install/repair/assemble), room,
  estimated hours, materials needed (Y/N).
- Risks: too many sub-types if not categorized — consider 6-8 task
  buckets in v1, expand later.

**A2. Lawn care** — rolling out per FAQ.
- AI fit: **A**. Schema-friendly: lawn size bucket, one-time vs
  recurring, services (mow / edge / fertilize / weed / leaf).
- Hard-to-find: **B+**. Some price calculators online, but recurring
  packages vary 2-3x.
- Schema: lawn size (sqft buckets), service mix, frequency.
- Risks: recurring is a different sale than one-time — start with
  one-time mow + cleanup, add recurring later.

---

#### B. New high-fit verticals — add NEXT (Tier 0b)

Scored A+ on AI fit + opaque pricing. These are the "no-brainer"
expansions after the promised four are live.

**B1. Junk removal / haul-away** — top new pick.
- AI fit: **A+**. Volume bucket + heavy-item Y/N → ballpark in 4
  questions.
- Hard-to-find: **A+**. $75-$1,500 per load variance, almost no
  transparent online pricing. Customers stressed (clearing parent's
  house, post-renovation).
- Schema: volume (couch / pickup-truck / 1/2-truck / full-truck /
  multi-truck), heavy items (piano / hot-tub / appliances), pickup
  vs same-day, where to drop (curb vs interior).
- Phone culture: high — owner-operated franchises (1-800-Got-Junk
  copycats).
- Notable: this is the single highest-conviction add. Massive demand
  + massive variance + zero pricing transparency.

**B2. Tree services / arborists** — high stress, urgent demand.
- AI fit: **A**. Tree height + species + proximity to structure +
  trim vs remove → quote.
- Hard-to-find: **A+**. $200-$5,000+ variance per tree. License-
  required so big franchises don't dominate; independent local pros.
  Storm-driven urgency means customers desperate for fast quotes.
- Schema: trim/prune/remove/stump, tree height bucket, species
  approx, proximity to house/power lines (Y/N).
- Notable: seasonal spike post-storm means concentrated demand
  windows where speed-to-quote is everything. Excellent fit for AI
  dialing 5 in parallel.

**B3. Pest control (ONE-TIME)** — careful scoping.
- AI fit: **A**. Customer describes what they're seeing.
- Hard-to-find: **A**. One-time treatments aren't published; ongoing
  contracts are. Important: scope to one-time only — recurring pest
  control has well-known monthly rates and won't differentiate.
- Schema: pest type (ants / roaches / rodents / wasps / bedbugs /
  other), severity (one-room / multiple / whole-house), interior vs
  exterior, follow-ups Y/N.
- Notable: keep recurring out of v1 explicitly.

---

#### C. Adjacent expansions — when bandwidth allows (Tier 0c)

Smaller TAM but very low marginal effort because they're adjacent to
existing cleaning vertical.

**C1. Pressure washing / power washing**
- AI fit: **A**. Surface-area-based.
- Schema: surface type (driveway / siding / deck / fence), rough
  square footage, single vs multiple surfaces.

**C2. Carpet cleaning** — adjacent to cleaning.
- AI fit: **A**. Per-room pricing model.
- Schema: rooms (count by size), pet stains Y/N, deep clean vs
  refresh.

**C3. Window cleaning** — adjacent to cleaning.
- AI fit: **A**. Per-window or per-story.
- Schema: stories (1/2/3+), window count bucket, interior +
  exterior.

**C4. Gutter cleaning** — seasonal.
- AI fit: **A**. House size + stories → quote.
- Schema: stories, linear feet bucket (estimated from "3-bed
  ranch / 4-bed colonial" mapping).
- Notable: peak demand in fall — schedule launch to land late
  August.

---

#### D. Stretch / explore later

Higher complexity but real demand. Not v1.

- **Garage door repair** — variable parts; tier-based pricing works.
- **Appliance repair** — diagnosis fee + parts. Quote = visit fee
  (most companies have a flat trip charge).
- **HVAC tune-up** (NOT install) — flat-rate seasonal service.
- **Locksmith** (non-emergency rekey/install) — emergency dispatch
  is a different model; routine work is phone-quotable.
- **Auto detailing** (mobile or shop) — package-priced.

---

#### E. Explicitly skip — bad AI fit

Don't waste cycles on these even if asked.

- **Roofing** — requires drone/ladder inspection.
- **Auto mechanics** — must see the car.
- **Big plumbing / HVAC install** — site visit required.
- **Wedding photography / videography** — artistic gut-feel pricing.
- **Lawyers / accountants / doctors / dentists** — insurance and
  regulation make pricing meaningless to compare.
- **Solar install** — sales-cycle dominant.
- **Real estate agents** — commission-based, regulated.
- **Mortgage / insurance** — KYC + regulated.

---

#### Implementation pattern (per new vertical)

Each new vertical follows the same template — already proven on
moving + cleaning:

1. **Intake schema** — `lib/forms/<vertical>-intake.ts` with Zod
   primitives mirroring moving/cleaning shape.
2. **Form steps component** — `components/get-quotes/<vertical>-steps.tsx`
   reusing the form-shell.
3. **Seed entry** — `supabase/seed/0002_multi_vertical_categories.sql`
   adds the new category row with `intake_form_schema` JSONB matching
   the Zod schema.
4. **Assistant prompt fragment** — vertical-specific section in the
   Vapi system prompt (or a vertical-specific assistant if
   complexity warrants).
5. **Places category mapping** — `lib/ingest/seed-on-demand.ts` maps
   the vertical to a Google Places `includedTypes` set (e.g.,
   "moving_company" for moving, "house_cleaning_service" for
   cleaning, "tree_service" for trees).
6. **Email + report templates** — share with existing verticals via
   the `category` join in `send-reports.ts`.
7. **Landing page** — vertical-specific hero / copy at
   `/get-quotes/<vertical>` (lib already supports this).

**Acceptance criteria per vertical.**
- [ ] Intake schema covers 90% of typical quote variance
- [ ] Vapi prompt yields structured pricing in test calls
- [ ] Google Places returns ≥10 businesses per major metro for the
      vertical
- [ ] End-to-end smoke test: paid → 5 calls dispatched → ≥3 quotes
      extracted → report email renders cleanly

---

## Tier 1 — This week (after Tier 0a — handyman + lawn care done)

### #1 — Vapi call-state reconciler cron

**Goal.** Eliminate data loss from dropped end-of-call webhooks
(exactly the failure mode that stranded `ca630790`'s 10 calls during
the auth-bug window).

**Why now.** You just lost call data once. The fix is cheap and the
next loss is worse — at scale, a single deploy + a flaky webhook hour
could lose 50+ calls. This is the antifragility move.

**Effort.** ~1 day.

**DB changes.** None.

**Files to create / modify.**

- `lib/cron/reconcile-calls.ts` (new) — finds stuck `calls` rows and
  pulls fresh state from Vapi.
- `lib/calls/vapi.ts` — add `getVapiCall(callId)` wrapper around
  Vapi's `GET /call/{id}`.
- `app/api/cron/reconcile-calls/route.ts` (new) — thin HTTP wrapper.
- `supabase/migrations/0015_pg_cron_reconcile_calls.sql` (new) — pg_cron
  schedule entry, every 30 min.

**Public surface.** None. Internal cron only.

**Algorithm.**

1. SELECT calls WHERE `vapi_call_id IS NOT NULL AND ended_at IS NULL
   AND status IN ('queued','in_progress') AND created_at < NOW() - INTERVAL '30 minutes'`
   LIMIT 50.
2. For each: GET `/call/{vapi_call_id}` from Vapi.
3. If Vapi reports the call ended (`endedReason` present), re-emit
   the same payload to our existing webhook handler internally — or
   call `apply_call_end` RPC directly with the reconstructed fields.
4. If Vapi says the call is still in-progress at >30min, that's
   abnormal — log + Sentry, leave the row alone.

**Test plan.**
- Unit: mock Vapi GET response shapes (ended-with-transcript,
  ended-no-answer, still-active, 404-not-found).
- Integration: insert a stuck row, run the cron, assert `ended_at`
  populated + `apply_call_end` side-effects (status flip on parent
  request).
- Manual: artificially break the webhook auth in staging, dispatch
  one call, wait 30 min, confirm reconciler closes the loop.

**Acceptance criteria.**
- [ ] Cron runs every 30 min via pg_cron.
- [ ] Stuck rows >30 min old get reconciled within one tick.
- [ ] Reconciled rows are indistinguishable from webhook-delivered ones
      (same `apply_call_end` path).
- [ ] No double-processing if the webhook arrives mid-reconcile (claim
      via vapi_call_id unique index).

**Risks.** Vapi rate limits on the bulk GET path — keep batch size
≤50 and add a `Retry-After` honoring delay.

---

### #2 — One-click admin actions

**Goal.** Cut customer-failure recovery time from 20 minutes (SQL +
cron-tick waiting) to 1 minute (button + immediate effect).

**Why now.** You handled `ca630790` manually today. The next stuck
row will be when you're at dinner, not at your desk. Support
operations need a paved path.

**Effort.** ~1.5 days for all four buttons.

**DB changes.** None — actions reuse existing primitives.

**Files to create / modify.**

- `app/admin/requests/[id]/actions.tsx` (new client component) — 4
  buttons with confirm dialogs.
- `lib/actions/admin-request.ts` (new) — server actions:
  - `refundRequestNow(id)` → calls Stripe refunds.create + updates
    payments.status + stamps quote_request.report_data.
  - `replayExtractor(id)` → re-runs the AI extractor on existing
    transcripts.
  - `markFailed(id)` → status='failed', surfaces to send-reports
    refund path.
  - `resendReportEmail(id)` → re-fires the Resend send for an already-
    generated report.
- `app/admin/requests/[id]/page.tsx` — wire the actions component.

**Public surface.** Authenticated admin-only. Existing admin guard.

**Test plan.**
- Unit: each server action covers happy path + idempotency (calling
  twice on a refunded row is a no-op, not a double refund).
- Integration: full lifecycle on a seeded request (paid → mark failed
  → refund fires → email resends).
- Manual: spike a fresh test request, click each button, assert DB
  state.

**Acceptance criteria.**
- [ ] Each action is idempotent — clicking twice doesn't double-act.
- [ ] All actions log + Sentry-tag with the actor's user_id (admin
      audit trail).
- [ ] Confirm dialogs on destructive actions (refund, mark failed).
- [ ] Visible success/error toast after each action.

**Risks.** Stripe API key permissions — confirm refunds.create works
with the live key in prod (it should; verified in #110).

---

### #3 — Smart same-number retry spacing

**Goal.** Stop calling the same contractor's number twice within a
few minutes. That reads as spam and damages supply-side trust.

**Why now.** Cheapest contractor-goodwill win available. 3-hour
patch, immediate effect.

**Effort.** ~3 hours.

**DB changes.** None.

**Files to create / modify.**

- `lib/cron/retry-unreached.ts` — add a min-spacing filter:
  ```sql
  WHERE NOT EXISTS (
    SELECT 1 FROM calls c2
    WHERE c2.business_id = c.business_id
      AND c2.quote_request_id = c.quote_request_id
      AND c2.created_at > NOW() - INTERVAL '30 minutes'
  )
  ```
- `lib/cron/retry-unreached.test.ts` — add test covering the spacing.

**Public surface.** None.

**Test plan.**
- Unit: row created 5 min ago is excluded; row created 31 min ago is
  included.
- Edge case: same business across DIFFERENT quote_requests still
  retries normally (the filter is per-request).

**Acceptance criteria.**
- [ ] Same business + same request: ≥30 min between dial attempts.
- [ ] Same business + different request: no spacing constraint.
- [ ] Existing retry-unreached behavior preserved for first attempts.

**Risks.** Slower convergence on quote collection in edge cases —
acceptable trade-off vs. spam reputation.

---

### #4 — Real-time dashboard via Supabase Realtime

**Goal.** Replace the static "in motion" dashboard with live status:
"Acme Movers: ringing…" → "Acme Movers: $1,180 received". Pizza-
tracker UX during the 60-90 min wait.

**Why now.** First-week customers form recommend/no-recommend opinions
during this exact silence window. This is the single biggest delight
lever.

**Effort.** ~1 day.

**DB changes.** Enable Realtime on `quote_requests` and `calls`
tables (Supabase dashboard toggle, no migration).

**Files to create / modify.**

- `app/dashboard/requests/[id]/page.tsx` — pass initial state.
- `app/dashboard/requests/[id]/live-status.tsx` (new client
  component) — subscribes to:
  - `quote_requests:id=eq.<id>` — for status / counters.
  - `calls:quote_request_id=eq.<id>` — for per-call updates.
  Renders a list of calls with live status badges.

**Public surface.** No new routes; same /dashboard URL gets richer.

**Test plan.**
- Unit: not really applicable; this is a client-side subscription.
- Integration: vitest browser mode (or Playwright) — subscribe, mock
  channel events, assert UI updates.
- Manual: open dashboard during a real call dispatch, verify status
  ticks live as Vapi webhook lands.

**Acceptance criteria.**
- [ ] Status badge per call updates within 2s of webhook landing.
- [ ] Counters (calls made / quotes collected) update live.
- [ ] Graceful fallback: if Realtime channel disconnects, fall back
      to a 10s polling SWR.
- [ ] No duplicate renders / memory leaks (cleanup useEffect).

**Risks.** Supabase Realtime has connection limits on the free tier
(200 concurrent). At your current scale, fine. Plan to upgrade if
concurrent dashboards exceed that.

---

## Tier 2 — Next week

### #5 — Cohort + funnel admin dashboard

**Goal.** Operate the business by metric, not by SQL inspection.
Daily/weekly funnel: paid → started calling → ≥3 quotes → report
sent → refunded.

**Why now.** You'll miss early signal (refund-rate spikes, low quote
yield in a vertical) until they're catastrophes. Once volume is >5
requests/day, you NEED this.

**Effort.** ~1.5 days.

**DB changes.**

- New view `admin_daily_cohort` — materialized, refreshed nightly:
  ```sql
  SELECT date_trunc('day', created_at) AS day,
         category_id,
         count(*) AS paid,
         count(*) FILTER (WHERE total_calls_made > 0) AS started,
         count(*) FILTER (WHERE total_quotes_collected >= 3) AS three_plus,
         count(*) FILTER (WHERE report_sent_at IS NOT NULL) AS reported,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p
            WHERE p.quote_request_id = qr.id AND p.status = 'refunded')) AS refunded
  FROM quote_requests qr
  GROUP BY day, category_id;
  ```
- pg_cron entry to refresh the materialized view nightly at 2 AM UTC.

**Files to create / modify.**

- `app/admin/page.tsx` — replace current row list with tile dashboard.
- `app/admin/requests/page.tsx` — keep, but link from the dashboard.
- `lib/admin/cohort.ts` (new) — read the view, shape data for charts.
- Use Chart.js (already in artifacts dependency list) for line + bar.

**Public surface.** Admin only.

**Test plan.**
- Unit: the cohort SQL view shape on seeded data.
- Manual: spike 5 requests at varying stages, view dashboard, verify
  counts.

**Acceptance criteria.**
- [ ] Tiles for: this week, this month, all time.
- [ ] Per-vertical breakdown.
- [ ] Refund rate prominent (it's the leading indicator of trouble).
- [ ] Median pipeline time (paid → report_sent_at).
- [ ] One-click drill-down into the underlying request rows.

**Risks.** Materialized view refresh during heavy admin activity —
keep it 2 AM UTC and `CONCURRENTLY` if needed.

---

### #6 — Mobile audit + redesign of intake forms

**Goal.** Make the cleaning + moving intake forms genuinely usable on
375px viewports (iPhone SE / 13 mini).

**Why now.** ~70% of "[city] movers" Google searches are mobile. If
the form is hostile on phone you lose half of TOFU before checkout.
You haven't seen real bounce data yet because you JUST launched.

**Effort.** ~2-3 days.

**DB changes.** None.

**Files to create / modify.**

- `components/get-quotes/cleaning-steps.tsx` — pass-through audit:
  larger tap targets, single-column on small screens, persistent
  progress bar, sticky CTA.
- `components/get-quotes/moving-steps.tsx` — same pass.
- `components/get-quotes/form-shell.tsx` — sticky header that
  shrinks on scroll.
- `components/get-quotes/address-autocomplete.tsx` — full-screen
  modal on mobile (Google Maps app pattern).

**Public surface.** Same routes, better UX.

**Test plan.**
- Manual: walkthrough at 375 / 414 / 768 widths.
- Lighthouse mobile audit — target >85 perf, 100 a11y.
- Real-device check: iPhone SE, iPhone 14, Pixel 7.

**Acceptance criteria.**
- [ ] No horizontal scroll at any width ≥320px.
- [ ] All tap targets ≥44×44px.
- [ ] Progress indicator visible without scrolling on every step.
- [ ] Address autocomplete usable one-handed.

**Risks.** Neobrutalist border styling may need rethinking at small
sizes (the 6px shadow eats screen real estate). Be willing to soften
brand on mobile.

---

### #7 — Per-business quality scoring + auto-deactivate

**Goal.** Stop wasting money calling dead numbers and voicemail
loops. Selector deprioritizes / auto-skips low-quality businesses.

**Why now.** Each wasted call is ~$0.30. At 100 requests/day × 5
calls × even 10% bad numbers = $15/day = $450/month burned with no
customer benefit. Compounds with growth.

**Effort.** ~1.5 days.

**DB changes.**

- New materialized view `business_health`:
  ```sql
  SELECT b.id,
         count(c.*) AS total_calls,
         count(c.*) FILTER (WHERE c.status = 'completed' AND c.duration_seconds > 30) AS pickups,
         count(c.*) FILTER (WHERE c.extracted_data->>'price_low' IS NOT NULL) AS quotes,
         max(c.created_at) AS last_called_at
  FROM businesses b
  LEFT JOIN calls c ON c.business_id = b.id
  WHERE c.created_at > NOW() - INTERVAL '60 days'
  GROUP BY b.id;
  ```
- pg_cron nightly refresh.
- New `businesses.quality_tier` enum column ('healthy', 'low',
  'inactive') populated by the view.

**Files to create / modify.**

- `lib/calls/select-businesses.ts` — selector tier:
  - prefer `quality_tier = 'healthy'`
  - allow `quality_tier = 'low'` only if healthy pool < target
  - skip `quality_tier = 'inactive'` entirely
- `app/admin/businesses/page.tsx` — new column for quality_tier with
  filtering.

**Public surface.** None.

**Test plan.**
- Unit: selector with seeded businesses at each tier.
- Integration: a request in a zip with mostly inactive businesses
  falls through to neighboring zips correctly.

**Acceptance criteria.**
- [ ] Selector never picks `inactive` businesses.
- [ ] Refresh job runs nightly without breaking on 0-call businesses.
- [ ] Admin can manually override tier (notes column for reason).

**Risks.** Cold-start: new businesses have 0 calls and no health
score. Treat unscored as `healthy` by default to avoid biasing
against new ingest.

---

## Tier 3 — Strategic (slow burn, queue when Tier 1/2 done)

### #8 — Programmatic vertical+city SEO pages

**Goal.** Cheapest customer acquisition channel for a marketplace
adjacent product. Generate ~50 cities × 4 verticals = 200 long-tail
pages indexed organically.

**Why now.** Google takes 4-8 weeks to surface new content. Ship
NOW so traffic lands when handyman + lawn care verticals are also
live (they're rolling out next).

**Effort.** ~2 days.

**DB changes.** None — pages are static-ish, generated at build.

**Files to create / modify.**

- `data/cities.json` — top ~50 US cities with population + state +
  metro descriptor.
- `app/(marketing)/[vertical]/[city]/page.tsx` — new dynamic route.
- `app/sitemap.ts` — add the 200 generated URLs.
- Component: vertical-aware hero + "we've called X movers in San
  Diego" social proof line + local form CTA.

**Public surface.** `/movers/san-diego`, `/cleaners/austin`, etc.

**Test plan.**
- Build-time: ensure the dynamic route generates all 200 pages
  without errors.
- Manual: 5 spot-checks for content uniqueness (Google penalizes
  doorway pages).
- Lighthouse SEO audit on a sample page.

**Acceptance criteria.**
- [ ] 200 pages indexed in sitemap.xml.
- [ ] Each page has unique H1, meta description, and structured data
      (LocalBusiness or Service schema).
- [ ] No duplicate content warnings in Search Console after 2 weeks.
- [ ] First-form-fill conversion rate from these pages comparable to
      direct traffic.

**Risks.** Google may treat as doorway pages if content is too
templated. Mitigation: include vertical-specific local insights
("San Diego moves cluster in May-Sept" — even simple facts help).

---

### #9 — Social proof + cost transparency block

**Goal.** Add testimonials + "where your $9.99 goes" sections to the
landing page. Conversion rate is the cheapest lever; this hits it
without changing the offer.

**Why now.** Once you have ~10 real customers (you're days away),
their words are gold. Capture permission early.

**Effort.** ~1 day for the components. Slower part is asking
customers for permission.

**DB changes.** None — testimonials are content, not data.

**Files to create / modify.**

- `components/site/testimonials.tsx` (new) — 3-card section, each:
  quote + first name + city + vertical.
- `components/site/cost-breakdown.tsx` (new) — pie chart breaking
  down where the $9.99 goes (use Chart.js or a static SVG).
- `app/page.tsx` — insert both sections after Pricing.

**Public surface.** Landing page only.

**Test plan.**
- Visual: each section renders cleanly across breakpoints.
- A/B test (optional): split traffic 50/50 with/without and measure
  paid conversion lift over 2 weeks.

**Acceptance criteria.**
- [ ] 3 real testimonials with first name + city.
- [ ] Cost breakdown reads as honest, not defensive.
- [ ] Both blocks render brand-aligned (lime accent, neobrutalist
      borders).

**Risks.** Bad testimonials are worse than no testimonials. Insist
on real customer permission, not "made up plausibly".

---

### #10 — PDF export of quote report

**Goal.** Sharable quote report. Customers want to print, screenshot,
or text the report to a partner / parent / roommate.

**Why now.** Lowest urgency on this list — pure delight, no
acquisition or retention emergency. Worth doing in a slow week.

**Effort.** ~1 day.

**DB changes.** None.

**Files to create / modify.**

- `app/dashboard/requests/[id]/download-pdf/route.ts` (new) — server
  route returns a PDF blob.
- `lib/pdf/render-report.tsx` (new) — uses `@react-pdf/renderer` to
  render the same data the email template uses.
- `app/dashboard/requests/[id]/page.tsx` — add "Download PDF" button.

**Public surface.** Authenticated route — only the request owner.

**Test plan.**
- Unit: render a known input → assert PDF byte length non-zero +
  contains expected text via pdf-parse.
- Manual: download from dashboard, open in Preview, screenshot OK.

**Acceptance criteria.**
- [ ] PDF renders identical content to email report.
- [ ] Brand-aligned (uses the same lime accent + display font).
- [ ] Owner-only access (RLS or session check).
- [ ] Filename uses request ID prefix for findability.

**Risks.** `@react-pdf/renderer` adds ~200KB to the route bundle —
keep it on a server-only route to avoid client bloat.

---

## Quick reference — order, effort, surface

| # | Title | Tier | Effort | Surface |
|---|-------|------|--------|---------|
| 0a-1 | Handyman vertical (promised) | 0a | 1-2d | Vertical |
| 0a-2 | Lawn care vertical (promised) | 0a | 1-2d | Vertical |
| 0b-1 | Junk removal vertical (top new pick) | 0b | 1-2d | Vertical |
| 0b-2 | Tree services vertical | 0b | 1-2d | Vertical |
| 0b-3 | Pest control (one-time) | 0b | 1-2d | Vertical |
| 1 | Vapi reconciler cron | 1 | 1d | Backend |
| 2 | One-click admin actions | 1 | 1.5d | Admin |
| 3 | Smart retry spacing | 1 | 3h | Backend |
| 4 | Real-time dashboard | 1 | 1d | Frontend |
| 5 | Cohort dashboard | 2 | 1.5d | Admin |
| 6 | Mobile intake audit | 2 | 2-3d | Frontend |
| 7 | Business quality scoring | 2 | 1.5d | Backend |
| 0c | Pressure / carpet / window / gutter | 2-3 | 1d ea. | Vertical |
| 8 | Programmatic SEO pages | 3 | 2d | Website |
| 9 | Social proof + cost block | 3 | 1d | Website |
| 10 | PDF report export | 3 | 1d | Frontend |

**Tier 0a total**: ~3-4 days. Ships handyman + lawn care — closes
the public FAQ promise.

**Tier 0b total**: ~3-6 days for the three top new picks (junk
removal, tree services, pest control one-time).

**Tier 1 total**: ~3.5 days of focused work — pairs naturally with
Tier 0 since most of Tier 1 strengthens infrastructure that all
verticals share.

**Tier 2 total**: ~5 days of focused work.

**Tier 3 total**: ~4 days, but slower due to dependencies (real
customer testimonials, SEO bake time).

Grand total with verticals: ~25-30 days of solo founder focused
work to clear everything including 5 new verticals (4 promised + 5
new = 9 total) and all 10 platform improvements. Realistic calendar
window: 6-8 weeks if interleaved with acquisition / customer support
/ fires.

**Sequencing recommendation:** alternate Tier 0 (vertical) with
Tier 1 (platform) so you ship a new market roughly weekly while
also hardening reliability — single days of "all platform" or "all
vertical" lose context-switching efficiency for a solo founder.
