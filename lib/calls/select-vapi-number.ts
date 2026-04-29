// Vapi phone-number selector.
//
// Picks an outbound caller-ID number per call, preferring numbers that
// match the destination's area code ("local presence" — the single
// biggest lever on pickup rate for cold outbound). Backed by the
// vapi_phone_numbers table + pick_vapi_number() RPC (migration 0007).
//
// Fallback ladder:
//   1. RPC returns an area-code-matching active number   → tier='area_code'
//   2. RPC returns any active number                     → tier='any'
//   3. RPC returned nothing OR Supabase unreachable      → env var fallback (tier='env_fallback')
//   4. Env var also unset                                → { ok: false }
//
// Backward compat: current deployments with a single VAPI_PHONE_NUMBER_ID
// and an empty pool table get tier='env_fallback' and keep working with
// zero behaviour change. The pool is additive — insert rows when ready.

import { createAdminClient } from '@/lib/supabase/admin';
import { createLogger } from '@/lib/logger';
import { captureException } from '@/lib/observability/sentry';

const log = createLogger('vapi-pool');

/** Default per-number daily cap. Matches the DB function default. */
export const DEFAULT_DAILY_CAP = 75;

export type PickTier = 'area_code' | 'any' | 'env_fallback';

/**
 * Canonical Sentry tag values for capture sites in this file. Adding
 * a new reason here MUST coincide with a matching capture site — the
 * regression-guard test in select-vapi-number.test.ts asserts only
 * these literals ever reach Sentry from this lib.
 *
 * Rationale for capture vs. log-only:
 *   • `pickRpcErrored`, `pickRpcThrew` — ops signal. Pool is the
 *     primary lever for pickup rate; silent degradation to env fallback
 *     means ALL outbound calls lose area-code matching until someone
 *     notices pickup rates dropped in the admin dashboard. Captured.
 *   • Empty-data path (RPC returned [], pool just hasn't been populated)
 *     is NOT captured — that's a config state, not an incident. Same
 *     rationale as the R29 "config-state-no-capture" pattern.
 *   • Missing-env-entirely path is NOT captured — Sentry may not be
 *     initialized at that point and it's a deploy-time config issue.
 */
export type PickVapiNumberReason = 'pickRpcErrored' | 'pickRpcThrew';

export type PickResult =
  | {
      ok: true;
      phoneNumberId: string;
      tier: PickTier;
      /** Present for pool picks; omitted for env_fallback. */
      twilioE164?: string;
      /** Present for pool picks; omitted for env_fallback. */
      areaCode?: string;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * Extract the 3-digit NANP area code from a US E.164 number.
 *
 * Accepts exactly "+1" + 10 digits with a valid area-code prefix
 * (first digit 2-9 — NANP rules; area codes never start with 0 or 1).
 * Returns null for anything else so the caller can skip tier-1 and go
 * straight to any-active selection.
 */
export function extractAreaCode(e164: string): string | null {
  if (typeof e164 !== 'string') return null;
  if (!/^\+1[2-9]\d{9}$/.test(e164)) return null;
  return e164.slice(2, 5);
}

/**
 * Pick a Vapi phoneNumberId for dispatching a call to `toPhoneE164`.
 *
 * Does NOT throw. Transport errors (Supabase down, RPC failure) are
 * logged and degraded to the env-var fallback so a pool outage can't
 * halt dispatch entirely.
 */
export async function pickVapiNumber(toPhoneE164: string): Promise<PickResult> {
  const areaCode = extractAreaCode(toPhoneE164);

  // The RPC handles tier-1 (area match) and tier-2 (any active)
  // internally. We only skip the RPC entirely if Supabase env is
  // missing — otherwise we always give the pool a chance, even for
  // non-US numbers (tier-2 will still match).
  const haveSupabase =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (haveSupabase) {
    try {
      const admin = createAdminClient();
      // Non-US numbers pass an empty area code. Tier 1 never matches
      // (area_code is NOT NULL and always 3 digits in the table), so
      // the RPC falls through to tier 2 as desired.
      const { data, error } = await admin.rpc('pick_vapi_number', {
        p_area_code: areaCode ?? '',
      });

      if (error) {
        log.warn('pick_vapi_number rpc failed; falling back to env', {
          err: error.message,
        });
        // Capture at lib boundary. Pool is additive — single-number
        // deploys will never hit this path. A deployment WITH a
        // populated pool that starts seeing this error means every
        // outbound call is losing area-code matching (~30-50% pickup
        // hit in practice). We don't want to find out from pickup
        // dashboards two weeks later.
        //
        // PII guardrail: the tag bag carries only { lib, reason }. The
        // destination phone, area code, and RPC payload are all kept
        // out of Sentry. The wrapped message uses a controlled prefix
        // so Sentry fingerprints stably across RPC error-text drift.
        const wrapped = new Error(
          `pickVapiNumber rpc errored: ${error.message}`
        );
        captureException(wrapped, {
          tags: { lib: 'vapi-pool', reason: 'pickRpcErrored' },
        });
      } else if (Array.isArray(data) && data.length > 0) {
        const row = data[0] as {
          id: string;
          twilio_e164: string;
          area_code: string;
          tier: string;
        };
        // Sanity-check the tier value — the RPC is the source of truth
        // but a schema drift shouldn't crash dispatch.
        const tier: PickTier = row.tier === 'area_code' ? 'area_code' : 'any';
        return {
          ok: true,
          phoneNumberId: row.id,
          tier,
          twilioE164: row.twilio_e164,
          areaCode: row.area_code,
        };
      }
      // Empty data → fall through to env var.
    } catch (err) {
      log.warn('pick_vapi_number threw; falling back to env', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Distinct reason from pickRpcErrored. The RPC transport
      // exploded (ECONNRESET, Supabase fetch() rejected, etc.) —
      // different root cause, different dashboards. Keeping the two
      // reasons separate means a Supabase-wide outage surfaces as a
      // single Sentry issue distinct from RPC permission/drift errors.
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`pickVapiNumber rpc threw: ${message}`);
      captureException(wrapped, {
        tags: { lib: 'vapi-pool', reason: 'pickRpcThrew' },
      });
    }
  }

  // Env-var fallback. Keeps single-number deployments working without
  // changing anything when the pool table is empty.
  const envId = process.env.VAPI_PHONE_NUMBER_ID;
  if (envId) {
    return { ok: true, phoneNumberId: envId, tier: 'env_fallback' };
  }

  return {
    ok: false,
    reason: 'no pool entries and VAPI_PHONE_NUMBER_ID unset',
  };
}
