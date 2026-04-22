# Phase 6 — Business ingest + call engine

Promotes the Phase 5 stub into a real call pipeline: a paid quote
request now selects live businesses, inserts `calls` rows, dispatches
via Vapi (or simulates if no Vapi creds), receives an end-of-call
webhook, persists the transcript, and extracts a structured quote.

## What shipped

```
supabase/
  migrations/0004_business_ingest.sql   # businesses.source, ingested_at, selector idx
lib/
  ingest/
    phone.ts                            # E.164 normalizer (NANP only for MVP)
    google-places.ts                    # Places v1 textSearch client
    upsert-businesses.ts                # dedupe on place_id, insert/update counts
  calls/
    select-businesses.ts                # top-K selector (category + zip/state)
    vapi.ts                             # outbound call + webhook verification
    extract-quote.ts                    # transcript → structured quote (Claude tool-use)
    engine.ts                           # runCallBatch: claim → select → insert → dispatch
  queue/
    enqueue-calls.ts                    # now a thin facade over engine.runCallBatch
scripts/
  ingest-businesses.ts                  # CLI: pnpm ingest:businesses -- --category moving --query ...
app/api/vapi/webhook/route.ts           # end-of-call handler
```

Also fixed: a latent bug where `enqueue-calls.ts` selected
`service_category_id` but the schema column is `category_id`. Would
have failed at runtime on the first real paid webhook.

## New env vars

All optional — the system degrades gracefully when any are missing:

| Var                           | Missing behavior                                   |
|-------------------------------|----------------------------------------------------|
| `GOOGLE_PLACES_API_KEY`       | Ingest script throws; app still runs.              |
| `VAPI_API_KEY`                | Engine runs in simulation mode.                    |
| `VAPI_ASSISTANT_ID`           | Engine runs in simulation mode.                    |
| `VAPI_PHONE_NUMBER_ID`        | Engine runs in simulation mode.                    |
| `VAPI_WEBHOOK_SECRET`         | Webhook accepts without verification (dev).        |
| `ANTHROPIC_API_KEY`           | Quote extraction skipped; call still completes.    |
| `ANTHROPIC_EXTRACTION_MODEL`  | Defaults to `claude-haiku-4-5-20251001`.           |
| `CALL_BATCH_SIZE`             | Defaults to 5.                                     |

## Apply the migration

```sh
# against your Supabase project:
psql "$SUPABASE_CONNECTION_URL" -f supabase/migrations/0004_business_ingest.sql
```

Idempotent — adds columns with `IF NOT EXISTS`, creates the index
conditionally.

## Seed some businesses

```sh
# search for 20 movers near 10001 and upsert into businesses
pnpm ingest:businesses -- --category moving --query "movers near 10001 New York NY"

# with geographic bias
pnpm ingest:businesses -- \
  --category moving \
  --query "movers" \
  --lat 40.7486 --lng -73.9864 --radius-miles 15

# see what would be written without touching the DB
pnpm ingest:businesses -- --category moving --query "movers in Brooklyn" --dry-run
```

The script normalizes phone numbers to E.164 (US-only for now), skips
rows without a callable phone or complete city/state/zip, and
distinguishes inserted vs updated in the final report.

## Simulation vs live calls

**Simulation mode** (no Vapi env): the engine still claims the batch,
picks businesses, inserts `calls` rows, and flips them to
`in_progress` with a fake `vapi_call_id` prefixed `sim_`. You'll see
logs like:

```
[vapi] simulated call to Acme Movers (+14155550100) — vapiCallId=sim_8f3a...
```

This lets you run the full Stripe → webhook → engine → DB flow locally
without burning Vapi minutes. You can then POST a fake end-of-call
report to `/api/vapi/webhook` to exercise the back half.

**Live mode** (VAPI_* set): real outbound call starts, Vapi POSTs back
when it ends.

## Local end-to-end test

Run in four terminals:

