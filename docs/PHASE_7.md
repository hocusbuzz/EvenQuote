# Phase 7 — Reliability

Phase 6 shipped the happy path. Phase 7 hardens it against the four
known gaps named in `docs/PHASE_6.md`:

1. Race on the quote_request counter.
2. No retry on transient Vapi dispatch failures.
3. `businesses.call_success_rate` column existed but nothing wrote to it.
4. Geo selection was zip-exact with a state-wide fallback — nothing in
   between for customers in thin zips.

All four are closed. Everything is additive — no breaking changes to
existing tables, existing routes, or the public API.

## What shipped

### Schema (`supabase/migrations/0006_phase7_reliability.sql`)

- **`apply_call_end(p_request_id, p_quote_inserted)`** — plpgsql function
  that atomically increments `total_calls_completed`, optionally bumps
  `total_quotes_collected`, and flips `status → 'processing'` when the
  completed count catches the planned batch size. One UPDATE, one row
  lock, no race window. Returns the updated row for logging.

- **`calls.last_retry_at`** (timestamptz, nullable) — throttles the retry
  worker. Backed by partial index `calls_retry_candidate_idx` for the
  exact query the worker runs.

- **`recompute_business_success_rate(p_business_id, p_window)`** — after
  every end-of-call the webhook calls this to refresh the business's
  rolling score. Window defaults to 20 most-recent terminal calls;
  `completed` counts as success, `failed` / `no_answer` / `refused`
  count against.

- **`businesses_within_radius(category_id, lat, lng, radius_miles, limit)`**
  — haversine SQL function returning category-scoped active businesses
  within range of the given coordinate. No PostGIS. Ordered by distance
  then `call_success_rate` then `google_rating` then oldest-call-first.

### Webhook (`app/api/vapi/webhook/route.ts`)

Step 5 (counter bump) is now a single `rpc('apply_call_end', …)` call.
Added step 6 — a best-effort `rpc('recompute_business_success_rate', …)`.
A failure on step 6 is logged but doesn't fail the webhook, since a
Vapi retry of an event that already bumped the atomic counter would
double-count. Best-effort is the right call here.

### Retry worker (`app/api/cron/retry-failed-calls/route.ts`)

