# Runbook — Soft launch

**Goal:** Take EvenQuote from "works on localhost via cloudflared" to
"a real customer can pay $9.99 at evenquote.com and get a real
report 10 minutes later."

**Estimated wall-clock:** 90–120 minutes if everything cooperates.

**Pre-conditions before you start:**

- [ ] Vercel account with the GitHub repo connected.
- [ ] Stripe account with live mode enabled (KYC complete).
- [ ] Domain `evenquote.com` purchased + DNS access (Cloudflare,
      Namecheap, wherever).
- [ ] Resend account.
- [ ] **Privacy policy + Terms of Service reviewed by counsel.** The
      drafts at `app/legal/privacy` and `app/legal/terms` are not
      counsel-reviewed and the privacy page is currently NOT linked
      from the footer (see `metadata.robots` in the file). Either get
      counsel sign-off and link both, or ship the soft launch with a
      "Draft policies" banner pointing to a contact email — but DO
      NOT collect payments without at minimum a draft privacy policy
      reachable from checkout.
- [ ] **Retention purge cron — known gap.** The privacy policy
      promises eventual deletion but no purge job exists yet. Track
      this as a post-launch blocker: ship a retention cron in week
      2 (deletes quote_requests / calls / quotes after a configurable
      window; preserves payments per tax law). Until it ships, honor
      individual deletion requests manually within the 30-day SLA.
- [ ] Vapi account funded (check current balance — recommend $30+
      for the first week of soft launch traffic).
- [ ] Supabase project (`xnhkuutoarmlmocqqpsh`) — already in use.
- [ ] Phone with you to receive a real test call at the end.

Run the steps in order. Each one has a "verify before moving on"
check; don't skip.

---

## 0. Pre-flight readiness check (3 min)

Before you touch Vercel, run the readiness checker locally. It hits
every external integration (Stripe, Resend, Vapi, Anthropic, Google
Places, Supabase) with a tiny live request and reports whether your
credentials work, the Stripe account can charge, the Resend domain
is verified, etc.

```bash
cd ~/Documents/Claude/Projects/EvenQuote
npm run preflight
```

You'll get a colored ✓ / ⚠ / ✗ checklist grouped by integration. The
goal is **zero failures and warnings you understand**. Common
intentional warnings on first run:

- `stripe:mode: test key` — fine for now, fix in step 4.
- `resend:from-domain: not verified` — fine for now, fix in step 3.
- `env:STRIPE_WEBHOOK_SECRET: missing` — fine for now, fix in step 4.

After you've worked through steps 1–8, re-run in strict mode (any
warning is a failure):

```bash
npm run preflight:strict
```

If `--strict` exits 0, you're cleared to flip the public switch in
step 11.

---

## 1. Deploy to Vercel (15 min)

This is the foundational step — every other step depends on a real
URL.

1. Vercel dashboard → New Project → import the EvenQuote repo.
2. Framework: Next.js (auto-detected). Root: `./`. Build: default.
3. Skip env vars for now — we'll do the full env step below.
   The first deploy will fail the prod-required env check; that's
   expected.
4. Click Deploy. It will fail. That's fine — we have a Vercel
   project ID + a `*.vercel.app` URL we can attach DNS to.
5. Settings → Domains → add `evenquote.com`. Vercel shows you the
   DNS records to set.
6. In your DNS provider, add the records Vercel asked for. Wait for
   propagation (usually <5 min, occasionally 30+).
