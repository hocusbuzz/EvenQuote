# EvenQuote Daily Report — 2026-04-24 (Round 33)

_Autonomous scheduled run. Antonio was away; this report is the
actionable summary of what shipped, what's verified, and what needs
his attention._

## Headline

**1079 tests passing across 84 files** (R32 baseline: 1038/82; delta
+41 tests, +2 new files). `tsc --noEmit` clean. `next lint` clean.
`npm audit --omit=dev` identical to R32 (4 vulns: 3 moderate, 1 high
— next, uuid, svix, resend; all cross-major; all still blocked on
your pre-approval).

## Shipped

### 1. `/api/health` + `/api/version` observability-contract attestation (+11 tests)

Both probe endpoints are polled at uptime-monitor frequency (~30–60s
per instance per region per probe). Adding `captureException` at any
path here would flood Sentry at per-probe rate on a real outage,
duplicate the signal that uptime dashboards already surface, and
overlap with `/api/status` (which DOES capture at cron frequency per
R28).

Mirroring the R32 attestation pattern landed on `csp-report`:

**Route headers** updated with numbered "Observability contract (R33
audit)" blocks documenting the four (health) / three (version) reasons
capture is deliberately absent.

**Test-side regression guards** added:
- `app/api/health/route.test.ts` — new `observability contract — no
  capture` block, 6 tests (14 → 20). Iterates: happy-path GET, DB
  probe returns error, createAdminClient throws (R29 config state),
  HEAD path (LB probe), HEAD with DB fail, feature-env permutation.
- `app/api/version/route.test.ts` — same block, 5 tests (21 → 26).
  Iterates: vanilla GET, production deploy env, unknown VERCEL_ENV
  fallback, HEAD path, full-env permutation.

Both files mock `@/lib/observability/sentry` module-level so the spy
is available to every test without per-test setup churn.

### 2. `lib/security/no-capture-audit.test.ts` — cross-module allow-list (+16 tests, +1 new file)

Every helper in `lib/security/*` is an adversarial-frequency gate:
rejecting tampered signatures, missing headers, rate-limit overages.
A capture site in any of them would be the attacker's preferred flood
amplifier.

The per-module tests (`stripe-auth.test.ts`, `vapi-auth.test.ts`,
`rate-limit-auth.test.ts`, `cron-auth.test.ts`, `dev-token-auth.test.ts`,
`constant-time-equal.test.ts`, `csp.test.ts`) catch deviations inside
each module. They do NOT catch a new capture site being added — that's
what this file does.

**Pattern:** grep-based source audit. Reads each file and asserts none
of them match any of 5 capture-indicative tokens (`captureException`,
`captureMessage`, `Sentry.capture`, imports from
`@/lib/observability/sentry` or `@sentry/nextjs`). 

**Drift protection:**
- Allow-list must stay in sync with the actual directory (test reads
  `__dirname` and fails on unaccounted-for modules).
- Every allow-list entry must resolve to a real file (catches a rename
  without an allow-list update).

### 3. `app/api-capture-sites.test.ts` — cross-route shape audit (+6 tests, +1 new file)

Sibling of #2, but POSITIVE: every `captureException` in `app/` must
tag `route:` at minimum. Catches:
- A new route that captures without any tag bag (would fingerprint
  into the global Sentry bucket with zero signal).
- A route that tags `domain:`, `errorCode:`, or `severity:` (ad-hoc
  top-level keys never in any per-route lock).
- A PII leak at the tag layer — `email:`, `phone:`, `token:`,
  `password:`, `apiKey:` patterns.
- A silent addition or removal of a capture site — total count gated
  at 8–20 (current: 12 across 9 route files).

Implementation: balanced-paren walker over the app/ source tree. Doesn't
depend on runtime exercise — catches capture sites the per-route tests
never touched.

### 4. `lib/observability/version.ts` edge-case coverage (+9 tests)

Extended from 14 → 23 tests. Added a new `edge cases (R33)` block that
locks:
- Type invariant across all 8 env permutations (never returns
  undefined/null/non-string).
- 7-char max on every possible input shape.
- Trailing-newline tolerance (a build script that omits trim).
- Single-character SHA (pathological CI case).
- Pureness — same env produces the same output on repeated calls.
- No module-scope caching (catches a future "perf" refactor that
  would break redeploy-within-instance SHA updates).
