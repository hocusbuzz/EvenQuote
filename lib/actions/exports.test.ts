// Public-surface snapshot tests for lib/actions/*.
//
// Each action module is imported from route handlers, server
// components, or other server actions. A silent rename or removal of
// an export would:
//   • Break app/api/stripe/webhook/route.ts (→ sendPaymentMagicLink)
//   • Break app/q/[id]/release/route.ts (→ releaseContactToBusiness)
//   • Break the homepage waitlist form server action (→ joinWaitlist)
// all at once, in the same deploy, without a typecheck blowup at the
// call site if the change was hidden behind a re-export.
//
// Mirrors the lockdown pattern in:
//   • lib/security/exports.test.ts
//   • lib/observability/exports.test.ts
//
// Scope:
//   • Freeze the public function NAMES. A module that exports
//     `sendPaymentMagicLink` must keep exporting something named that.
//   • Freeze the KIND (function vs. value placeholder) — we don't want
//     someone swapping to a lazy-imported default without catching it.
//   • DON'T freeze types — TypeScript handles that at compile time; a
//     re-shape of the input arg is meant to surface at the call site,
//     not here.
//   • DON'T invoke the actions — they have side effects (DB writes,
//     email sends, Stripe calls). The narrow "callable" assertion
//     below is a typeof check, not a behavioral test.

import { describe, it, expect } from 'vitest';

import * as postPayment from './post-payment';
import * as releaseContact from './release-contact';
import * as waitlist from './waitlist';

function functionKeys(mod: Record<string, unknown>) {
  // Type-only exports (`export type Foo`) do NOT appear on the
  // runtime namespace — they are erased during compile. So this
  // naturally filters to runtime-callable exports without us having
  // to special-case types in the assertion.
  return Object.fromEntries(
    Object.keys(mod)
      .sort()
      .filter((k) => typeof mod[k] === 'function')
      .map((k) => [k, typeof mod[k]]),
  );
}

describe('lib/actions/post-payment public surface', () => {
  it('exposes exactly the sendPaymentMagicLink function', () => {
    // Consumed by app/api/stripe/webhook/route.ts on successful
    // checkout.session.completed events. Renaming without updating
    // the webhook silently breaks payment confirmation emails — a
    // customer pays, never gets the quote link, and charges back.
    expect(functionKeys(postPayment)).toEqual({
      sendPaymentMagicLink: 'function',
    });
  });
});

describe('lib/actions/release-contact public surface', () => {
  it('exposes exactly the releaseContactToBusiness function', () => {
    // Consumed by the business-facing release endpoint. Renaming
    // breaks the pay-to-unlock flow on the business side.
    expect(functionKeys(releaseContact)).toEqual({
      releaseContactToBusiness: 'function',
    });
  });
});

describe('lib/actions/waitlist public surface', () => {
  it('exposes exactly the joinWaitlist function', () => {
    // Consumed by the homepage waitlist form (server action). This
    // action also depends on assertRateLimitFromHeaders from
    // lib/security/rate-limit-auth — that import is locked by
    // lib/security/exports.test.ts, so between the two this flow is
    // fully covered against silent rename breakage.
    expect(functionKeys(waitlist)).toEqual({
      joinWaitlist: 'function',
    });
  });
});
