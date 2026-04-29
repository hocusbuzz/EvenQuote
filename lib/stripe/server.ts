// Stripe SDK singleton for server-side use only.
//
// NEVER import this from a client component. The secret key must never
// reach the browser. The top-level window guard throws early if anyone
// accidentally bundles this for the client.
//
// API version note: we pin to a specific API version here (not "latest")
// so a Stripe-side upgrade doesn't silently change response shapes. Bump
// this intentionally when we're ready to test against a new version.

import 'server-only';
import Stripe from 'stripe';

if (typeof window !== 'undefined') {
  throw new Error('lib/stripe/server.ts must not be imported on the client');
}

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }

  _stripe = new Stripe(key, {
    // Pin the API version. Change deliberately.
    apiVersion: '2025-02-24.acacia',
    // Identify our integration in Stripe's logs (nice-to-have for support).
    appInfo: {
      name: 'EvenQuote',
      version: '0.1.0',
    },
  });

  return _stripe;
}

// Price config — single source of truth for the checkout amount.
// Keep in sync with STRIPE_PRICE_ID env var if/when we switch to a
// Stripe Price object. For Phase 5 we use inline price_data which
// is fine at one product, one price.
export const QUOTE_REQUEST_PRICE = {
  amountCents: 999, // $9.99
  currency: 'usd',
  productName: 'EvenQuote — AI Quote Request',
  productDescription:
    'We call local businesses for you, collect quotes, and deliver a side-by-side report.',
} as const;
