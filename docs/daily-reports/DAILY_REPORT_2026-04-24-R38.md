# Daily report — 2026-04-24 (Round 38)

**Autonomous scheduled run.** No production code changed this round. All four shipped files live under `tests/helpers/`, `app/`, and `lib/actions/` as `.test.ts` or `.ts` helper only. Zero new Sentry capture sites. Zero new dependencies. No migrations, no `.env.example` changes.

## Headline numbers

- `npx vitest run`: **1353 passed / 101 files** (R37: 1283/98). Delta **+70 tests, +3 new files + 1 new helper file**.
- `npx tsc --noEmit`: clean.
- `npx next lint`: clean.
- `npm audit --omit=dev`: **unchanged** at 4 vulns (3 moderate, 1 high — next, uuid, svix, resend). All cross-major; all still blocked on your pre-approval.
- Determinism spot-check: 5× runs of the 4 R38-touched test files → **88/88 pass every run**.

---

## What shipped this round

### 1. `tests/helpers/source-walker.ts` + `source-walker.test.ts` — NEW helper module, 12 tests

**R38(a)**: resolves R37's standing DRY flag. Three separate audit files (`lib/actions/actions-return-convention-audit.test.ts`, `lib/actions/actions-rate-limit-audit.test.ts`, `supabase/rpc-args-drift.test.ts`) had independently written comment-stripping + balanced-brace walkers. Now they have one canonical home.

Exports three primitives:

- `stripCommentsPreservingPositions(src)` — blanks `//` and `/* */` JS/TS comments into equal-length runs of spaces. Position-preserving: index I in the output maps 1:1 to index I in the input, so regex match indexes from the stripped output land on the right char in the original. String-aware: `//` inside a quoted string doesn't count as a line comment.
- `stripCommentsAndStringsPreservingPositions(src)` — additionally blanks string/template body INSIDES (delimiters stay). Used by token-position audits where a phrase like `'safeParse('` inside an error message would otherwise false-match a real `safeParse(` call.
- `extractExportedAsyncFunctionBody(src, fnName)` — finds `export async function <fnName>(` in `src`, paren-walks the signature, then brace-walks the body. Returns the exact source span from the header through the matching `}`.

All three share an **even-backslash-count escape detector** — the subtle rule that `'\\'` (a literal one-character backslash string) closes its quote correctly because the `\\` pair is even-count, so the next `'` is un-escaped. The naive `chars[i-1] !== '\\'` check gets this wrong and has been the source of at least one flaky audit during R37 dev (see R37 close memo, item 5).

R37's `actions-return-convention-audit.test.ts` refactored to import `extractExportedAsyncFunctionBody` (kept a local alias `extractFunction` for readability). Its 18 tests still pass. The other two use-sites were deliberately **not** refactored this round:

- `lib/actions/actions-rate-limit-audit.test.ts` — uses a slightly different stripper (`stripCommentsAndStrings` for token-position math). Its fixture-driven logic is tightly coupled to the exact semantic. Swap to shared helper in a future round iff a new rate-limit fixture lands (low priority — audit is stable).
- `supabase/rpc-args-drift.test.ts` — SQL-specific parser (handles `$$` dollar-quoting, Postgres doubled-quote `''` escapes). Not the same string grammar as TS. Shared helper wouldn't fit.

Both decisions documented inline in `source-walker.ts` header.

### 2. `app/route-response-shape-drift.test.ts` — NEW, 38 tests

**R38(b)**: per-route response-body shape drift audit. Route-level counterpart to R37's `app/route-reason-audit.test.ts` (which locked capture-tag shapes) and R36's `supabase/migrations-drift.test.ts` (which locked DDL column shapes).

External consumers depend on response bodies from:

- `/api/stripe/webhook` — Stripe's retry dashboards parse `{ received, eventId, note? }`. A rename to `acknowledged` / `event_id` would break their replay idempotency.
- `/api/health`, `/api/version` — uptime monitors + the four `Check *.command` shell scripts. Rename `commitShort` → `version` and `Check Version.command` reads the wrong field silently.
- `/api/status`, `/api/cron/check-status` — outside cron schedulers parse `{ ok, checks }`.
- `/api/cron/retry-failed-calls`, `/api/cron/send-reports` — failure leg returns `{ ok: false, error }`.

