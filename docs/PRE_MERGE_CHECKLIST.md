# Pre-merge checklist — EvenQuote

Everything below runs on your Mac. Claude runs most of these in the sandbox,
but `next build` times out there, so the last one is only reliably done
locally.

## One-shot verification

```bash
npm ci                # match lockfile exactly (not `npm install`)
npm run typecheck     # tsc --noEmit; must exit 0
npm run lint          # next lint; must say "No ESLint warnings or errors"
npm test              # vitest run; 475+ tests, all green
npm run build         # next build; catches App Router edge cases tsc misses
```

If all four exit 0 you're safe to push. If `build` fails but `typecheck`
passes, it's almost always one of: a CSP header rejecting a runtime
script (check the Console), a missing env at build time (check
`lib/env.ts`), or a new page importing a client-only API at the module
top level.

## Security sweep

```bash
npm audit --production        # production deps only
npm ls uuid                   # check if resend is still pulling old uuid
git status --ignored          # nothing sensitive in modified files
grep -rn "process.env.SUPABASE_SERVICE_ROLE_KEY" app/ 2>/dev/null || true
grep -rn "process.env.STRIPE_SECRET_KEY" app/ components/ 2>/dev/null || true
```

The last two greps should return nothing — those secrets must live only
behind `lib/supabase/admin.ts` and `lib/stripe/server.ts`.

## Known-accepted vulnerabilities (as of 2026-04-22)

These are documented rather than patched; re-evaluate monthly.

| Package | Severity | Fix | Decision |
| --- | --- | --- | --- |
| next 14.2.35 (4 advisories) | High | `next@16` (breaking) | Open — see `docs/DAILY_REPORT_2026-04-22.md` Action #1 |
| eslint-config-next 14.2.15 | High (dev only) | `eslint-config-next@16` | Dev only, bundled with next bump |
| glob (via eslint-config-next) | High (dev only) | upstream | Dev only, not reachable at runtime |
| uuid <14 (via resend → svix) | Moderate | Upstream `resend` | Blocked on resend publishing fix |
| svix (via resend) | Moderate | Upstream | Blocked on resend publishing fix |
| resend 6.12.2 | Moderate | Upstream | Blocked — file issue with resend-node if not resolved by next quarter |

## When `next build` breaks and `tsc` passed

Most likely causes, in order:

1. **CSP header blocked a script.** Open devtools Console — CSP violations
   show the exact directive that fired. Fix in `next.config.mjs` or add
   a nonce via the plan in `docs/CSP_PLAN.md`.
2. **An env var validated in `lib/env.ts` is missing.** Set it locally
   (`.env.local`) or mark it production-only in the schema.
3. **A client component imported a server-only module.** Look for
   `'use client'` files importing anything under `lib/supabase/admin`,
   `lib/stripe/server`, or cron/internal paths.
4. **App Router nested layout types.** Usually a params-shape mismatch
   between a page and its layout. `tsc` catches most of these, but
   Next runs its own type pass during build that is occasionally
   stricter.

## CI replacement target (future)

When you wire up GitHub Actions, the minimum gate for `main` should be:

```yaml
- npm ci
- npm run typecheck
- npm run lint
- npm test
- npm run build
- npm audit --audit-level=high --production   # non-blocking warning
```

The `audit` step should warn-not-fail until the next-16 migration lands,
because the current high-severity cluster is documented-accepted (see
table above).

## Round-by-round test baseline

Each production-readiness round has pushed the baseline up. Keep this
log so "tests went green" is a falsifiable claim: if the counter regresses,
something was deleted rather than fixed.

| Round | Test files | Tests | Notes |
| --- | --- | --- | --- |
| Baseline (before rounds) | — | 200+ | Phase 9 exit state |
| Round 6 exit | 38 | 321 | Console-logger migration complete |
| Round 7 exit | 43 | 370 | +5 files, +49 tests — error boundaries, 404, footer, FormField a11y, utils/stripe/google-places lib coverage |
| Round 8 exit | 50 | 434 | +7 files, +64 tests — use-step-validation helpers, /api/status, sitemap+robots, auth callback, claim route, waitlist, email snapshots, logger PII fix |
| Round 9 exit | 53 | 475 | +3 files, +41 tests — Stripe webhook replay-protection, /api/cron/check-status, CSP nonce module + report endpoint + middleware integration |

If your local `npm test` shows fewer than 475 tests on a clean checkout
after Round 9 merges, the .test.ts / .test.tsx glob in
`vitest.config.ts` has regressed — re-check `include: ['**/*.{test,spec}.{ts,tsx}']`.