7. Verify: `dig evenquote.com` resolves to a Vercel IP, and
   `https://evenquote.com` returns *something* (probably a 503 from
   the failed env check — that's the right kind of broken).

---

## 2. Wire production env vars (20 min)

Settings → Environment Variables → Production scope.

Required (deploy refuses to boot without these):

```
NEXT_PUBLIC_SUPABASE_URL=https://xnhkuutoarmlmocqqpsh.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from Supabase → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<same page, "service_role" key>

STRIPE_SECRET_KEY=sk_live_…           # ← LIVE key, not sk_test_
STRIPE_WEBHOOK_SECRET=whsec_…         # we'll fill this in step 4

CRON_SECRET=<openssl rand -hex 32>    # any 32+ char random string

NEXT_PUBLIC_APP_URL=https://evenquote.com

RESEND_API_KEY=re_…                   # we'll create this in step 5
RESEND_FROM=EvenQuote <reports@evenquote.com>
```

Required for real calls (skip for "simulation mode" launch):

```
VAPI_API_KEY=…
VAPI_ASSISTANT_ID=8e5761dc-015b-40bb-826d-dbc49e791b60
VAPI_PHONE_NUMBER_ID=…
VAPI_WEBHOOK_SECRET=<same value you'll set in Vapi dashboard>
ANTHROPIC_API_KEY=sk-ant-…
GOOGLE_PLACES_API_KEY=AIza…
TWILIO_AUTH_TOKEN=…                   # for inbound SMS signature verify
```

**Critical — do NOT set in production:**

```
TEST_OVERRIDE_PHONE=…   # if this leaks to prod, EVERY customer's
                        # calls go to whoever the number belongs to.
DEV_TRIGGER_TOKEN=…     # /api/dev/* routes are NODE_ENV-gated
                        # to 404 in prod anyway, but don't tempt fate.
```

Verify: redeploy. Should boot. `https://evenquote.com` should
render the homepage. If it 500s, check Vercel logs — the env
validation error message names exactly which var is wrong.

---

## 3. Resend domain verification (15 min, but 5–60 min DNS wait)

Without this, every magic-link + report email lands in spam, which
kills the product on first impression.

1. Resend dashboard → Domains → Add Domain → `evenquote.com`.
2. Resend gives you 4 DNS records (SPF/DKIM/DMARC). Add them all in
   your DNS provider.
3. Click "Verify" — usually takes 5–10 min for DNS to propagate;
   sometimes longer. Coffee break.
4. Once verified, create an API key with "Sending access" scope.
   That's your `RESEND_API_KEY` from step 2.
5. Verify: from the Vercel deploy, trigger a magic-link email
   (`/login` → enter your email → check inbox). Should land in
   inbox, not spam, with `From: EvenQuote <reports@evenquote.com>`.

---

## 4. Stripe live webhook (10 min)

1. Stripe dashboard → switch to **Live mode** (top-right toggle).
2. Developers → Webhooks → Add endpoint.
3. URL: `https://evenquote.com/api/stripe/webhook`
4. Events: select `checkout.session.completed` (the only one we
   handle). You can also select `payment_intent.succeeded`, etc.,
   but our handler explicitly ignores them — adds noise to your
   Stripe delivery logs without payoff.
5. Reveal the signing secret. Copy it into Vercel env as
   `STRIPE_WEBHOOK_SECRET`. Redeploy.
6. **Delete the broken old endpoint** if it's still there from
   pre-launch testing (the one Stripe was retrying for 11 days).
7. Verify: from Stripe dashboard → click your endpoint → "Send
   test webhook" → choose `checkout.session.completed`. Should
   show 200 OK in delivery log within seconds. Vercel logs should
   show one `route=/api/stripe/webhook` entry.

---

## 5. Apply outstanding migrations (5 min)

Migration 0011 was applied during R47 testing. If your prod DB is a
fresh project (different ref), apply all migrations:

```bash
cd ~/Documents/Claude/Projects/EvenQuote
SUPABASE_ACCESS_TOKEN=sbp_… \
  npx tsx scripts/apply-migration.ts supabase/migrations/0011_quote_requests_origin_coords.sql
```

Repeat for any 0001…0010 if it's a fresh project.

For the existing `xnhkuutoarmlmocqqpsh` project, all migrations
through 0011 are already applied. Skip this step.

Verify: query the live DB —
`select column_name from information_schema.columns where table_name='quote_requests' and column_name like 'origin_%';`
should return `origin_lat` and `origin_lng`.

---

## 6. pg_cron jobs (5 min)

Four crons need to run in prod: `send-reports` (5min),
`retry-failed-calls` (10min), `check-stuck-requests` (15min),
`check-status` (per Vercel cron config).

1. Migration 0008 wires the original three; **migration 0012 wires
   the stuck-request watchdog**. If you're deploying to a fresh
   Supabase project, apply both. For the existing project, 0012 is
   new and needs applying. Generate a fresh PAT at
   https://supabase.com/dashboard/account/tokens, then:
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_<paste-real-token-here> \
     npm run apply:migration -- supabase/migrations/0012_pg_cron_stuck_requests.sql
   ```
   Revoke the PAT immediately after the migration succeeds.
2. Verify all four jobs exist:
   ```sql
   select jobname, schedule, active
     from cron.job
    order by jobname;
   ```
   Expect 3+ active rows (4 once 0012 is applied).
2. Each cron POSTs to `/api/cron/<name>` with the `CRON_SECRET`
   bearer token. The token lives in Vault — verify the values:
   ```sql
   select * from vault.decrypted_secrets where name like 'cron_%';
   ```
3. If the secret in Vault doesn't match the `CRON_SECRET` in
   Vercel, update Vault to match (the cron uses Vault's value;
   the route validates against env's value).
4. Verify: tail Vercel logs and wait one cron interval (~5 min for
   send-reports). Expect 200 responses to `/api/cron/send-reports`.

---

## 7. Vapi assistants point at prod (5 min)

The outbound + inbound-callback assistants currently have
`server.url` pointing at a Cloudflare tunnel. Switch them to prod:

```bash
cd ~/Documents/Claude/Projects/EvenQuote
npm run patch:vapi-tunnel -- https://evenquote.com
```

The script reads `VAPI_API_KEY` + `VAPI_ASSISTANT_ID` (+ optional
`VAPI_INBOUND_ASSISTANT_ID`) from `.env.local`, no other config
needed. Idempotent — safe to re-run.

Verify: `curl https://api.vapi.ai/assistant/<assistantId>` (with
auth header) and confirm `server.url` is the prod URL.

