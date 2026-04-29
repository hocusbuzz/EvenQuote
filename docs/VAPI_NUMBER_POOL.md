# Vapi phone-number pool — operator guide

This is the "how do I add a Twilio number" runbook. Pair with migration
`supabase/migrations/0007_vapi_number_pool.sql` (schema + selector) and
`lib/calls/select-vapi-number.ts` (TypeScript client).

## Why this exists

Before this, `VAPI_PHONE_NUMBER_ID` was a single env var. One number for
every outbound call. That capped concurrency and forced every
destination to see the same caller ID — which, for a random SF-based
Twilio number dialing a mover in Houston, tanks pickup rates.

The pool replaces the env var with a table. Each call, the dispatcher
(`lib/calls/vapi.ts`) asks the selector "give me a number for this
destination" and gets:

1. A number matching the destination's area code, if any active one is
   available and under its daily cap. (`tier = 'area_code'`)
2. Otherwise, any active number under its daily cap, least-recently-used
   first. (`tier = 'any'`)
3. Otherwise, the `VAPI_PHONE_NUMBER_ID` env var — so single-number
   setups keep working unchanged. (`tier = 'env_fallback'`)

Selection is atomic (single `UPDATE ... RETURNING` with `FOR UPDATE SKIP
LOCKED`), so concurrent dispatchers in a burst can't claim the same
number.

## Adding a number — end-to-end

### 1. Buy the number on Twilio

- Twilio Console → Phone Numbers → Buy a Number
- Filter by area code matching the metros you dial most (check the
  `zip_code` distribution of recent `quote_requests`, or just start
  with the top 3–5 metros for your current verticals).
- Local numbers only. Toll-free has worse answer rates for cold
  outbound.
- A2P 10DLC registration is not required for voice-only numbers, but
  confirm the number is tagged **Voice-only** in Twilio.

### 2. Register the number with Vapi (BYO-Twilio flow)

- Vapi Dashboard → Phone Numbers → Import → **Twilio**
- Fields:
  - **Account SID** — from Twilio Console (main dashboard, top right)
  - **Auth Token** — Twilio Console → Account → API keys & tokens
  - **Phone Number** — the E.164 form, e.g. `+14155550100`
- After save, copy the new number's **Phone Number ID** (looks like a
  UUID). That's what goes into the pool.

### 3. Insert the pool row

In the Supabase SQL editor (service role / owner context), run:

```sql
insert into public.vapi_phone_numbers
  (id, twilio_e164, region_state, notes)
values
  ('<vapi-phone-number-id>', '<+1NXXNXXXXXX>', '<CA>', '<optional note>');
```

Notes on each column:

- `id` — the Vapi Phone Number ID (not the Twilio SID).
- `twilio_e164` — the raw E.164 string, with `+1`. A CHECK constraint
  enforces a valid US NANP number.
- `area_code` — **do not set**; it's a generated column that derives
  from `twilio_e164`.
- `region_state` — optional two-letter state code. Useful later for a
  state-level fallback tier. Set it when you know it.
- `status` — defaults to `active`. Leave as default for a new number.
- `notes` — free-form. Good place for "SD local, moving vertical".

### 4. Verify

```sql
select id, twilio_e164, area_code, region_state, status, created_at
from public.vapi_phone_numbers
where status = 'active'
order by created_at desc;
```

You should see the new row. Next outbound call to a matching area code
will pick it automatically — no deploy, no restart.

Confirm via logs: the `vapi-pool` namespace logs a `picked vapi number`
line with `tier`, `areaCode`, and a masked E.164. If you see
`tier: 'env_fallback'` for a destination that should have matched, the
pool lookup is failing — check `status` and `daily_call_count`.

## Rotating a number out of service

### Temporary — carrier flagged it, want to investigate

```sql
update public.vapi_phone_numbers
set status = 'flagged',
    last_error = 'customer reported spam tag 2026-04-23'
where id = '<id>';
```

The selector skips non-`active` rows. Flip back to `active` once the
issue is resolved (Twilio escalation, number-refresh, etc.).

### Permanent — retiring a number

```sql
update public.vapi_phone_numbers
set status = 'retired'
where id = '<id>';
```

Keep the row (don't `delete`) so historical `calls` rows remain
traceable to the number that dialed them.

## Daily caps

- Default cap is **75 calls / number / day** (`DEFAULT_DAILY_CAP` in
  `select-vapi-number.ts`, `p_daily_cap` in `pick_vapi_number()`).
- Based on STIR/SHAKEN / carrier-flag thresholds — most mobile
  carriers start spam-scoring numbers above ~100 calls/day.
- The reset is opportunistic: the next pick after 24h since
  `daily_reset_at` sets count=1 and stamps `daily_reset_at = now()`.
  No cron needed.
- If you need to bump the cap, change it in both places in the same PR
  (there's a test guarding the drift).

## What this does NOT do yet

Follow-ups, in order of likely value:

1. **Admin UI** — managing the pool from a Next.js admin page instead
   of raw SQL. Current volume doesn't warrant it.
2. **Auto-flagging** — when a call returns a carrier-specific spam
   error, automatically flip `status = 'flagged'`. Today this is
   manual; the `last_error` column is already there to support it.
3. **Cost tracking** — per-number Twilio spend aggregation. Useful
   when inventory grows past ~20 numbers.
4. **Spam-score monitoring** — check `free.caller.info` / Hiya APIs
   weekly and auto-flag degraded numbers.

## Related code

- `supabase/migrations/0007_vapi_number_pool.sql` — schema + RPC
- `lib/calls/select-vapi-number.ts` — TS selector
- `lib/calls/select-vapi-number.test.ts` — selector unit tests
- `lib/calls/vapi.ts` — consumer (`startOutboundCall`)
- `lib/calls/vapi.test.ts` — integration test covering pool-hit path
