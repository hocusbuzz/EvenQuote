// Minimal Vapi client — just the outbound-call endpoint we need.
//
// Feature-flagged: if VAPI_API_KEY isn't set we return a simulated
// response so the rest of the pipeline can run end-to-end in local dev
// without placing real calls. Look for `simulated: true` in the return
// shape to know which mode you're in.
//
// Docs: https://docs.vapi.ai/api-reference/calls/create

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
    console.log(
      `[vapi] simulated call to ${input.businessName} (${input.toPhone}) — vapiCallId=${fakeId}`
    );
    return {
      ok: true,
      vapiCallId: fakeId,
      simulated: true,
      reason: 'VAPI_* env vars not set; skipping real dispatch',
    };
  }

  const body = {
    phoneNumberId,
    assistantId,
    customer: {
      number: input.toPhone,
      name: input.businessName,
    },
    assistantOverrides: {
      variableValues: input.variableValues,
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
 * here. If the env isn't set we accept everything (dev mode) but log it.
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
    console.warn('[vapi webhook] VAPI_WEBHOOK_SECRET not set — accepting without verification');
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