---

## 8. Twilio SMS webhook → prod URL (3 min)

Twilio console → Phone Numbers → Manage → Active numbers →
`(858) 239-0688` → Messaging Configuration.

- A MESSAGE COMES IN: Webhook → `https://evenquote.com/api/twilio/sms`
  → HTTP POST.
- Save.

Verify: send the line `quote 1500` from your phone to that number.
Check Vercel logs for `route=/api/twilio/sms` 200. (Won't actually
match a quote_request unless your phone's E.164 is on file, but
the route should still 200.)

---

## 9. Sentry DSN (10 min, optional but strongly recommended)

Without this, ~43 capture sites in the codebase are no-ops. With
it, every silent prod failure becomes a Sentry event with full
context.

1. Sentry → New Project → Next.js → name "evenquote".
2. Copy the DSN.
3. Vercel env → add `SENTRY_DSN=https://…@…sentry.io/…`.
   Optionally add `SENTRY_TRACES_SAMPLE_RATE=0.1` (10% trace
   sampling — keep cost down).
4. Redeploy.
5. Verify: trigger a deliberate failure (e.g., POST a malformed
   JSON to `/api/stripe/webhook`) and watch the event land in
   Sentry within 30 sec.

---

## 10. Uptime monitor (5 min, optional but recommended)

Pick one (BetterUptime, UptimeRobot, etc.):

- URL: `https://evenquote.com/api/health`
- Interval: 1 min
- Alert: 2 consecutive failures
- Notification: your phone (SMS + push)

The route returns 200 when DB is reachable, 503 when not. Don't
monitor the homepage — it's static and a CDN cache could lie about
the app's actual health.

---

## 11. Pre-launch smoke test against prod (10 min)

Now to prove end-to-end works against the real deploy.

1. Open `https://evenquote.com/get-quotes` in an incognito window.
   Fill out a real moving form (use your own address + phone).
2. Go through Stripe checkout with a **real card** (sorry, $9.99
   is the cost of testing the live path). Use card ending in your
   own number — anything else is a real charge to a real card.
3. Watch Vercel logs:
   - `route=/api/stripe/webhook` 200 fires within 5 sec
   - `lib=enqueue` fires
   - `lib=seedOnDemand` fires (unless this zip already has data)
   - Within 30 sec, `route=/api/vapi/webhook` starts firing
     end-of-call events as Vapi reports back
4. **Your phone should ring** within 60 sec of payment (the calls
   target real businesses around your address — TEST_OVERRIDE_PHONE
   is unset in prod). Pick up if you want to listen, hang up if
   not — they'll proceed regardless.
5. Wait ~5–10 minutes for all 10 calls to complete.
6. Magic-link email should land within 30 sec of payment. Click
   it, sign in, see the dashboard at
   `https://evenquote.com/dashboard/requests/<id>`.
7. After all calls land, the report email arrives via the
   send-reports cron (next 5-min tick).

