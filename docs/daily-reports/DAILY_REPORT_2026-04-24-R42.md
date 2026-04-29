# Daily Report — 2026-04-24 Round 42

**Autonomous scheduled run.** Antonio was away; this is the end-of-day summary with clear action items where a human is required.

---

## TL;DR

- **Tests:** 1798 passing across 114 files. R41 closed at 1666/111. Delta: **+132 tests, +3 files.**
- **Typecheck:** `tsc --noEmit` clean.
- **Lint:** `next lint` clean.
- **Security:** `npm audit --omit=dev` — 5 vulns (4 moderate, 1 high). **Same posture as R41.** All cross-major bumps. Still blocked on your pre-approval.
- **Shipped:** three of R41's suggested R42 items — (c) source-walker lift, (a) email template render-shape drift audit, (d) route handler export-ordering audit.
- **Determinism:** 5/5 clean on all R42-touched files (167/167 pass every run).
- **No behavior change.** All R42 work is test-file additions + one refactor of an existing test to import shared helpers. Safe to deploy.

---

## What I shipped (R42)

### R42(a) — Source-walker helper lift (fourth use-site)

**Files:**
- `tests/helpers/source-walker.ts` — extended with three new helpers.
- `tests/helpers/source-walker.test.ts` — +7 new tests (was 12, now 19).
- `lib/actions/intake-read-path-drift.test.ts` — refactored to import the shared helpers.

**What:** R41(a)'s two parser fixes (`z\s*\.` whitespace tolerance; newline-bounded string regex) were living inline in `intake-read-path-drift.test.ts`. R41's close memo flagged this as the fourth use-site and recommended promoting them.

**New exports on `source-walker.ts`:**

1. `stripCommentsAndStringLiteralsRegex(src)` — regex-based cousin of the existing position-preserving stripper. Deliberately leaves template literals intact (so `${intake.<key>}` reads stay visible to downstream walkers). Anchored with `\n` in the negated class to match the actual JS string-literal grammar — unescaped newlines are syntax errors, so the old `[^'\\]` pattern was both wrong AND the exact failure mode that ate `intake.contact_email` reads in R41.

2. `stripCommentsOnlyRegex(src)` — lighter variant for audits that want to see string-literal bodies intact (e.g. detecting `intake['key']` where the key IS the string).

3. `parseZodObjectFields(src)` — canonical zod field extractor. Handles both `<key>: z.<...>` direct primitives (including multi-line `z\n    .string()` chains — the R41(a) fix) AND `<key>: UpperCamelSchema` identifier references.

**Why this matters for R43+:** any future lexical audit of zod schemas, jsonb reads, or comment-aware source walking now imports from one place. A fifth use-site should not re-implement; it should import. Header comment documents the rules.

**Verification:** 19/19 source-walker tests passing, 24/24 intake-read-path-drift tests passing (unchanged count, pure refactor).

---

### R42(b) — Email template render-shape drift audit

**File:** `lib/email/templates-render-shape-drift.test.ts` — +16 tests.

**What:** Source-level lock on `lib/email/templates.ts`. This file renders customer + business transactional emails. Regressions here ship silently into inboxes — `templates.test.ts` already locks the functional behavior (branches, subject lines, refund copy), but the source-level shape has been unguarded.

**Invariants locked:**

1. **Exported surface.** Exactly 7 exports: `Rendered`, `RefundOutcome`, `QuoteForReport`, `QuoteReportInput`, `ContactReleaseInput`, `renderQuoteReport`, `renderContactRelease`. Helpers (`htmlShell`, `button`, `escapeHtml`, `formatUsd`, `formatPriceRange`) stay internal. A leaked helper would let callers bypass the shaped-input contract.

2. **`RefundOutcome` literal union** = `{'issued', 'pending_support', 'not_applicable'}`. Adding a 4th silently falls through the switch to the legacy default-branch copy. Locking the union forces the refactor to touch this test.

3. **Switch exhaustiveness.** `renderQuoteReport`'s refund-copy switch explicitly handles every literal from the union. `not_applicable` can be handled via `default:` (per the current design); the others must have explicit `case` branches.

4. **Template purity.** `templates.ts` contains ZERO references to `intake_data`, `intake.`, `intake[`, `process.env`, `createAdminClient`, `createClient`, or `fetch(`. The renderer is a pure `(input) => { subject, html, text }` function — inputs come from the caller, outputs go to the caller. This is the contract that makes R41(b)'s intake-read-path audit meaningful (the template is NOT a read site).