**How it works.** The parser extracts every `NextResponse.json(<obj>, ...)` / `Response.json(<obj>, ...)` call in each `route.ts`. For inline object literals, it walks braces directly. For identifier args (the `const body: HealthResponse = {...}; return NextResponse.json(body, ...)` pattern used by health / version / status), it resolves backward to the `const <ident>[: <Type>] = {...}` declaration and walks THAT literal.

Key extractor is a **proper KEY/VALUE state machine** — identifiers in VALUE position (like `true`, `err.message`, `Date.now()`) are no longer mistaken for keys. Handles shorthand properties, spread, quoted keys, and skips computed `[expr]:` keys.

Per-route lock includes:

- `requiredKeys` — every listed key must appear in at least one response literal.
- `allowedKeys` — the union of keys across all response literals must fit within this set. Catches "silent new field added to webhook body".
- `forbiddenKeys` — named drifts a well-meaning refactor might reach for (`acknowledged`, `event_id`, `handled`, etc.).
- `minResponses` — lower bound on JSON-return call sites (catches "maintainer quietly deleted a branch").
- **PII-key negative lock** per route — `email`, `phone`, `address`, `full_name`, `password`, `token`, `apiKey`, `ssn`, `creditCard` are never legitimate keys in a webhook / cron / probe response body.

Cross-cutting tripwires:

- **Coverage** — every `route.ts` under `app/api/` that calls `NextResponse.json({...})` or `Response.json({...})` with an inline literal must appear in `EXPECTED_SHAPES` OR in an explicit allow-list (Twilio SMS → XML, Vapi webhooks → text/plain, CSP report → 204, dev routes → DEV_TRIGGER_TOKEN-gated).
- **Count band** — `EXPECTED_SHAPES` capped 5–15 entries. Silent deletion / explosive addition both fire.
- **No duplicate entries** across `EXPECTED_SHAPES.file`.

Current coverage: 7 routes locked (health, version, status, 3 cron, stripe/webhook).

### 3. `lib/actions/actions-zod-schema-drift.test.ts` — NEW, 20 tests

**R38(c)**: zod-schema vs migration-column type drift. Inbound-boundary counterpart to R36's `migrations-drift.test.ts` (which locks DDL column names + types) and R35's `lib-reason-types.test.ts` (which round-trips Reason unions).

A silent divergence between a zod field type and the actual column type manifests as either (a) a runtime insert failure with no zod error at the boundary, or (b) a silent coercion (text → citext case-normalization, text → uuid cast failure).

**Curated `FIELD_MAPPINGS`** — each entry names `(file, schemaVar, field, expectedZod) → (table, column)`:

- `waitlist.ts::WaitlistSchema.email` → `waitlist_signups.email` (citext).
- `waitlist.ts::WaitlistSchema.zipCode` → `waitlist_signups.zip_code` (text).
- `checkout.ts::Input.requestId` → `quote_requests.id` (uuid).

**Scope deliberately narrow this round.** Intentionally NOT locked:

- The `intake_data: jsonb` bag in `quote_requests` — schemaless Postgres-side by design.
- `MovingIntakeSchema` / `CleaningIntakeSchema` — bulk of fields land inside `intake_data`. Only `city`/`state`/`zip_code` are promoted to top-level columns, and those values are read from the zod-parsed `data` not a direct zod field, so the mapping is indirect. Future round can extend if a direct field-to-column gets added.
- Custom Postgres enums — the only enum in an action-inserted column is `status`, which is hardcoded `'pending_payment'` (no zod-supplied value).

**What's checked per mapping (5 tests each):**

1. Schema body extractable — catches a rename of `const WaitlistSchema = z.object({...})`.
2. Zod schema declares the expected field — catches a rename of the zod field.
3. Zod field has the expected inferred type — catches `.uuid()` being dropped from a `z.string().uuid()` chain, for instance.
4. Mapped migration column exists with a non-empty type.
5. Zod type is compatible with the canonicalized column type (per explicit `COMPAT` table).

**`COMPAT` table explicit + narrow:**

- `string` → `{ text, citext }` only.
- `uuid` → `{ uuid }` only.
- `number` → `{ int, numeric }`.
- `boolean` → `{ boolean }`.

