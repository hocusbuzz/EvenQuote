// Minimal Vapi client — just the outbound-call endpoint we need.
//
// Feature-flagged: if VAPI_API_KEY isn't set we return a simulated
// response so the rest of the pipeline can run end-to-end in local dev
// without placing real calls. Look for `simulated: true` in the return
// shape to know which mode you're in.
//
// Docs: https://docs.vapi.ai/api-reference/calls/create

import { createLogger } from '@/lib/logger';

const log = createLogger('vapi');

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
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;

  // Simulation mode: any required env missing → log + return a fake
  // vapiCallId so the rest of the flow is exercised. This is how local
  // dev and CI run, and it's intentionally obvious (prefix + random).
  if (!apiKey || !phoneNumberId || !assistantId) {
    const fakeId = `sim_${Math.random().toString(36).slice(2, 12)}`;
    // Mask the business phone — it's a PII-adjacent identifier when
    // combined with name/location that we don't want in log retention.
    const phoneMasked = input.toPhone.replace(/\d(?=\d{4})/g, '*');
    log.info('simulated call', {
      businessName: input.businessName,
      phoneMasked,
      vapiCallId: fakeId,
    });
    return {
      ok: true,
      vapiCallId: fakeId,
      simulated: true,
      reason: 'VAPI_* env vars not set; skipping real dispatch',
    };
  }

  // Test-mode safety net: if TEST_OVERRIDE_PHONE is set, redirect every
  // outbound call to that number instead of the real business. The
  // assistant still introduces itself with the original business name
  // and the webhook still routes via metadata.business_id, so the rest
  // of the post-call pipeline behaves exactly as it would in prod.
  // REMOVE this env var before going live (or it'll override real calls).
  const overridePhone = process.env.TEST_OVERRIDE_PHONE?.trim();
  const dialNumber = overridePhone && overridePhone.length > 0 ? overridePhone : input.toPhone;
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
    },
    metadata: input.metadata,
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
      return {
        ok: false,
        simulated: false,
        error: `Vapi ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      };
    }

    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      return {
        ok: false,
        simulated: false,
        error: 'Vapi response missing call id',
      };
    }

    return { ok: true, vapiCallId: json.id, simulated: false };
  } catch (err) {
    return {
      ok: false,
      simulated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Verify a Vapi webhook. Vapi supports a shared-secret header approach:
 * set the same value in Vapi's webhook config and in VAPI_WEBHOOK_SECRET
 * here.
 *
 * Security: in production this MUST be set. A missing secret would turn
 * the webhook into an unauthenticated write surface against the admin
 * (service-role) Supabase client. We hard-fail in prod; only in dev do
 * we fall back to "accept everything" for local testing.
 *
 * Accepts either presentation so it works with any of Vapi's credential
 * types in their Server Configuration UI:
 *   • `x-vapi-secret: <secret>`         — legacy Server URL Secret field
 *   • `X-Vapi-Secret: <secret>`         — same, case variant
 *   • `Authorization: Bearer <secret>`  — current "Bearer Token" credential
 */
export function verifyVapiWebhook(req: Request): { ok: true } | { ok: false; error: string } {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      log.error(
        'VAPI_WEBHOOK_SECRET is not set in production — refusing to accept request'
      );
      return { ok: false, error: 'Webhook misconfigured: secret not set' };
    }
    log.warn(
      'VAPI_WEBHOOK_SECRET not set — DEV MODE, accepting without verification'
    );
    return { ok: true };
  }
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const provided =
    req.headers.get('x-vapi-secret') ??
    req.headers.get('X-Vapi-Secret') ??
    bearer ??
    '';
  if (provided !== expected) {
    return { ok: false, error: 'Invalid or missing auth header (expected x-vapi-secret or Authorization: Bearer)' };
  }
  return { ok: true };
}