5. **HTML interpolation escape hygiene.** Every `${input.X}` inside the `const inner = \`...\`` HTML template body is on a line that also calls `escapeHtml(...)`, or is in a small explicit exemption list (`${input.quotes.length}` — a number, so no injection bytes; `${i === 0 ? 0 : 16}` — pure numeric ternary for margin-top CSS). Text-mode and subject-line interpolations are excluded — they're rendered as plain text by the mail client, not as HTML.

6. **`escapeHtml` handles all five mandatory chars** — `&`, `<`, `>`, `"`, `'` — via `.replace(/X/g, '&ent;')` chains. Source-greps the function body.

7. **No inline script sinks.** Forbidden tokens (`<script`, `javascript:`, `onclick=`, `onerror=`, `onload=`, `onmouseover=`, `data:text/html`) are absent from the source. Cheap defense against HTML-injection regressions.

8. **Both renderers wrap in `htmlShell(...)`** exactly once. Locks the brand chrome invariant — a renderer that forgets the shell ships broken styling + missing footer.

9. **Both renderers return exactly `{subject, html, text}`** — no extra/missing keys. Shape change would need a parallel update to `lib/email/resend.ts`.

10. **`renderContactRelease` surfaces both `customerPhone` AND `customerEmail`.** The contact-release email's entire purpose is to deliver these two fields; a silent drop would break the product promise (customer paid $9.99 to be contacted).

11. **Refund-copy truthfulness (the `400005b` bugfix, locked forever).** The `pending_support` branch MUST NOT say "we've refunded" / "have refunded" / "money back" / "refund has been processed" — Stripe returned an error, the refund did NOT go through. Positive lock: the branch must mention "reply to this email" so the user has a path to manual follow-up.

12. **`issued` branch DOES promise refund** — this is the one branch where that's truthful.

13. Plain-text alternative exists in both renderers (source-level `text` construction present).

14. `renderQuoteReport` has 1-or-2 calls to `button(...)` (ternary picks between "View quotes & share contact" and "Open dashboard", both pointing at `dashboardUrl`). A third button would indicate new copy needing legal review.

15. **Renderer count tripwire.** Exactly 2 exported identifiers starting with `render`. Adding a 3rd forces updating `EXPECTED_EXPORTS` + adding a functional test.

