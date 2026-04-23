# Content Security Policy — Implementation Plan

**Status:** Round 9 (2026-04-22) landed nonce-based CSP infrastructure
behind the `CSP_NONCE_ENABLED` env flag. **It is currently OFF in
production.** The minimal static CSP (frame-ancestors, form-action,
base-uri, object-src) remains live via `next.config.mjs`. The next
operator action is to flip `CSP_NONCE_ENABLED=true` in Vercel and watch
`/api/csp-report` logs for 7 days before flipping `CSP_ENFORCE=true`.

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

What is NOT yet done (deferred until after the report-only window):
- Threading the nonce through `<Script>` tags in `app/layout.tsx`.
  The inline JSON-LD scripts will violate under report-only and show
  up in `/api/csp-report` logs — that is the expected signal. Before
  flipping `CSP_ENFORCE=true`, those scripts MUST receive
  `nonce={nonce}` props (read from `headers().get('x-nonce')`).
- Removing the static minimal CSP from `next.config.mjs`. Both can
  coexist while we are in report-only mode (different header names);
  the static one stays as a safety net for now.

**Last updated:** 2026-04-22 (Round 9)

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
