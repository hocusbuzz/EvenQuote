# Daily report — 2026-04-24 (Round 39)

**Autonomous scheduled run.** No production code changed this round. All three shipped files are `.test.ts` audits, plus one refactor (`actions-rate-limit-audit.test.ts` → shared source-walker). Zero new Sentry capture sites. Zero new dependencies. No migrations, no `.env.example` changes.

## Headline numbers

- `npx vitest run`: **1503 passed / 104 files** (R38: 1353/101). Delta **+150 tests, +3 new files, 1 file refactored**.
- `npx tsc --noEmit`: clean.
- `npx next lint`: clean.
- `npm audit --omit=dev`: **unchanged** at 4 vulns (3 moderate, 1 high — next, uuid, svix, resend). `npm audit` (including dev): 7 vulns (3 mod, 4 high) — the extra 3 are in `@next/eslint-plugin-next` / `eslint-config-next` / `glob` (dev-only chain). All cross-major; all still blocked on your pre-approval.
- Determinism spot-check: 5× runs of all four R39-touched test files → **176/176 pass every run**.

---

## What shipped this round

### 1. `supabase/rls-policy-drift.test.ts` — NEW, 72 tests

**R39(a)**: highest-blast-radius audit carried forward from R35–R38 suggestion lists. The app-level shape tests run against mocked Supabase clients, so RLS enforcement is never exercised in CI — a silent `drop policy` or accidentally-removed `enable row level security` would only surface at preview-deploy against real customer data.

Parses every `supabase/migrations/*.sql` in lexical order, builds the cumulative RLS state (`table → {rlsEnabled, policies[]}`), and asserts it matches an explicit `EXPECTED_RLS` map.

**Coverage** (11 tables):

- `public.profiles` — 3 policies (self read, admin read all, self update with WITH CHECK role-escalation guard).
- `public.service_categories` — 1 policy (public read active).
- `public.businesses` — 1 policy (authenticated read active).
- `public.quote_requests`, `calls`, `quotes`, `payments` — 1 policy each (owner read).
- `public.quote_contact_releases` — 2 policies (owner read, admin read all).
- `public.waitlist_signups`, `vapi_phone_numbers`, `csp_violations` — deliberately 0 policies (service-role-only, documented reason locked).

**Invariants locked**:

1. **RLS enabled** for every expected table.
2. **Policy name set** matches exactly per table (no ghost policies, no missing).
3. **Policy command** (`for select` / `for update` / etc.) matches per policy. A `"profiles: self update"` accidentally promoted to `for all` would silently grant DELETE on profiles.
4. **WITH CHECK presence** — most critical on `"profiles: self update"` where the WITH CHECK clause prevents role escalation (`role = (select role from profiles where id = auth.uid())`).
5. **No unexpected client-write policies** on the 9 PII-bearing tables. Only `profiles: self update` is allowed; any new insert/update/delete/all policy on `quote_requests`, `quotes`, `calls`, `payments`, `quote_contact_releases`, `waitlist_signups`, `vapi_phone_numbers`, or `csp_violations` fires the audit.
6. **`is_admin()` helper** is declared and `SECURITY DEFINER` (without DEFINER, the helper recurses on profiles RLS).
7. **No ALTER POLICY / DROP POLICY** statements appear in migrations — convention lock; if a policy needs to change, drop+recreate in one transaction and the audit gets extended.
8. **Coverage tripwire** — every table with RLS enabled in any migration must be in `EXPECTED_RLS`, and every entry must resolve to a real migration-level table.
9. **Smoke** — predicates reference `auth.uid()` or `public.is_admin()` somewhere; catches a hypothetical future "oops everything is `using (true)`" drift.

**Parser notes**: SQL statement splitter handles `--` line comments, `/* */` block comments, `'...''...'` single-quote-with-doubled-quote-escape, and `$$...$$` / `$tag$...$tag$` dollar-quoted function bodies. The first iteration failed on migrations like `0005_multi_vertical.sql` where the `alter table ... enable row level security` statement is preceded by `--` comment lines — fixed by stripping comments within each statement before pattern matching.

### 2. `app/route-text-response-shape-drift.test.ts` — NEW, 41 tests

**R39(b)**: sibling of R38(b)'s JSON response-shape audit, for the three routes deliberately allow-listed from it because they return text/plain or application/xml instead of JSON:

- `app/api/vapi/webhook/route.ts` — text/plain
- `app/api/vapi/inbound-callback/route.ts` — text/plain
- `app/api/twilio/sms/route.ts` — application/xml (TwiML)

External consumers depend on these bodies: Vapi's dashboard parses the 200 body to distinguish `'ok'` (processed) from `'ignored'` (event type not handled) for telemetry. Twilio parses the TwiML `<Response><Message>...</Message></Response>` envelope and delivers the Message body back to the sender as SMS. A silent refactor that drops the `<?xml>` prolog, wraps TwiML in a different root element, or returns plain text instead of XML turns every inbound contractor text into a no-reply.

**Invariants locked**:

- **Required body strings** — Vapi routes must emit `'ok'`, `'ignored'`, `'invalid JSON'`, `'missing call.id'`, `'handler error'`. Twilio must emit `'misconfigured'`, `'invalid signature'`, `'missing From or Body'`.
- **Forbidden body strings** — `'success'`, `'received'`, `'acknowledged'`, `'done'`, `'processed'`, `'accepted'` on Vapi routes (drift candidates). `<TwiML`, `<SmsResponse`, `<Reply` roots forbidden on Twilio. Plain `'ok'` / `'success'` also forbidden on Twilio — if Twilio receives text/plain `'ok'` instead of TwiML, that literal text goes to the contractor as an SMS.
- **TwiML prolog** — every XML fragment starts with `<?xml version="1.0" encoding="UTF-8"?>`.
- **TwiML root element** is `<Response>` exactly, never vendor-folklore variants.
- **Content-Type header** on the Twilio route is `application/xml` (Twilio accepts `text/xml` too, but standardizing on one prevents "someone edited the header during a debugging session" drift).
- **Coverage tripwire** — every `route.ts` returning `new Response(<literal>, ...)` or `twimlResponse(<literal>)` is in `EXPECTED_TEXT_SHAPES` OR explicit allow-list. JSON routes already locked by R38(b) are explicitly allow-listed here to avoid double-coverage.

**Parser notes**: `new Response(<arg>, ...)` first-arg extraction handles four shapes — quoted-string literal, template literal without substitutions, bare identifier resolved backward to its `const` declaration, and call expression (e.g., `twimlResponse('...')`). For the Twilio route, the TwiML is built inside a template literal with `${escapeXml(message)}` substitution that the identifier-resolver can't trivially extract, so the audit additionally greps the source for template fragments containing `<?xml` or `<Response` — this finds both the success branch (`<Response><Message>…</Message></Response>`) and the empty branch (`<Response/>`).

### 3. `lib/actions/intake-promotion-drift.test.ts` — NEW, 37 tests

**R39(c)**: drift audit for the ZOD-FIELD → ACTION-LEVEL-PROMOTION → QUOTE_REQUESTS-COLUMN path on both intake verticals.

R38(c)'s `actions-zod-schema-drift.test.ts` locked three direct mappings (`WaitlistSchema.email` → `waitlist_signups.email`, `WaitlistSchema.zipCode` → `waitlist_signups.zip_code`, `checkout.Input.requestId` → `quote_requests.id`). The intake flow is more complex because zod fields get PROMOTED from inside a sub-schema out to top-level columns on `quote_requests`:

```
Moving:   DestinationSchema.destination_city   →  data.destination_city   →  quote_requests.city
          DestinationSchema.destination_state  →  data.destination_state  →  quote_requests.state
          DestinationSchema.destination_zip    →  data.destination_zip    →  quote_requests.zip_code

Cleaning: LocationSchema.city   →  data.city   →  quote_requests.city
          LocationSchema.state  →  data.state  →  quote_requests.state
          LocationSchema.zip    →  data.zip    →  quote_requests.zip_code
```

Each mapping is locked at four points:

- (A) Sub-schema is exported from the forms file.
- (B) Field exists inside the sub-schema's `z.object({ ... })` literal.
- (C) Field's inferred zod type matches expectation. New `'enum'` classification added to handle `UsStateSchema = z.enum(US_STATES)` (2-letter state code lock). The classifier resolves identifiers that reference other exported schemas (e.g., `state: UsStateSchema` → looks up `UsStateSchema`'s RHS `z.enum(...)` → classifies as `'enum'`).
- (D) Promotion statement (`city: data.destination_city`) is present in the action source.
- (E) Target column exists in `quote_requests` with the expected canonicalized type (text).

**Cross-cutting checks**:

- `service_categories` slug lookup (`.from('service_categories').eq('slug', ...)`) present in both actions.
- `category_id: category.id` promotion present in both `quote_requests` insert payloads. (Note: the column is named `category_id`, not `service_category_id`, despite FK-referencing `service_categories.id`.)
- `UsStateSchema === z.enum(US_STATES)` exact shape lock — a silent downgrade to `z.string().min(2)` would accept typos like "New Yrok".
- `ZipSchema` chains `.regex(...)` — no-regex downgrade would accept any string.

**Parser notes**: cleaning-intake.ts imports `ZipSchema` and `UsStateSchema` from `moving-intake.ts`, so the classifier's export-map is built by merging shared primitives from moving-intake into the local exports. 6 promotion mappings × 5 per-mapping assertions + 9 cross-cutting = 37 tests.

### 4. `lib/actions/actions-rate-limit-audit.test.ts` — REFACTORED

**R39(d)**: ports the R36 audit to the shared source-walker helpers from R38(a). Replaces the locally-defined `stripCommentsAndStrings` (naive regex-chain approach) and `extractFunctionBody` (manual balanced-brace walk) with `stripCommentsAndStringsPreservingPositions` and `extractExportedAsyncFunctionBody` from `tests/helpers/source-walker.ts`.

Behavioral wins:

- **Even-backslash escape detector** now used here too — the shared helper walks backward and counts consecutive `\` characters, so a string containing `'\\'` (literal single backslash) is correctly terminated. The prior local naive `chars[i-1] !== '\\'` check misread this as "escaped closing quote".
- **One source-walker** now powers four audit files (`actions-return-convention-audit.test.ts`, `actions-rate-limit-audit.test.ts`, `source-walker.test.ts`, plus the R38(b) route-response-shape audit which already uses `stripCommentsPreservingPositions`). Fourth use-site landed, no more local re-implementations.

26 tests unchanged — pure refactor, same assertions, same source coverage. Behavior-preservation verified: all 26 pass.

---

## Verification

```
npx vitest run         →  1503 passed / 104 files
npx tsc --noEmit       →  clean
npx next lint          →  No ESLint warnings or errors
npm audit --omit=dev   →  4 vulns (3 moderate, 1 high) — unchanged from R38
5× determinism on R39 files  →  176/176 pass every run
```

---

## Outstanding human-input items (unchanged at 12)

These are all pre-approvals you need to grant autonomously-deferred actions — I list them in priority order. #6 remains highest-value.

1. **Resend API key rotation** — previous key stored in `.env.local` during Phase 6; rotate on launch day.
2. **Sentry DSN** — **highest value**. ~43 capture sites wired and locked; all fire as no-ops until DSN lands in `.env.local` + Vercel env. Unlocks the entire observability posture R22–R39 built.
3. **Vapi webhook secret rotation** before launch — current secret was used during dev tunneling with cloudflared.
4. **Stripe webhook signing secret** — swap test-mode secret for live-mode on go-live.
5. **Twilio auth token** — currently set; confirm the one in `.env.local` is the long-lived prod token, not the short-lived test one.
6. **npm audit fix pre-approval** — `npm audit fix --force` needs a cross-major bump to `next@16` (breaking), `resend@6.1.3` via svix/uuid chain. Carried since R27. Recommend handling these one at a time in dedicated sessions.
7. **First preview-deploy smoke run** — `npm run smoke:webhook-preview --dry-run` first, then full run. Script shipped R34 but never exercised against a real preview.
8. **Archive 18 daily reports** — `docs/DAILY_REPORT_2026-04-2{2,3,4}-R{22..39}.md`. Proposal: move reports older than 7 days to `docs/DAILY_REPORT_ARCHIVE/` and keep the last 7 + the current round in `docs/`.
9. **Review `.env.example`** — grew from 27 → 35 docs vars across R36–R37. Confirm nothing sensitive leaked into the example.
10. **Admin role bootstrap** — nobody is an admin on production DB yet. Your email needs `role='admin'` set via service-role SQL on first login.
11. **Confirm production domain + Vercel deployment target** before running `Start Preview.command` against a live Vercel project.
12. **Review `docs/brand/`** — brand-voice skill artifacts are in the repo; confirm they match your sense of the product voice before using them for any marketing output.

---

## Suggested next autonomous run (Round 40)

**(a) RPC security-definer audit.** Lock every `create or replace function` that runs `security definer`: it must explicitly `set search_path = public` (prevents schema-injection via extension hijack). Several of ours do, some don't — audit forces consistency. ~30 min.

**(b) CSP-report 4096-char body truncation audit.** R37 locked the 6-key vocabulary + 4096-char cap. Extend to lock the MULTI-FIELD truncation — a future maintainer might trim `original_policy` but not `source_file`, violating the uniform cap. ~20 min.

**(c) Cron-auth header replay window audit.** `lib/security/cron-auth.ts` accepts requests with a timestamp; lock the accepted window (probably ±5 min). If drift lands, replay attacks become possible. ~30 min.

**(d) Supabase seed-file drift audit.** `supabase/seed/` files bootstrap service_categories, dev business records, and legal-copy. Lock the `slug` set against `lib/categories/*` and `components/site/pricing.tsx`. Front-end category switcher and back-end category lookup must stay synchronized. ~45 min.

**(e) Per-vertical intake_data jsonb READ-path audit.** The R39(c) promotion audit locks the WRITE path (zod → column). The READ path (admin dashboard + email templates reading `jsonb->>field`) is still unaudited. Lock the set of fields the UI reads against the set the zod schemas emit. ~45 min.

**(f) Next.js 14.3.x CVE bump** IF pre-approved (#6 in the human-input queue). ~45 min.

**(g) Preview-deploy smoke run** (human, #7 in the queue) — first real exercise of R34's `smoke-webhook-preview`.

**(h) Daily-report archival policy** (human, #8 in the queue) — 18 daily reports now; tar-archive older ones under `docs/DAILY_REPORT_ARCHIVE/`. ~10 min.

---

## Files touched this round

- **New**: `supabase/rls-policy-drift.test.ts` (+72 tests)
- **New**: `app/route-text-response-shape-drift.test.ts` (+41 tests)
- **New**: `lib/actions/intake-promotion-drift.test.ts` (+37 tests)
- **Refactored**: `lib/actions/actions-rate-limit-audit.test.ts` (26 tests — behavior preserved)

---

_Generated by autonomous R39 scheduled run on 2026-04-24._