16. **Formatting convention lock.** Both exported renderers close with `}` at column 0. This is the formatting contract the audit's `extractFunctionBodyByName` helper relies on — escape-aware brace-balance walking against a file that uses `.replace(/'/g, '&#039;')` regex literals is hard (regex literals look like string literals to naive scanners — discovered during this round's build-out). Locking the formatting convention sidesteps the issue.

**Parser note for R43+.** The position-preserving stripper `stripCommentsAndStringsPreservingPositions` in `source-walker.ts` doesn't understand regex literals — it treats `.replace(/'/g, ...)` as opening a string at the first `'` inside the slashes. For `templates.ts` this zeroed out the entire function-body region. The audit sidesteps this by using the `^}` column-0 convention + asserting the convention. If a fifth source audit needs regex-literal-aware walking, that's the upgrade to make.

**Verification:** 16/16 tests passing; 5/5 determinism.

---

### R42(c) — Route handler export-ordering + method-set drift audit

**File:** `app/route-handler-exports-drift.test.ts` — +108 tests.

**What:** Next.js App Router uses the literal NAME of each `export` in a `route.ts` as the HTTP method. A typo (`export async function Get`, lower-case `e`) silently becomes a static no-op. The router also only recognizes a specific set of config export names (`runtime`, `dynamic`, `revalidate`, `fetchCache`, `preferredRegion`, `maxDuration`, `dynamicParams`). `revelidate` (typo) would silently default.

**Invariants locked across all 17 `route.ts` files:**

1. **Route-set discovery tripwire.** `discoverRouteFiles()` walks `app/` and asserts the result equals the keys of `EXPECTED_ROUTES`. Adding a new route requires adding an EXPECTED_ROUTES entry (catches "forgot to update the catalog" drift).

2. **Per-route method-set lock.** Each route's exported HTTP-method set matches `spec.methods` exactly. Catches both ways — adding a handler without updating consumers (cron scheduler doesn't know about a new GET variant) OR removing a handler a consumer still calls (silent 405 in prod).

3. **Per-route config-export lock.** Each route's declared config exports (`dynamic`, `runtime`, etc.) match `spec.config` exactly.

4. **Default-export forbidden.** `export default function Foo` is silently ignored by the App Router — a classic mistake from copy-pasting a page component into a `route.ts`. Hard-fails.

5. **No stray exports.** Any export that isn't an HTTP method, allowed config, whitelisted type alias, or whitelisted helper fails. A typo like `export async function Get` would land here as `function:Get` in the unknowns list.

6. **Whitelisted helper exports.** `app/api/status/route.ts` legitimately exports `checkStripe` + `checkVapi` — imported by `app/api/cron/check-status/route.ts`. That cross-route sharing is architecture, not drift. `RouteSpec.helperFunctions` makes each such export explicit with a reason.

7. **Whitelisted type aliases.** `AuthCallbackReason` on `auth/callback/route.ts`; `ClaimReason` on `get-quotes/claim/route.ts`; `StatusResponse` on `api/status/route.ts`. Consumed by the reason-union audit from R36.

8. **Route minimum: ≥1 HTTP handler.** A `route.ts` with no HTTP handlers is dead code — hard-fails.

9. **Config value validation.** `dynamic` must be one of `{auto, force-dynamic, error, force-static}`; `runtime` must be `{nodejs, edge}`. Guards against typos that silently default.

10. **Cross-cutting hygiene.**
    - No route imports client hooks (`useState`, `useEffect`, `useRouter`, `useSearchParams`, `useMemo`, `useCallback`, `useRef`) — routes are server-only.
    - No route declares `'use client'` — same reason.

11. **Count tripwire.** `discovered.length === Object.keys(EXPECTED_ROUTES).length`. Defense-in-depth against step (1) drift.

**Routes locked (17):** cron ×3, csp-report, dev surfaces ×3, health, status, version, stripe/webhook, twilio/sms, vapi/inbound-callback + vapi/webhook, auth/callback, auth/signout, get-quotes/claim.

**Verification:** 108/108 tests passing; 5/5 determinism.

---

## Verification

```
vitest run:        1798/1798 passing across 114/114 files  (R41: 1666/111, +132/+3)
tsc --noEmit:      clean
next lint:         clean
npm audit --prod:  5 vulns (4 moderate, 1 high) — same as R41
determinism:       5/5 on R42-touched files (167/167 pass every run)
```

---

## Items that need your decision — action items, in priority order

Numbered for ease of reference in reply. None of these are urgent this week.

1. **Sentry DSN** — still the highest-value outstanding item. ~43 `captureException` call-sites in the codebase are no-ops until you set `SENTRY_DSN` in the Vercel production env + wire the Sentry account. Every round since R33 has added capture sites; none can actually page until this lands. *What I need from you:* create a Sentry account (free tier is fine for pre-launch), copy the DSN to Vercel env → Production, redeploy. ~15 minutes.

2. **Next.js 14.3.x CVE bump** — `npm audit fix --force` closes 6 CVEs (next: 5 + postcss: 1). Bump is `14.2.35 → 16.2.4` which is cross-major; Vercel builds and Next.js server-component semantics may need revalidation. *What I need:* decide whether we bump now (before any public traffic is the cheapest time) or post-launch. If "now," I'll branch it, run `npm audit fix --force`, walk the breaking-change notes, and gate the PR on all 1798 tests + a preview-deploy smoke run before merging. ~45 minutes of agent time + your review.

3. **Resend / svix / uuid CVE bump** — `resend@5 → 6.1.3` is cross-major, fixes the remaining moderate-severity uuid bounds-check issue. Lower blast radius than the Next bump. *What I need:* pre-approval or defer to post-launch.

4. **Daily-report archival policy** — Top-level `docs/` now holds R31–R42 (12 rounds). Informal policy since R40 is "keep last ~10 rounds at top level, archive the rest." Confirm this policy for future rounds — or pick a different cadence. If you confirm, I can ship `scripts/archive-daily-reports.ts` in R43 (~20 min).

5. **Preview-deploy smoke run** — `scripts/smoke-webhook-preview.ts` (shipped R34) has never been run against a real preview URL. Worth running once end-to-end before public launch to prove the whole chain (Vercel preview → Stripe webhook → Supabase write → Resend email → Vapi enqueue). *What I need:* a window where you can watch the output + a preview URL. ~15 minutes of wall-clock.

6. **Brand voice / copy review** — unchanged. Pre-launch marketing surfaces still use placeholder copy in a few places. Not blocking, but worth a pass before any paid ads.

7. **Legal / Terms / Privacy review** — still stubbed. Important before public launch but NOT before a soft-launch to a hand-picked early list. **NOT LEGAL ADVICE** — this one genuinely needs a lawyer, not me.

8. **Admin access** — `lib/actions/admin.ts` uses `is_admin()` server-side, gated by a profile flag. Manual process today: SQL `UPDATE profiles SET role='admin' WHERE id = ...` via Supabase dashboard. Future: one-click admin toggle in the admin UI. Not urgent.

9. **Twilio SMS provisioning** — `TWILIO_AUTH_TOKEN` is now required in production (R37 update). Confirm the production number is live and the auth token is set in Vercel env.

10. **Vapi phone number pool** — `vapi_phone_numbers` table is seeded. Confirm pool size and rotation policy for launch. See `docs/VAPI_NUMBER_POOL.md`.

11. **DEV_TRIGGER_TOKEN** — local dev surface token. Confirm NOT set in prod Vercel env.

12. **ALLOW_PROD_SEED** — production seed script safety gate. Confirm unset in prod.

13. **Archival automation** — see #4 above. ~20 min script if #4 is confirmed.

14. **R42 debug-scratch cleanup** — during R42(b) build-out, a debug file got created at `tests/.debug/debug.test.ts` (now rewritten to a single no-op test). The sandbox wouldn't let me delete it. Safe to delete manually: `rm -rf tests/.debug/ scripts/debug-walker.mts`. Neither affects the suite.

**Total human-input items: 14** (was 13 — #14 added for the cleanup heads-up).

---

## Suggested next autonomous run (R43)

Ordered by expected ROI:

(a) **RPC return-type + TS cast round-trip extension.** R41(b) → carried. R37(a) locks the shape of two RPCs (`apply_call_end`, `pick_vapi_number`) against their call sites. Extend to the other 5 table-returning RPCs. ~30 min.

(b) **Cron route-handler POST/GET parity audit.** R42(c) locks the method set per route but not the INVARIANT that POST + GET share the same handler impl (`export const GET = POST;` or both delegating to a shared worker). Cron routes currently follow this — an audit locks it. ~30 min.

(c) **`scripts/archive-daily-reports.ts`.** Depends on user decision #4. ~20 min.

(d) **Regex-literal-aware position-preserving stripper** in `source-walker.ts`. R42(b)'s build-out hit this blind spot in the existing helper (`.replace(/'/g, ...)` false-opens a string literal). Not blocking today but worth shipping before a fifth source audit lands. ~30 min.

(e) **Supabase seed data integrity audit.** Extend R40(d)'s slug audit to other seeded tables (service_categories descriptions, vapi_phone_numbers format + uniqueness). ~30 min.

(f) **Next.js 14.3.x CVE bump** IF pre-approved (item #2 above). ~45 min of agent time.

(g) **Preview-deploy smoke run** IF scheduled (item #5 above). Human-gated.

(h) **Route response-header audit.** Every webhook route should set `Content-Type` + `Cache-Control: no-store`. R38(b) / R39 lock response bodies; headers are currently only checked for Twilio SMS. ~30 min.

---

## State notes for future autonomous runs

- **Sentry DSN capture-site count: ~43, unchanged from R37–R41.** Zero new capture sites in R42.
- **Locked tag shapes unchanged** from R39–R41 (lib/, route/, migration DDL).
- **Test count milestone.** 1798 tests / 114 files. R30 baseline (2026-04-23 evening) was ~950 tests. R31–R42 added ~848 tests in ~24 hours of autonomous work, all drift-catch + attestation-style. Zero net behavior change; all regression surface reduction.
- **`source-walker.ts` exports as of R42:** `stripCommentsPreservingPositions`, `stripCommentsAndStringsPreservingPositions`, `extractExportedAsyncFunctionBody`, `stripCommentsAndStringLiteralsRegex`, `stripCommentsOnlyRegex`, `parseZodObjectFields`. Import path from `lib/actions/`: `../../tests/helpers/source-walker`. Import path from `app/` root: `../tests/helpers/source-walker`.
- **`EXPECTED_ROUTES` catalog** in `app/route-handler-exports-drift.test.ts` is now the canonical inventory of `route.ts` files. Adding a route REQUIRES adding an entry.
- **No source behavior changed in R42.** Test-file changes + one refactor (intake-read-path-drift.test.ts imports shared helpers). Safe to deploy.

---

## Bottom line

R42 shipped three audits representing the top three items from R41's suggested queue. The biggest wins:

1. Email template source is now fully locked — refund-copy truthfulness from commit `400005b` is defended by test going forward, not just by memory.
2. Every `route.ts` is catalogued with exact method + config expectations. A typo'd handler (`export async function Get`) would fail CI, not silently ship as a 404.
3. The `source-walker.ts` helpers canonicalize three distinct use-sites of comment/string/regex parsing. The fifth use-site will start smaller.

**Biggest thing still waiting on you:** Sentry DSN (#1). Every round keeps adding capture sites that go to /dev/null until this lands.

Next autonomous run (R43) has 8 queued candidates. I'll pick the highest-ROI one when the next scheduled task fires.
