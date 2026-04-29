// Vapi webhook — end-of-call handler.
//
// Vapi POSTs a few event types; we only care about `end-of-call-report`,
// which is fired once the assistant hangs up and includes the transcript,
// summary, and Vapi's post-call analysis.
//
// The actual processing — look up calls row, persist transcript, run
// extraction, insert quote, bump counters — lives in
// `lib/calls/apply-end-of-call.ts` so the dev backfill endpoint can run
// the identical code path when recovering from a dead tunnel.
//
// Idempotency: see applyEndOfCall — it short-circuits on terminal status.

import { createAdminClient } from '@/lib/supabase/admin';
import { verifyVapiWebhook } from '@/lib/calls/vapi';
import { applyEndOfCall, type VapiEndOfCallReport } from '@/lib/calls/apply-end-of-call';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('vapi/webhook');

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type VapiEnvelope = {
  message?: VapiEndOfCallReport | { type: string };
};

export async function POST(req: Request) {
  const verification = verifyVapiWebhook(req);
  if (!verification.ok) {
    return new Response(verification.error, { status: 401 });
  }

  let payload: VapiEnvelope;
  try {
    payload = (await req.json()) as VapiEnvelope;
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }

  const msg = payload.message;
  if (!msg || msg.type !== 'end-of-call-report') {
    // Anything other than end-of-call gets a quick 200 so Vapi doesn't retry.
    return new Response('ignored', { status: 200 });
  }

  const report = msg as VapiEndOfCallReport;
  const vapiCallId = report.call?.id ?? report.callId;
  if (!vapiCallId) {
    return new Response('missing call.id', { status: 400 });
  }

  const admin = createAdminClient();
  try {
    const result = await applyEndOfCall(admin, vapiCallId, report);
    if (!result.applied && result.note) {
      log.info('skipped', { note: result.note, vapiCallId });
    }
  } catch (err) {
    log.error('handler failed', { err, vapiCallId });
    // Route to the error tracker as well — applyEndOfCall is the
    // transcript-to-quote pipeline and a silent failure here means a
    // paid user gets an empty report. No-op until Sentry's DSN lands.
    captureException(err, {
      tags: { route: 'vapi/webhook', vapiCallId },
    });
    // Return 500 so Vapi retries. applyEndOfCall is idempotent, so safe.
    return new Response('handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}