1. **Supabase** is already remote — nothing to start.
2. `pnpm dev` — Next.js on :3000.
3. `pnpm stripe:listen` — forwards Stripe test events to /api/stripe/webhook.
4. (optional) `ngrok http 3000` if you want Vapi in live mode to reach
   your laptop — point Vapi's webhook at `<ngrok-url>/api/vapi/webhook`.

Then:

```
# 1. Seed businesses
pnpm ingest:businesses -- --category moving --query "movers near 10001"

# 2. Fill out the intake form + pay with card 4242 4242 4242 4242

# 3. In the stripe:listen terminal: see checkout.session.completed → 200

# 4. In the dev terminal: see "[vapi] simulated call to ..." lines

# 5. Simulate end-of-call (replace sim_XXX with the id from step 4):
curl -X POST http://localhost:3000/api/vapi/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "message": {
      "type": "end-of-call-report",
      "call": { "id": "sim_XXX" },
      "transcript": "Hi, this is Acme Movers. For a 1 bedroom from NYC to Boston around June 5 we charge $1,200 to $1,600 flat, that includes 2 movers, a 16ft truck, and basic liability. Stairs over 3 floors are $50 extra per flight.",
      "summary": "Acme Movers quoted $1,200-$1,600 flat for a 1BR NYC→Boston. Includes 2 movers + 16ft truck + basic liability. Stairs fee $50/flight.",
      "durationSeconds": 145,
      "cost": 0.18,
      "endedReason": "customer-ended-call"
    }
  }'

# 6. Verify:
#    - calls row status=completed, transcript populated
#    - quotes row inserted (if ANTHROPIC_API_KEY set) with price_min=1200, price_max=1600
#    - quote_requests.total_calls_completed incremented
#    - when total_calls_completed == total_businesses_to_call, status=processing
```

## Security checks worth knowing

- **No PII leak to businesses.** The engine builds `variableValues`
  from intake data but deliberately does NOT pass the customer's name,
  phone, or email to the Vapi call. The business gets origin/dest
  cities, home size, date, and special items — enough to quote, not
  enough to poach. Phase 8 adds an opt-in handoff.
- **Webhook signature.** Vapi uses a shared secret in the
  `x-vapi-secret` header. Set `VAPI_WEBHOOK_SECRET` in prod. Missing
  in dev is allowed but warned.
- **Idempotent dispatch.** The engine claims a batch via a conditional
  update (`status='paid' AND vapi_batch_started_at IS NULL`). Two
  concurrent webhook retries can't produce two sets of calls.
- **Idempotent webhook.** The handler short-circuits if the call is
  already in a terminal status. `quotes.call_id` is UNIQUE, so a
  duplicate-insert race still produces exactly one quote row.

## Known gaps (for Phase 7 and later)

- **Batch counter race.** `total_calls_completed` is read-modify-written
  per webhook. Two concurrent end-of-call events could clobber each
  other. Phase 7 replaces with a Postgres function that increments
  atomically.
- **No retries.** If Vapi returns 5xx on dispatch, the call row is
  marked `failed` and forgotten. Phase 7 adds a scheduled retry for
  `failed` rows with `retry_count < 3`.
- **No business quality scoring.** `call_success_rate` on
  `businesses` exists but nothing writes to it yet. Phase 7 computes
  this over the last N calls and factors it into the selector.
- **Geo selection is zip/state only.** Phase 7 adds a radius search
  using lat/lng + PostGIS (or a cheap haversine SQL function).
- **Single category.** Moving only — the intake form, call script,
  and extraction prompt are all moving-specific. Phase 8 generalizes
  these via `service_categories.call_script_template` and a
  per-category extraction schema.
- **No report generation.** Request status advances to `processing`
  when all calls are done, but nothing advances it past that yet.
  Phase 9 generates the PDF/HTML report and emails it via Resend.

## What to test next

1. Run the full local flow above with simulation.
2. Run it again with real Vapi creds against a phone number you own.
3. Flip a business's `is_active=false` in Supabase between runs to
   confirm the selector respects it.
4. Seed fewer than `CALL_BATCH_SIZE` businesses for a given zip and
   confirm the state-level backfill kicks in.
