// /get-quotes/claim — guest → authed claim route.
//
// Flow in plain English:
//   1. Guest completes intake + Stripe checkout using their email.
//   2. Webhook inserts payments row with user_id=NULL and kicks off a
//      magic-link email to that same email.
//   3. User clicks magic link → /auth/callback exchanges code for session
//      and redirects to /get-quotes/claim?request=<uuid>.
//   4. THIS route runs:
//        a. Reads the current authed user from cookies.
//        b. Loads the target quote_request by id.
//        c. Verifies the signed-in user's email matches the intake email.
//           (Rejects the claim if it doesn't — otherwise a user could
//            trivially steal someone else's request by visiting the URL.)
//        d. Sets quote_requests.user_id = auth.uid()  (if still NULL)
//        e. Sets payments.user_id = auth.uid(), claimed_at = now()
//           (where quote_request_id = <id> and user_id IS NULL)
//        f. Redirects to /get-quotes/success?request=<id>
//
// If the user isn't signed in we bounce them to /login?next=... so the
// middleware / login flow finishes the loop cleanly.

import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('get-quotes/claim');

export const dynamic = 'force-dynamic';

function errorRedirect(origin: string, message: string, requestId?: string) {
  const url = new URL('/auth-code-error', origin);
  url.searchParams.set('message', message);
  if (requestId) url.searchParams.set('request', requestId);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const requestId = searchParams.get('request');

  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    return errorRedirect(origin, 'Missing or malformed request id');
  }

  // 1. Who's signed in?
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Not authed — push through login, tell it to come back here.
    const login = new URL('/login', origin);
    login.searchParams.set('next', `/get-quotes/claim?request=${requestId}`);
    return NextResponse.redirect(login);
  }

  const userEmail = user.email?.toLowerCase().trim();
  if (!userEmail) {
    // Provider didn't give us an email — shouldn't happen with magic-link
    // or Google, but defensive.
    return errorRedirect(origin, 'Your account does not have an email on file', requestId);
  }

  // 2. Load the target request (admin — it may still be user_id=NULL).
  const admin = createAdminClient();
  const { data: req, error: loadErr } = await admin
    .from('quote_requests')
    .select('id, user_id, status, intake_data')
    .eq('id', requestId)
    .maybeSingle();

  if (loadErr || !req) {
    return errorRedirect(origin, 'Quote request not found', requestId);
  }

  // 3. If the request is already claimed, either by this user (idempotent
  //    re-click of the magic link, which is fine) or someone else (actual
  //    collision), handle both cases.
  if (req.user_id && req.user_id !== user.id) {
    // Someone else already owns this. Refuse silently — don't leak that
    // the request exists under a different account.
    return errorRedirect(origin, 'This request is already claimed', requestId);
  }

  // 4. Verify the signed-in user's email matches the intake email. This
  //    is the key security check for guest-claim flow: without it, any
  //    signed-in user could visit /get-quotes/claim?request=<uuid> and
  //    steal the row. Matching email prevents that because magic-link
  //    sign-in required receiving mail at that address.
  type IntakeShape = { contact_email?: string };
  const intake = (req.intake_data ?? {}) as IntakeShape;
  const intakeEmail = intake.contact_email?.toLowerCase().trim();

  if (!intakeEmail) {
    return errorRedirect(origin, 'Request has no contact email on file', requestId);
  }

  if (intakeEmail !== userEmail) {
    // Signed-in user != the email used at intake. Refuse.
    // Logger redacts emails — we want just enough signal (user id, request
    // id) to investigate without writing full addresses to log storage.
    log.warn('email mismatch — claim refused', {
      requestId,
      userId: user.id,
      userEmail,
      intakeEmail,
    });
    return errorRedirect(
      origin,
      `This request was placed with a different email. Sign in as ${intakeEmail} to claim it.`,
      requestId
    );
  }

  // 5. Backfill. Do both writes under the admin client.
  //    Use conditional WHEREs so a re-click doesn't wipe anything we've
  //    already set.

  // 5a. quote_requests.user_id
  if (req.user_id === null) {
    const { error: reqUpdErr } = await admin
      .from('quote_requests')
      .update({ user_id: user.id })
      .eq('id', requestId)
      .is('user_id', null);

    if (reqUpdErr) {
      log.error('quote_requests backfill failed', {
        requestId,
        err: reqUpdErr.message,
      });
      return errorRedirect(origin, 'Could not link your account — please contact support', requestId);
    }
  }

  // 5b. payments.user_id + claimed_at. There should be exactly one
  //     payments row per quote_request for now (we don't retry charges).
  //     The UPDATE is no-op if already claimed.
  const { error: payUpdErr } = await admin
    .from('payments')
    .update({ user_id: user.id, claimed_at: new Date().toISOString() })
    .eq('quote_request_id', requestId)
    .is('user_id', null);

  if (payUpdErr) {
    // Not fatal — the request is already linked to the user, the payment
    // row is still valid. Log and continue.
    log.error('payments backfill failed', {
      requestId,
      err: payUpdErr.message,
    });
  }

  // 6. Off to the happy-path success page. With user_id now populated,
  //    the success page will render the "your quotes are in motion"
  //    variant instead of the "check your email" variant.
  const success = new URL(`/get-quotes/success`, origin);
  success.searchParams.set('request', requestId);
  return NextResponse.redirect(success);
}