- Accepts GET (Vercel Cron) or POST (Supabase Scheduled Function). Auth
  via `CRON_SECRET` env — either `x-cron-secret` header or
  `Authorization: Bearer <secret>` (Vercel's default).
- Picks up `status='failed' AND started_at IS NULL AND retry_count < 3`
  within the last 24h, oldest retry first.
- Throttle: skips any row retried within the last 5 minutes.
- On successful re-dispatch: flips status back to `in_progress`, sets
  `vapi_call_id`, bumps `retry_count`, stamps `last_retry_at`.
- On failed re-dispatch: leaves status, bumps `retry_count`, stamps
  `last_retry_at`. After 3 strikes the row becomes permanent.
- Hard cap `MAX_PER_RUN = 25` per invocation so a single run stays
  within any serverless 60s window.

Why only dispatch-failed rows? A webhook-classified failure
(`endedReason` contained "twilio" or "error") means Vapi picked up,
dialed, got somewhere. Retrying those could re-annoy the business or
land on the same systemic issue. Dispatch-fail rows (`started_at IS
NULL`) clearly never reached the PSTN, so retrying is cheap and safe.

### Cron wiring (`vercel.json`)

- `/api/cron/retry-failed-calls` every 10 minutes. Change to `*/5` or
  `*/1` if you want tighter retry latency. Vercel Hobby caps cron at
  daily; the retry worker really needs minute-scale, so plan on a Pro
  deployment or wire it through Supabase Scheduled Functions instead.

### Selector (`lib/calls/select-businesses.ts`)

Three-tier fallback:

1. **Exact zip** — same logic as before, but ordering now blends
   `call_success_rate` (desc, nulls last) → `google_rating` →
   `last_called_at`.
2. **Radius** — NEW. Anchors to the lat/lng of any business already in
   the target zip (zip codes are small enough that any in-zip business
   is a fine centroid approximation for a 25-mile default). Calls
   `businesses_within_radius` RPC. Ordered by distance first, then the
   same quality tiebreakers.
3. **State** — last resort, same ordering as tier 1.

Each tier dedupes against the previous. If tier 1 returns K rows we
skip 2 and 3 entirely.

## How to wire the retry cron

### Option A: Vercel Cron (default)

Already wired via `vercel.json`. Set `CRON_SECRET` in the Vercel
project's env vars. Vercel Cron automatically includes
`Authorization: Bearer <CRON_SECRET>` on every invocation so the route
will auth correctly.

### Option B: Supabase Scheduled Function (pg_cron)

If you're on Supabase Pro, pg_cron can call the route via `http_post`:

```sql
select cron.schedule(
  'retry_failed_calls',
  '*/10 * * * *',
  $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/proxy/retry-failed-calls',
      headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
    );
  $$
);
```

Or point it directly at the Next.js deployment URL — the route accepts
either auth style.

## How to test locally

1. **Counter race test.** In parallel, fire two webhook POSTs for two
   different `vapi_call_id`s belonging to the same quote_request:

   ```bash
   curl -X POST http://localhost:3000/api/vapi/webhook \
     -H 'x-vapi-secret: <your-secret>' \
     -H 'Content-Type: application/json' \
     -d @fixtures/vapi-end-of-call-1.json &
   curl -X POST http://localhost:3000/api/vapi/webhook \
     -H 'x-vapi-secret: <your-secret>' \
     -H 'Content-Type: application/json' \
     -d @fixtures/vapi-end-of-call-2.json &
   wait
   ```

   `total_calls_completed` should end at 2 on the quote_request.
   Without the RPC this test used to flake to 1.

2. **Retry worker.** Seed a calls row:

   ```sql
   update calls
      set status='failed', started_at=null, retry_count=0, last_retry_at=null
    where id = '<some-uuid>';
   ```

   Then:

   ```bash
   curl -H 'x-cron-secret: <secret>' http://localhost:3000/api/cron/retry-failed-calls
   ```

   Expected JSON: `{ ok:true, retried:1, succeeded:1, failed:0, … }`.
   The row should now be `status='in_progress'` with `retry_count=1`,
   `last_retry_at` set, and a new `vapi_call_id` (`sim_*` in simulation
   mode).

3. **Success-rate scoring.** After running a batch that completes a
   mix of `completed` and `failed` calls for a single business, inspect
   `businesses.call_success_rate` on that row — it should match
   `count(status='completed') / count(terminal statuses)` over the
   most-recent 20 calls.

4. **Radius fallback.** Temporarily seed a zip with zero businesses in
   your category, but seed neighboring zips within 25 miles. Submit a
   quote request targeting the empty zip. Tier 1 returns 0, tier 2
   fills the batch from the neighbors, tier 3 never runs.

## Known gaps (for Phase 8 and later)

- **Dead letter queue.** After `retry_count=3`, a dispatch-failed row
  stays `failed` with no further retries. Ops has no surface to see
  these. Phase 8 adds an admin page that lists them.
- **Radius-tier fairness.** The 25-mile default is picked from thin
  air. We should revisit once we have metrics on "customer got fewer
  than K quotes" — if the rate is high, widen the radius or lower the
  batch size.
- **Success-rate cold start.** A brand-new business has
  `call_success_rate=null` and will be ranked just behind proven
  businesses. That's usually right, but in a thin zip it may keep
  starving new businesses from ever getting tested. Phase 8 could add
  an exploration budget (e.g. reserve one slot per batch for an
  unproven business).
- **No opt-in callback handoff.** Phase 8 is still the one that moves
  a customer's PII to a business after they've chosen a quote.