- Whitespace-only input is preserved, not stripped (locks current
  behavior so a future `.trim()` doesn't mask CI bugs silently).

Motivation: `/api/health` and `/api/version` must report identical
SHAs per `version.consistency.test.ts`. An edge-case drift here would
surface as paging noise on monitors that alert on SHA mismatch.

### 5. `docs/RETRY_HARNESS_FEASIBILITY_R33.md` — feasibility report

The "real-network retry harness (MSW/supertest)" item has been on the
punchlist since R22. This round evaluated the scope and pivoted to a
report rather than installing MSW autonomously (adding a dev dep is
a mutating change that deserves your review).

**TL;DR:**
- MSW + supertest would add raw-bytes / middleware / chunked-encoding
  coverage the current stub tests can't reach.
- But Next.js App Router has no canonical way to boot inside Vitest
  over a real socket. Every option has maintenance drag on Next majors.
- **Recommended alternative (R34):** a `scripts/smoke-webhook-preview.ts`
  that POSTs real signed payloads to the preview-deploy URL. Gives 70%
  of the real-harness value, zero new deps. Your call on direction.

Full feasibility breakdown in `docs/RETRY_HARNESS_FEASIBILITY_R33.md`.

## Verification

- `vitest run`: **1079 passed across 84 files** (R32 baseline: 1038/82).
- `tsc --noEmit`: clean.
- `next lint`: clean.
- `npm audit --omit=dev`: 4 vulns (3 moderate, 1 high), identical to
  R32. All four are cross-major bumps waiting on your pre-approval.

## Implementation notes for Round 34+

- **Sentry DSN capture-site count now ~43** (unchanged from R32 — this
  round added zero positive capture sites; all work was attestation,
  allow-list, and edge-case lockdown).
- **New audit patterns to re-use:**
  - Source-level grep audit for a NEGATIVE contract (no capture
    allowed): `lib/security/no-capture-audit.test.ts`. Reuse for any
    module class where the design intent is zero capture (e.g. rate
    limiter, token validators, any future auth helper).
  - Source-level shape audit for a POSITIVE contract (capture required
    to follow canonical shape): `app/api-capture-sites.test.ts`.
    Extend with lib-level counterpart if the lib capture sites ever
    grow a shape drift.
  - Probe-endpoint attestation: `app/api/health/route.test.ts`
    `observability contract — no capture` block. Reuse on any future
    probe route (e.g. `/api/ready` if we ever split readiness from
    liveness).
- **Locked tag shapes unchanged** from R32. This round added zero new
  canonical tag shapes.
- **Edge-case lockdown of `lib/observability/version.ts`** means the
  Sentry DSN unlock day has one less surprise: commit-SHA reporting
  is now type-stable and pure across every env permutation tested.

## Outstanding human-input items (unchanged at 12)

Priority-ranked by impact on shipping:

1. **Sentry DSN unlock** (user-input #6) — ~43 capture sites waiting.
   Every round adds more sites with no backend to receive them.
   **Highest ROI.** [NEEDS: your SENTRY_DSN env var.]
2. **Next.js 14.3.x CVE bump** (user-input #7) — still blocked on
   pre-approval. Cross-major from 14.2.35. [NEEDS: "yes, bump it."]
3. **Upstash Redis migration** (user-input #2) — rate-limit store
   moves from in-memory to Upstash. Zero-behaviour-change PR ready
   behind call-site ergonomics helper (landed R20). [NEEDS: your
   Upstash URL + token env vars.]
4. **Legal pages draft** — noindex scaffold exists, bodies don't.
   Not blocking launch, but blocks indexing the site on Google.
   [NEEDS: your legal review of drafts.]
5. **MSW + supertest OR smoke-preview direction** — pick one per the
   R33 feasibility report. [NEEDS: "install MSW" or "write the script
   alternative."]
6. Remaining 7 items unchanged from R32 close — see previous daily
   reports for the full list.

## Suggested next autonomous run (Round 34)

**(a)** Write `scripts/smoke-webhook-preview.ts` — the zero-dep
alternative to the MSW harness. Covers stripe + vapi + twilio with
retry-storm assertion against the preview URL. ~60-90 min.

**(b)** Lib-level counterpart of the new app capture-site audit —
cross-lib shape check for all `{lib, reason, ...}` tag shapes. ~30 min.

**(c)** Scan for any remaining unaudited app routes (should be zero
after this round, but a sanity sweep is cheap). ~15 min.

**(d)** `scripts/` directory audit — the ingest + verify-db + e2e
scripts haven't been audited for capture sites at all. Typically
script-level captures ARE appropriate (operator-invoked, bounded
frequency). ~45 min.

**(e)** Next.js 14.3.x CVE bump IF pre-approved.

**(f)** `middleware.ts` observability audit — the CSP-nonce middleware
likely needs the same attestation treatment as csp-report/health/version.
~30 min.

---

_Files touched this round:_

Edits (no net new runtime code):
- `app/api/health/route.ts` — header comment block
- `app/api/health/route.test.ts` — sentry mock + observability-contract block
- `app/api/version/route.ts` — header comment block
- `app/api/version/route.test.ts` — sentry mock + observability-contract block
- `lib/observability/version.test.ts` — edge cases R33 block

New files:
- `lib/security/no-capture-audit.test.ts`
- `app/api-capture-sites.test.ts`
- `docs/RETRY_HARNESS_FEASIBILITY_R33.md`
- `docs/DAILY_REPORT_2026-04-24-R33.md` (this file)

No source-behavior changes. All additions are regression guards +
documentation.