If any step fails, this is the right time to find out.

**To refund yourself after the smoke test:** Stripe dashboard →
Payments → click the test charge → Refund. Or wait — if zero
quotes were extracted, send-reports auto-refunds via the
`refundOutcome=issued` path.

---

## 12. Maintenance kill-switch test (5 min)

Before you actually need it.

1. Vercel env → flip `MAINTENANCE_MODE=true`. Redeploy.
2. Verify: `https://evenquote.com` shows the maintenance page.
   `https://evenquote.com/api/health` still returns 200.
   `https://evenquote.com/api/stripe/webhook` still works (try
   "Send test webhook" from Stripe again).
3. Flip back to `MAINTENANCE_MODE=false`. Redeploy.

You now know the kill switch works without having to discover it
during a real outage.

---

## 13. Coverage pre-warming (optional, 10 min per market)

The on-demand seeder fills any new zip on first paid request. This
is fine but adds ~3–5 sec to the first customer's call dispatch in
each new zip. If you know your launch markets, pre-warm them:

```bash
cd ~/Documents/Claude/Projects/EvenQuote
GOOGLE_PLACES_API_KEY=$GOOGLE_PLACES_API_KEY \
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \
NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
  npx tsx scripts/ingest-businesses.ts \
    --category moving \
    --zips 92008,92009,92010,92011,92024,92054,92056
```

Repeat per category (`moving`, `cleaning`, `handyman`, `lawn-care`)
× per zip set. Each zip = ~$0.03 in Places API charges.

---

## Launch-day checklist (the actual flip)

Once steps 1–12 pass:

1. Announce on whatever channels you've decided.
2. Open `https://evenquote.com/admin/requests` in a tab and watch
   it.
3. Pin the Vercel logs in another tab.
4. Pin Sentry in a third tab.
5. Have your phone with you to handle any first-customer support
   reply that lands in `reports@evenquote.com`.

---

## Post-launch — first 24 hours

Watch for:

- **Vapi balance burning fast** — $0.05–$0.10 per call avg. 10
  calls × 20 customers = $10–$20/day. Set a Vapi spend cap as
  insurance.
- **Resend bounce rate** — should be <2%. If higher, your sender
  reputation needs warming, or your DNS records aren't right.
- **Stripe failed charges** — bounded by Stripe's risk engine
  already, but watch for any pattern.
- **`/admin/requests`** — every paid row should advance from
  `paid` → `calling` → `processing` → `completed` within 15 min.
  Anything stuck in `paid` for >5 min means the call engine isn't
  picking it up — check `quote_requests.vapi_batch_started_at`.
- **Sentry events** — first day will have noise; tune alert rules
  after you see the natural baseline.

---

## Common gotchas (battle-tested from pre-launch testing)

- **"Stripe sent 11 retries to a dead URL."** Old test endpoints
  outlive their tunnels. Always delete pre-launch endpoints when
  you create the prod one.
- **"No quotes extracted from a clear transcript."** The
  extractor's `notes` field used to be too permissive. R47.1
  tightened it. If it happens again, check Vercel logs for
  `seedOnDemand`/`apply-end-of-call` warns — the new logging
  surfaces the reason.
- **"Calls hung in `in_progress` forever."** Vapi end-of-call
  webhook can't reach your URL. In prod this only happens during
  a real outage; the `/api/dev/backfill-call` recovery route is
  dev-only (NODE_ENV gated). Real fix: ensure Vercel deploy is
  healthy and the assistant's `server.url` matches.
- **Cron silent.** If `send-reports` doesn't fire, the Vault
  secret doesn't match `CRON_SECRET` in env. The route returns
  401 silently to anything without the right secret.

---

## Rollback

If something goes catastrophically wrong:

1. Flip `MAINTENANCE_MODE=true`. Public site goes dark; webhooks
   + crons keep running so paid customers get serviced.
2. Triage from Sentry + Vercel logs.
3. If it's a code bug: revert the most recent deploy in Vercel
   (one click).
4. If it's an external service (Vapi down, Resend down, Stripe
   down): wait, communicate via email to affected customers,
   refund as needed.
5. Once fixed, flip `MAINTENANCE_MODE=false`.

---

**Last updated:** 2026-04-27. Update this doc as you discover
launch-day gotchas worth capturing for next time.
