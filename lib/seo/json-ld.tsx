// Tiny helper for rendering schema.org JSON-LD inside server
// components. Centralizes the dangerouslySetInnerHTML + nonce
// boilerplate so each page that wants structured data can drop in
// one component instead of three lines of script-tag plumbing.
//
// Why this exists separately from the schemas in app/layout.tsx:
// the layout owns the GLOBAL Organization + WebSite schema (rendered
// on every page). Per-page schemas (Product on /pricing, Service on
// /get-quotes/[vertical]) need the same nonce + dangerouslySetInnerHTML
// shape but live in their own page files. This helper is the shared
// surface so adding a new structured-data block is one line.
//
// Nonce contract mirrors app/layout.tsx: when CSP_NONCE_ENABLED=true
// the middleware sets `x-nonce` on the request headers; we read it
// here and React renders the attribute. When the flag is off, nonce
// is undefined and the attribute is omitted — matching the static-CSP
// behavior that allows inline script JSON-LD without a nonce.

import { headers } from 'next/headers';

type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonLdValue }
  | JsonLdValue[];

export function JsonLd({ data }: { data: Record<string, JsonLdValue> }) {
  const nonce = headers().get('x-nonce') ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
