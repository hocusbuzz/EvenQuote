// Minimal Vapi client — just the outbound-call endpoint we need.
//
// Feature-flagged: if VAPI_API_KEY isn't set we return a simulated
// response so the rest of the pipeline can run end-to-end in local dev
// without placing real calls. Look for `simulated: true` in the return
// shape to know which mode you're in.
//
// Docs: https://docs.vapi.ai/api-reference/calls/create

import { createLogger } from '@/lib/logger';
import { verifyVapiWebhook as verifyVapiWebhookImpl } from '@/lib/security/vapi-auth';
import { pickVapiNumber } from '@/lib/calls/select-vapi-number';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('vapi');

// Re-export so existing call sites that import `verifyVapiWebhook`
// from `@/lib/calls/vapi` keep working unchanged. The implementation
// lives under `lib/security/*` alongside `cron-auth` + `dev-token-auth`
// so the security surface is uniform and covered by the exports test.
export const verifyVapiWebhook = verifyVapiWebhookImpl;

export type StartCallInput = {
  /** E.164, e.g. +14155551234 */
  toPhone: string;
  /** Friendly name shown in the Vapi dashboard. */
  businessName: string;
  /** Variables interpolated into the assistant prompt. */
  variableValues: Record<string, string | number | null | undefined>;
  /** Freeform metadata echoed back on webhook events. */
  metadata: Record<string, string>;
};

export type StartCallResult =
  | { ok: true; vapiCallId: string; simulated: false }
  | { ok: true; vapiCallId: string; simulated: true; reason: string }
  | { ok: false; simulated: false; error: string };

/**
 * Dispatch a single outbound call. Errors are returned, not thrown, so
 * the engine can record per-call failures without aborting the batch.
 */
