'use server';

// Server action: create a Stripe Checkout Session for a quote request.
//
// Flow:
//   1. Client posts the request_id.
//   2. We load the quote_request via admin client (guests have user_id=null,
//      so we can't use the cookie client here — RLS would block the read).
//   3. Verify status is 'pending_payment'. Already-paid requests redirect
//      to the success page instead of creating another session.
//   4. Create a Stripe Checkout Session with:
//         - inline price_data (one product, one price)
//         - client_reference_id = quote_request.id (used by the webhook)
//         - customer_email prefilled from intake (nicer UX)
//         - metadata including the request id (defense-in-depth)
//         - success_url back to /get-quotes/success
//         - cancel_url back to /get-quotes/checkout
//   5. Return the session URL to redirect the browser.
//
// Security notes:
//   - We never let the client pass the price. Always server-controlled.
//   - We never let the client pass the success/cancel URLs — they're
//     derived from NEXT_PUBLIC_APP_URL (or request headers in dev).
//   - Idempotency: each attempt creates a fresh session. Stripe won't
//     charge twice because a session is single-use, but we don't want
//     to accumulate orphaned sessions either. Mitigation: status-check
//     before creating (step 3).

import { z } from 'zod';
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { getStripe, QUOTE_REQUEST_PRICE } from '@/lib/stripe/server';
import { rateLimit, clientKeyFromHeaders } from '@/lib/rate-limit';
import { createLogger } from '@/lib/logger';

const log = createLogger('createCheckoutSession');

const Input = z.object({
  requestId: z.string().uuid('Invalid request id'),
});

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: true; alreadyPaid: true; requestId: string }
  | { ok: false; error: string };

function getSiteUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  }
  const h = headers();
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

export async function createCheckoutSession(
  raw: unknown
): Promise<CheckoutResult> {
  // Rate limit: 20/min/IP. Checkout creation hits Stripe on every call
  // and Stripe's own API limits us to 100 req/sec account-wide, so
  // capping per-IP here shields us from one ambitious tab.
  const rl = rateLimit(clientKeyFromHeaders(headers(), 'checkout'), {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Too many checkout attempts. Try again in ${rl.retryAfterSec}s.`,
    };
  }

  const parsed = Input.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }
  const { requestId } = parsed.data;

  const admin = createAdminClient();

  // 1. Load the request (admin — it may be a guest row)
  const { data: request, error: loadErr } = await admin
    .from('quote_requests')
    .select('id, status, intake_data, city, state')
    .eq('id', requestId)
    .single();

  if (loadErr || !request) {
    return { ok: false, error: 'Quote request not found' };
  }

  // 2. Short-circuit if already paid — send them to success page.
  if (request.status !== 'pending_payment') {
    if (request.status === 'paid' || request.status === 'calling' ||
        request.status === 'processing' || request.status === 'completed') {
      return { ok: true, alreadyPaid: true, requestId: request.id };
    }
    return {
      ok: false,
      error: `This request is in status "${request.status}" and can't be paid for.`,
    };
  }

  // 3. Extract the contact email from intake_data. We prefill Stripe's
  //    customer_email field with it so the payment flow stays friction-light
  //    and, critically, so Stripe echoes it back in the webhook — we use it
  //    later to send the magic-link claim email.
  type IntakeShape = { contact_email?: string; contact_name?: string };
  const intake = (request.intake_data ?? {}) as IntakeShape;
  const contactEmail = intake.contact_email?.trim().toLowerCase();

  if (!contactEmail) {
    // Shouldn't happen — Phase 4 Zod requires it. Defensive check.
    return { ok: false, error: 'Intake is missing a contact email' };
  }

  const siteUrl = getSiteUrl();
  const stripe = getStripe();

  // 4. Create the session
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: QUOTE_REQUEST_PRICE.currency,
            product_data: {
              name: QUOTE_REQUEST_PRICE.productName,
              description: QUOTE_REQUEST_PRICE.productDescription,
            },
            unit_amount: QUOTE_REQUEST_PRICE.amountCents,
          },
          quantity: 1,
        },
      ],
      customer_email: contactEmail,
      // client_reference_id is the canonical place to link a Checkout Session
      // to your own entity. We read it back from the webhook.
      client_reference_id: request.id,
      // Duplicate the id in metadata as defense-in-depth.
      metadata: {
        quote_request_id: request.id,
        destination_city: request.city,
        destination_state: request.state,
      },
      success_url: `${siteUrl}/get-quotes/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/get-quotes/checkout?request=${request.id}&cancelled=1`,
      // Expire sessions after 30 minutes of inactivity so we don't leave
      // stale payment intents around. Default is 24h.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    if (!session.url) {
      return { ok: false, error: 'Stripe did not return a checkout URL' };
    }

    return { ok: true, url: session.url };
  } catch (err) {
    log.error('Stripe error', { err });
    return { ok: false, error: 'Could not start checkout. Please try again.' };
  }
}
