# Content Security Policy — Implementation Plan

**Status:** Round 21 (2026-04-23) landed the end-to-end analyze workflow
for the Report-Only window (persistence gate + aggregator script +
migration). The nonce-based CSP infrastructure from Round 9 is still
behind `CSP_NONCE_ENABLED` (default OFF in production) and the minimal
static CSP remains live via `next.config.mjs`. The next operator action
is the two-step rollout documented below:

1.  **Open the collection window:** apply migration
    `0009_csp_violations.sql`, then flip `CSP_VIOLATIONS_PERSIST=true`
    in Vercel production for ~2 weeks.
2.  **Run the aggregator + populate allow-lists:** `npx tsx
    scripts/analyze-csp-reports.ts --days=14`, translate its output
    into `script-src` / `style-src` / `img-src` allow-list entries
    inside `next.config.mjs` `minimalCsp`, then flip `CSP_ENFORCE=true`.

What landed in Round 9:
- `lib/security/csp.ts` — pure helpers `buildCsp`, `generateNonce`,
  `isCspNonceEnabled`, `cspHeaderName` (18 tests).
- `middleware.ts` — when `CSP_NONCE_ENABLED=true`, generates a
  per-request nonce, sets `x-nonce` request header, and sets the
  `Content-Security-Policy-Report-Only` (or
  `Content-Security-Policy` when `CSP_ENFORCE=true`) response header
  (4 new tests).
- `app/api/csp-report/route.ts` — receives browser violation reports,
  logs structured summary lines, returns 204 (7 tests).

What landed in Round 21:
- `supabase/migrations/0009_csp_violations.sql` — narrow schema:
  `effective_directive`, `violated_directive`,
  stripped-host `document_uri` / `blocked_uri` / `source_file`
  columns. **No `raw` jsonb blob** — the browser-reported payload
  often contains user-identifying referrers, so we persist ONLY the
  fields we actually need and strip query strings at the route.
- `CSP_VIOLATIONS_PERSIST=true` gate on the POST route so the DB
  write is opt-in. Default OFF keeps pre-launch signal quiet.
- `scripts/analyze-csp-reports.ts` — read-only aggregator that groups
  rows by `(effective_directive, blocked_uri_host)`, surfaces the top
  N groups with their distinct document hosts, then a directive
  rollup, then a "flip readiness" heuristic. No mutation; the policy
  change still lands in `next.config.mjs` via human code review.
- Route test coverage: 26/26 in `app/api/csp-report/route.test.ts`.

What is NOT yet done (deferred until after the collection window):
- Threading the nonce through `<Script>` tags in `app/layout.tsx`.
  The inline JSON-LD scripts will violate under report-only and show
  up in `/api/csp-report` logs — that is the expected signal. Before
  flipping `CSP_ENFORCE=true`, those scripts MUST receive
  `nonce={nonce}` props (read from `headers().get('x-nonce')`).
- Removing the static minimal CSP from `next.config.mjs`. Both can
  coexist while we are in report-only mode (different header names);
  the static one stays as a safety net for now.

**Last updated:** 2026-04-23 (Round 22 — analyze-script workflow)

---

## Why this isn't done yet

Next.js 14 App Router inlines hashed scripts and styles that need either
`'unsafe-inline'` or a per-request `'nonce-xxxx'` source. `'unsafe-inline'`
defeats the purpose of CSP for XSS protection — an attacker who can inject
a `<script>` tag gets full execution. A real CSP therefore needs nonce
plumbing through middleware.

The work is well-scoped but touches the request/response pipeline on
every route, so it wants a dedicated session with preview-deploy testing.

---

## Recommended implementation

### Step 1 — middleware emits nonce and CSP

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const csp = [
    `default-src 'self'`,
    // 'strict-dynamic' lets legitimate nonced scripts load their
    // dependencies without listing every CDN.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://*.supabase.co https://api.stripe.com`,
    `frame-src 'self' https://checkout.stripe.com https://js.stripe.com`,
    `frame-ancestors 'none'`,
    `form-action 'self' https://checkout.stripe.com`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}