export async function startOutboundCall(input: StartCallInput): Promise<StartCallResult> {
  const apiKey = process.env.VAPI_API_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  // The phoneNumberId used to come straight from VAPI_PHONE_NUMBER_ID.
  // Now it's chosen per-call by the selector, which prefers numbers that
  // match the destination's area code (local presence) and falls back
  // to the env var when the pool table is empty — so single-number
  // deployments keep working unchanged.
  const pick = await pickVapiNumber(input.toPhone);

  // Simulation mode: any required input missing → log + return a fake
  // vapiCallId so the rest of the flow is exercised. Intentionally
  // obvious (prefix + random). Used by local dev and CI.
  //
  // R47.4: HARD REFUSE in production. Without this guard a misconfigured
  // prod deploy would silently sim_* every paid customer's calls — the
  // engine would advance status to 'calling' on synthetic ids and never
  // actually dial anyone. The validateServerEnv() prod-required check
  // catches missing VAPI_* vars at boot, but this is the second line of
  // defense at the dispatch surface itself in case validation is ever
  // bypassed (e.g. NODE_ENV briefly mis-set, dynamic env reload).
  if (!apiKey || !assistantId || !pick.ok) {
    if (process.env.NODE_ENV === 'production') {
      const reason = !apiKey || !assistantId
        ? 'VAPI_* env vars missing'
        : `no phone number available: ${!pick.ok ? pick.reason : 'unknown'}`;
      log.error('refusing to simulate in production', {
        businessName: input.businessName,
        reason,
      });
      return {
        ok: false,
        simulated: false,
        error: `Vapi simulation forbidden in production: ${reason}`,
      };
    }
    const fakeId = `sim_${Math.random().toString(36).slice(2, 12)}`;
    // Mask the business phone — it's a PII-adjacent identifier when
    // combined with name/location that we don't want in log retention.
    const phoneMasked = input.toPhone.replace(/\d(?=\d{4})/g, '*');
    const reason = !apiKey || !assistantId
      ? 'VAPI_* env vars not set; skipping real dispatch'
      : `no phone number available: ${!pick.ok ? pick.reason : 'unknown'}`;
    log.info('simulated call', {
      businessName: input.businessName,
      phoneMasked,
      vapiCallId: fakeId,
      reason,
    });
    return {
      ok: true,
      vapiCallId: fakeId,
      simulated: true,
      reason,
    };
  }

  const phoneNumberId = pick.phoneNumberId;
  // Tier is informative only (observability); doesn't affect dispatch.
  log.info('picked vapi number', {
    tier: pick.tier,
    areaCode: pick.areaCode ?? null,
    // Don't log the raw Twilio E.164 — mask the last 4 for readability.
    twilioMasked: pick.twilioE164
      ? pick.twilioE164.replace(/\d(?=\d{4})/g, '*')
      : null,
  });

  // Test-mode safety net: if TEST_OVERRIDE_PHONE is set, redirect every
  // outbound call to that number instead of the real business. The
  // assistant still introduces itself with the original business name
  // and the webhook still routes via metadata.business_id, so the rest
  // of the post-call pipeline behaves exactly as it would in prod.
  //
  // R47.4: hard-disabled in production. validateServerEnv() throws at
  // boot if TEST_OVERRIDE_PHONE is set in prod, but this is the
  // dispatch-surface guard — the override is IGNORED in prod even if
  // the env somehow gets set post-boot. Cost of a false-positive log
  // line is zero; cost of a false-negative is "every customer's calls
  // route to one developer's phone."
  const overridePhoneRaw = process.env.TEST_OVERRIDE_PHONE?.trim();
  const overridePhone =
    overridePhoneRaw && process.env.NODE_ENV !== 'production'
      ? overridePhoneRaw
      : '';
  if (overridePhoneRaw && process.env.NODE_ENV === 'production') {
    log.error('TEST_OVERRIDE_PHONE detected in production — ignoring', {
      businessName: input.businessName,
    });
  }
  const dialNumber = overridePhone.length > 0 ? overridePhone : input.toPhone;
  if (overridePhone) {
    const realMasked = input.toPhone.replace(/\d(?=\d{4})/g, '*');
    log.warn('TEST_OVERRIDE_PHONE active — redirecting call', {
      businessName: input.businessName,
      realMasked,
      overridePhone,
    });
  }

  // Vapi rejects customer.name > 40 chars with a 400. Long contractor
  // names are common ("Two Men and a Truck® - North County San Diego"
  // is 47), so truncate defensively. The full, untruncated name still
  // flows into assistantOverrides.variableValues.business_name so the
  // assistant can use it in conversation.
  const VAPI_NAME_MAX = 40;
  const truncatedName =
    input.businessName.length > VAPI_NAME_MAX
      ? `${input.businessName.slice(0, VAPI_NAME_MAX - 1).trimEnd()}…`
      : input.businessName;

  // Cost-control overrides. These apply PER CALL via
  // `assistantOverrides`, so they take effect on top of whatever the
  // base assistant is configured with in the Vapi dashboard.
  //
  //   • maxDurationSeconds: 120 — hard cap at 2 minutes. Prevents a
  //     runaway conversation (chatty owner, chatty LLM, stuck-on-hold
  //     call) from burning 5+ minutes of Vapi + Twilio minutes.
  //   • silenceTimeoutSeconds: 20 — if nobody speaks for 20s, hang up.
  //     Catches hold music, forgotten calls, abandoned voicemails that
  //     don't trigger voicemail detection.
  //   • voicemailDetectionEnabled: true + voicemailMessage — when Vapi
  //     detects an answering machine, speak a short templated recap
  //     (who's calling, why, callback/SMS number) and hang up. Every
  //     voicemail we don't leave a full pitch on saves ~45s of Vapi +
  //     Twilio minutes. The recap still gives the contractor a way
  //     back to us for real quotes.
  //   • endCallAfterSpokenEnabled: true — after the voicemail message
  //     plays, hang up immediately (don't wait for a response that
  //     won't come).
  //
  // Rationale / context: see the pre-launch cost audit — at $9.99
  // revenue per request and ~$0.15-0.20/min all-in Vapi cost, a 2-min
  // cap keeps us in healthy margin territory; an uncapped 3-5 min
  // call eats it all. Every value below is an override, so you can
  // tune the base assistant in the dashboard independently for inbound
  // use cases that want different ceilings.
  const CALLBACK_NUMBER_MASKED =
    pick.twilioE164 ?? process.env.VAPI_CALLBACK_NUMBER ?? '';
  const voicemailMessage = buildVoicemailMessage({
    contactName:
      typeof input.variableValues.contact_name === 'string'
        ? input.variableValues.contact_name
        : 'our customer',
    categoryDisplay:
      typeof input.variableValues.category_display === 'string'
        ? input.variableValues.category_display
        : 'service',
    callbackNumber: CALLBACK_NUMBER_MASKED,
  });

  const body = {
    phoneNumberId,
    assistantId,
    customer: {
      number: dialNumber,
      name: truncatedName,
    },
    assistantOverrides: {
      variableValues: {
        ...input.variableValues,
        business_name: input.businessName,
      },
      // All-in ceiling on call time. 4 minutes (240s) is long enough
      // that a real, productive conversation with a contractor who
      // walks through 2–3 scope clarifications and leaves a price
      // range doesn't get truncated mid-sentence. Shorter caps were
      // cutting off useful conversations right as the contractor was
      // about to answer the price question.
      maxDurationSeconds: 240,
      // If either side goes quiet for 20s, end the call.
      silenceTimeoutSeconds: 20,
      // Voicemail handling: when Vapi detects an answering machine,
      // it speaks `voicemailMessage` and then ends the call on its own.
      // We previously also passed `endCallAfterSpokenEnabled: true`
      // here, but Vapi's per-call assistantOverrides schema rejects
      // that field (it's assistant-level only) — the API returns
      // HTTP 400 "assistantOverrides.property endCallAfterSpokenEnabled
      // should not exist" and drops every outbound dispatch. Turns
      // out voicemailDetectionEnabled is sufficient by itself: Vapi
      // hangs up automatically once the recap has finished.
      voicemailDetectionEnabled: true,
      voicemailMessage,
      // Per-call `server` override: explicitly tell Vapi where to deliver
      // webhooks AND which Bearer token to attach. We learned the hard
      // way that the assistant-level "Authorization credential" UI
      // selection (Advanced → Messaging → Authorization → Credential)
      // does NOT propagate to webhook deliveries — Vapi sent webhooks
      // to /api/vapi/webhook with NO Authorization header, our route
      // returned 401, and end-of-call data was silently dropped for an
      // entire batch (including a real \$249 quote captured by the AI
      // from "North County San Diego House Cleaning").
      //
      // Vapi's `/call` endpoint rejects `server` at the body root
      // ("property server should not exist") — it must be nested inside
      // `assistantOverrides`, alongside the other per-call assistant
      // settings (voicemailMessage, maxDurationSeconds, etc.). The
      // header shape is what `lib/security/vapi-auth.ts:extractVapiSecret`
      // already accepts (`Authorization: Bearer <secret>`). No route
      // changes needed — only the dispatch side.
      server: {
        url: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/vapi/webhook`,
        headers: {
          Authorization: `Bearer ${process.env.VAPI_WEBHOOK_SECRET ?? ''}`,
        },
      },
    },
    metadata: input.metadata,
  };

  // Canonical lib-boundary tags for every startOutboundCall failure
  // mode. A failed outbound call used to log-and-swallow inside the
  // engine — customers would simply never get called for that business
  // and we'd only notice via the stale-row reconciliation cron. Tagging
  // at the lib boundary means every caller (engine, cron, future
  // support-retry) inherits first-class alerting on silent call drops.
  //
  // PII contract: `toPhone` MUST NOT appear in tags. We forward
  // `business_id` from metadata because it's an opaque UUID that lets
  // ops bucket failures by customer without leaking any phone data.
  // Logger redaction doesn't reach Sentry tags — this is our own guard.
  //
  // Round 24: split `reason` into three discrete modes so Sentry
  // dashboards can alert per-mode without parsing error messages:
  //   • startCallHttpFailed      — Vapi returned non-2xx (carries httpStatus)
  //   • startCallMissingId       — 2xx with no call id (contract violation — page)
  //   • startCallTransportFailed — DNS/TLS/socket/timeout before a response
  const baseCaptureTags: Record<string, string> = {
    lib: 'vapi',
    ...(input.metadata.business_id
      ? { businessId: input.metadata.business_id }
      : {}),
  };

  try {
    const res = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      // Wrap the HTTP failure in a real Error so Sentry groups by
      // stack trace + the Vapi status code. The response body is
      // already truncated to 500 chars — safe to ship to the tracker.
      const wrapped = new Error(
        `Vapi startCall failed: ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
      // Also log to console so the failure is visible in Vercel logs
      // (Sentry is a no-op stub until the SDK lands). Without this,
      // dispatch failures are completely silent in prod.
      log.error('vapi startCall http failure', {
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, 500),
        businessId: input.metadata.business_id,
      });
      captureException(wrapped, {
        tags: {
          ...baseCaptureTags,
          reason: 'startCallHttpFailed',
          httpStatus: String(res.status),
        },
      });
      return {
        ok: false,
        simulated: false,
        error: `Vapi ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      };
    }

    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      // 2xx with no id — contract violation. Page us on first occurrence.
      const wrapped = new Error('Vapi startCall failed: response missing call id');
      log.error('vapi startCall missing id', {
        businessId: input.metadata.business_id,
      });
      captureException(wrapped, {
        tags: { ...baseCaptureTags, reason: 'startCallMissingId' },
      });
      return {
        ok: false,
        simulated: false,
        error: 'Vapi response missing call id',
      };
    }

    return { ok: true, vapiCallId: json.id, simulated: false };
  } catch (err) {
    // Transport layer: DNS / TLS / socket / timeout. Wrap the non-Error
    // case so the tracker always sees a real stack trace.
    const wrapped = err instanceof Error ? err : new Error(String(err));
    log.error('vapi startCall transport failure', {
      message: wrapped.message,
      businessId: input.metadata.business_id,
    });
    captureException(wrapped, {
      tags: { ...baseCaptureTags, reason: 'startCallTransportFailed' },
    });
    return {
      ok: false,
      simulated: false,
      error: wrapped.message,
    };
  }
}

// `verifyVapiWebhook` is re-exported at the top of this file; its
// implementation now lives in `lib/security/vapi-auth.ts`.

/**
 * Build the voicemail recap the assistant leaves when Vapi detects an
 * answering machine. Intentionally short (~15 seconds spoken) and
 * structured so a contractor listening back on their own time has:
 *
 *   1. What we are (an AI assistant calling for a customer)
 *   2. What the customer needs (quote_type + one-liner)
 *   3. How to respond — text or call our BYOT Twilio number with
 *      availability + rough price. Inbound SMS/voice on that number
 *      currently routes to a lightweight "callback" Vapi assistant
 *      (see docs for the inbound handler setup).
 *
 * Callback number, if we have one, is formatted as "(XXX) XXX-XXXX"
 * for speakability — Vapi's TTS reads E.164 as "plus one four one
 * five…" which is grating.
 *
 * If no callback number is available we fall back to a recap that
 * just asks them to wait for us to try again — better than leaving
 * silence or reading a raw E.164.
 */
function buildVoicemailMessage(opts: {
  contactName: string;
  categoryDisplay: string;
  callbackNumber: string;
}): string {
  const name = opts.contactName.trim() || 'a customer';
  const category = opts.categoryDisplay.trim() || 'service';
  const spoken = opts.callbackNumber ? speakableNumber(opts.callbackNumber) : '';

  if (spoken) {
    // Callback goes to the inbound assistant we set on this Twilio
    // number (voice → evenquote-callback in Vapi) or is parsed by
    // /api/twilio/sms (text → same extraction pipeline). Both paths
    // are wired.
    return (
      `Hi, this is an AI assistant calling on behalf of ${name} about a ` +
      `${category} quote. They'd like your availability and a rough price. ` +
      `You can text or call ${spoken} — our AI will take your quote in under a ` +
      `minute. Thanks.`
    );
  }

  // No callback number plumbed yet — keep the recap honest.
  return (
    `Hi, this is an AI assistant calling on behalf of ${name} about a ` +
    `${category} quote. I'll try you back later. Thanks.`
  );
}

/**
 * Format a phone number (E.164 or with separators) as "(XXX) XXX-XXXX"
 * so TTS reads it naturally. Strips non-digits, trims a leading 1 for
 * US numbers, and returns the raw input if it doesn't look like a US
 * 10-digit number after cleanup.
 */
function speakableNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}