Narrower than broader: `z.string()` → `timestamptz` column would be caught as drift.

**Cross-cutting tripwires:**

- Waitlist + checkout always covered (minimum-viable contract lock).
- Mapping count band 3–15.
- Every `expectedZod` has a `COMPAT` entry.
- Canonicalization vocabulary stays in sync with R36 — any column type that falls through to raw-lowercase fires the canonicalization sanity test.
- Every mapped table exists in at least one migration file.

**Note on zod version handling.** The classifier matches both `z.string().uuid(...)` (zod v3 chain) and standalone `z.uuid(...)` (zod v4), so the audit survives a zod bump. Multi-line chains (`z\n    .string()\n    .regex(...)`) correctly parsed — the regex allows whitespace between `z` and `.`.

---

## Verification

```
npx vitest run        # 1353 passed / 101 files
npx tsc --noEmit      # clean
npx next lint         # clean
npm audit --omit=dev  # unchanged: 4 vulns, all cross-major
```

5× determinism check on the 4 R38-touched test files: `88/88` pass every run.

---

## Outstanding items for you (Antonio)

**Unchanged at 12 items** from R37. Sentry DSN (item #6) still highest value — **~43 capture sites waiting**. The smoke-script (`npm run smoke:webhook-preview`) added in R34 is still backlogged for its first real preview-deploy run.

If you have 15 minutes this week and want to pick the highest-leverage one:

1. **Sentry DSN.** Paste a DSN into Vercel env (production + preview) as `SENTRY_DSN`. That's it — `lib/observability/sentry.ts` already wires init behind the presence of the DSN, and ~43 capture sites start flowing on the next deploy. No code change needed; existing `tests/env-var-audit.test.ts` already documents the var.
2. **Smoke-script first run.** `npm run smoke:webhook-preview` against a preview URL. Runbook: `docs/RUNBOOKS/SMOKE_WEBHOOK_PREVIEW.md`. ~5 minutes to exercise once all three webhooks (Stripe, Vapi, Twilio) pass with signed real payloads.
3. **Next.js 14.3.x bump.** `npm audit --omit=dev` still flags next + uuid + svix + resend. All cross-major. Pre-approve and I'll do the bump autonomously next round (estimated 45 min + verification).

---

## Suggested next autonomous run (Round 39)

- **(a) RLS-policy drift lock.** Still the highest-blast-radius regression surface — a dropped `create policy ... for select using (...)` in a future migration silently opens or closes read access. Parse `create policy` declarations + lock allowed actions per role. ~60 min. *(Carried over from R37 suggestion (d).)*
- **(b) Response-shape drift extension to the webhook text/plain routes.** The two Vapi webhook routes + Twilio SMS return text bodies, not JSON. Lock the exact strings (`'ok'`, `'ignored'`, `'invalid signature'`) with an allow-list matching what Vapi/Twilio read. ~30 min.
- **(c) Extend zod-schema drift to intake city/state/zip promotion.** The intake and cleaning-intake actions derive `city/state/zip_code` from parsed zod data. Lock the path (zod field → jsonb property → top-level column) so a rename in `DestinationSchema.destination_city` breaks the audit. ~45 min.
- **(d) Port `actions-rate-limit-audit.test.ts` to the shared source-walker.** Two call sites still use local strippers. DRY once the audit is stable. ~20 min.
- **(e) Next.js 14.3.x CVE bump** — only if pre-approved.
- **(f) Preview-deploy smoke run** — first exercise of `npm run smoke:webhook-preview`. Requires you to run it manually against a preview URL.

---

## Files touched

**New:**

- `tests/helpers/source-walker.ts` — 204 lines (new helper module)
- `tests/helpers/source-walker.test.ts` — 12 tests
- `app/route-response-shape-drift.test.ts` — 38 tests
- `lib/actions/actions-zod-schema-drift.test.ts` — 20 tests
- `docs/DAILY_REPORT_2026-04-24-R38.md` — this file

**Modified:**

- `lib/actions/actions-return-convention-audit.test.ts` — swapped the inline `stripCommentsPreservingPositions` + `extractFunction` for the shared import. 18 tests still pass.

Zero production code changed.