```

Also remove the static `Content-Security-Policy` header in
`next.config.mjs` — middleware wins, but having both is confusing.

### Step 2 — thread nonce to Scripts that need it

`<Script>` components that EvenQuote loads from third parties (Stripe
js, if we ever add it; analytics, if we ever add it) need:

```tsx
// app/layout.tsx
import { headers } from 'next/headers';
import Script from 'next/script';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = headers().get('x-nonce') ?? undefined;
  return (
    <html lang="en">
      <body>
        {children}
        {/* every third-party <Script> gets nonce={nonce} */}
      </body>
    </html>
  );
}
```

Next.js itself will pick up the nonce from the request header for its
own inlined scripts — no per-page work needed there.

### Step 3 — deploy Report-Only first

For the first 7 days, set the header name to
`Content-Security-Policy-Report-Only` with a `report-uri` pointing at a
simple endpoint under `/api/csp-report` that logs violations. This
catches anything we missed without breaking the site.

After a week of clean reports (or after fixing whatever we find), flip
the header name to `Content-Security-Policy` (enforcing) and delete the
report endpoint.

### Step 4 — smoke test checklist

Manually verify on preview before promoting:
- [ ] Homepage renders with no CSP violations in devtools Console
- [ ] Signup and login pages render
- [ ] Moving/cleaning intake forms submit (server actions)
- [ ] Stripe Checkout redirect completes
- [ ] Dashboard loads with session
- [ ] Email link clicks land on correct destination
- [ ] Health endpoint `/api/health` still returns 200
- [ ] Safari, Chrome, Firefox all OK — Safari is historically the pickiest on CSP

---

## What's already in place

`next.config.mjs` currently ships a minimal static CSP that's safe to
deploy with zero middleware work:

```
default-src 'self';
frame-ancestors 'none';
form-action 'self' https://checkout.stripe.com;
base-uri 'self';
object-src 'none'
```

This blocks: clickjacking (`frame-ancestors`), form redirection attacks
(`form-action`), `<base>` tag injection (`base-uri`), `<object>`/Flash
abuse (`object-src`). It does NOT block: inline script execution from
XSS — that's what nonces are for, and is Step 1 above.

---

## References

- [Next.js CSP docs](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)
- [MDN CSP reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [CSP Evaluator](https://csp-evaluator.withgoogle.com/) — paste the proposed policy to sanity-check

---

## Round 22 — collection window + analyze workflow (runbook)

This is the exact sequence to go from "Report-Only is live" to
"Enforce is live" safely. Each step is forward-safe and reversible.

### Step A — apply the CSP violations migration

```bash
# From project root, with your prod DB target selected:
npx supabase db push
# Or: paste supabase/migrations/0009_csp_violations.sql into the
# Supabase SQL editor for the production project.
```

Migration creates `csp_violations` with a narrow column set. No
breaking changes to existing tables. Safe to apply even while
`CSP_VIOLATIONS_PERSIST` is still OFF — the table just sits empty.

### Step B — open the collection window

In Vercel production env vars:

```
CSP_VIOLATIONS_PERSIST=true
```

Leave this on for **~2 weeks**. The POST handler at
`/api/csp-report` inserts one row per browser-reported violation and
always returns 204. Insert failures are swallowed so a schema drift
can never 5xx the route or destabilize page loads. Leave
`CSP_NONCE_ENABLED=true` as-is (Report-Only) — the minimal static CSP
in `next.config.mjs` continues to protect against clickjacking / base-uri
abuse throughout.

### Step C — run the aggregator

```bash
npx tsx scripts/analyze-csp-reports.ts --days=14
```

Sample output (truncated):

```
=== CSP VIOLATION SUMMARY — last 14d ===
3421 total rows, 12 distinct (directive × host) groups

TOP OFFENDERS
  script-src  js.stripe.com              1847 hits  across 3 docs
  style-src   fonts.googleapis.com        612 hits  across 2 docs
  img-src     i.vimeocdn.com              188 hits  across 1 doc
  script-src  chrome-extension            134 hits  ← BROWSER NOISE, ignore

DIRECTIVE ROLLUP
  script-src  2129 hits
  style-src    672 hits
  img-src      188 hits

FLIP READINESS
  script-src  KNOWN  (all hosts in allow-list candidates)
  style-src   KNOWN  (all hosts in allow-list candidates)
  img-src     KNOWN  (all hosts in allow-list candidates)
  → ready to flip CSP_ENFORCE=true
```

Chrome extensions and other browser-injected scripts will show up
(the `chrome-extension` scheme is a common one). Ignore anything you
can confirm is NOT a real site dependency. Everything else gets
translated into an allow-list entry in the next step.

### Step D — populate the allow-lists

Edit `next.config.mjs` → `minimalCsp` → the matching directive. Keep
the additions minimal; broaden scope only when the aggregator shows
multiple paths under the same host.

```js
// next.config.mjs (sketch)
`script-src 'self' 'unsafe-inline' https://js.stripe.com`,
`style-src  'self' 'unsafe-inline' https://fonts.googleapis.com`,
`img-src    'self' data: https://i.vimeocdn.com`,
```

Reasoning trail: every host in the policy should trace back to a row
in the aggregator output. If a host is there without a matching
violation record, it is speculative — drop it.

### Step E — flip Enforce

In Vercel production env vars:

```
CSP_ENFORCE=true
```

Middleware switches the header name from
`Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
Watch `/api/csp-report` for the next 24h — ideally the row-rate
drops to near-zero. If it doesn't, a host in the aggregator was
missed; revert `CSP_ENFORCE=false` (the Report-Only fallback stays
live), add the host, repeat.

### Step F — close the collection window

Once Enforce has been stable for a week:

```
CSP_VIOLATIONS_PERSIST=false
```

The route still 204s on every POST, but the DB write shuts off. The
`csp_violations` table stays populated for historical spelunking; a
future incident can repeat the loop by flipping `PERSIST` back on.

### Local dry-run (optional)

Before the prod collection window, you can exercise the analyze
script locally. `scripts/seed-csp-sample.ts` inserts a handful of
realistic mocked violations into a local Supabase DB so you can see
the aggregator output format end-to-end:

```bash
npx tsx scripts/seed-csp-sample.ts
npx tsx scripts/analyze-csp-reports.ts --days=30
```

Delete the seeded rows afterward (the script prints the IDs it
inserted) or point the seed script at a throwaway test DB. Never run
the seed against production.
