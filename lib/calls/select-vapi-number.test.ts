// Tests for the Vapi phone-number selector.
//
// The selector sits between startOutboundCall() and the Supabase RPC
// pick_vapi_number(). It's the single code path that decides which
// caller-ID number we dial from, so coverage matters:
//
//   • extractAreaCode — input parser; malformed inputs must NOT throw.
//   • pickVapiNumber — has four observable modes (pool hit area, pool
//     hit any, empty pool → env fallback, all missing → error) plus
//     two degradation modes (RPC error, Supabase env missing). Each is
//     a separate test.
//
// Mocking strategy:
//   • @/lib/supabase/admin is vi.mock'd so the rpc() return value is
//     controlled per-test. That's the only I/O boundary here — the rest
//     is pure logic on env vars + the RPC result shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the admin client BEFORE importing the module under test so the
// import resolves the mocked createAdminClient.
const rpcMock = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    rpc: rpcMock,
  })),
}));

// R31 capture-audit: a Sentry capture at the lib boundary now fires
// when the pool RPC errors or throws. Mock the observability module
// so per-test assertions can check tag shape, and the regression
// guard can lock the reason allow-list.
//
// Wrapper-via-closure pattern matches lib/calls/engine.test.ts — vi.mock
// hoists above module-level declarations, so the factory must capture
// the spy by reference inside a function body that only runs when the
// mocked captureException is actually called (at which point the
// top-level const has been initialized).
const captureExceptionSpy = vi.fn();
vi.mock('@/lib/observability/sentry', () => ({
  captureException: (err: unknown, ctx?: unknown) =>
    captureExceptionSpy(err, ctx),
}));

import {
  extractAreaCode,
  pickVapiNumber,
  DEFAULT_DAILY_CAP,
} from './select-vapi-number';

// Writable view over process.env — NODE_ENV et al are readonly under
// strict TS 5, and the mutation happens in this file only during tests.
const env = process.env as Record<string, string | undefined>;

const ENV_KEYS = [
  'VAPI_PHONE_NUMBER_ID',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

describe('extractAreaCode', () => {
  it('extracts the 3-digit area code from a valid US E.164 number', () => {
    expect(extractAreaCode('+14155551234')).toBe('415');
    expect(extractAreaCode('+16195551234')).toBe('619');
    expect(extractAreaCode('+12125551234')).toBe('212');
  });

  it('returns null for non-US numbers', () => {
    expect(extractAreaCode('+442071234567')).toBeNull();
    expect(extractAreaCode('+33123456789')).toBeNull();
  });

  it('returns null for NANP-invalid area codes (starting with 0 or 1)', () => {
    // NANP area codes never start with 0 or 1.
    expect(extractAreaCode('+10155551234')).toBeNull();
    expect(extractAreaCode('+11155551234')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(extractAreaCode('')).toBeNull();
    expect(extractAreaCode('4155551234')).toBeNull(); // missing +1
    expect(extractAreaCode('+1415555')).toBeNull(); // too short
    expect(extractAreaCode('+141555512345')).toBeNull(); // too long
    expect(extractAreaCode('+1-415-555-1234')).toBeNull(); // formatting chars
    // Non-strings should not throw — guarded by type check.
    expect(extractAreaCode(null as unknown as string)).toBeNull();
    expect(extractAreaCode(undefined as unknown as string)).toBeNull();
  });
});

describe('pickVapiNumber', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    rpcMock.mockReset();
    captureExceptionSpy.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function mockSupabaseEnv() {
    env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_key';
  }

  it('returns tier=area_code when the RPC finds a matching number', async () => {
    mockSupabaseEnv();
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'phone_area_match',
          twilio_e164: '+14155550100',
          area_code: '415',
          tier: 'area_code',
        },
      ],
      error: null,
    });

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe('area_code');
      expect(result.phoneNumberId).toBe('phone_area_match');
      expect(result.areaCode).toBe('415');
    }

    // Sanity-check the RPC got the right area code.
    expect(rpcMock).toHaveBeenCalledWith('pick_vapi_number', {
      p_area_code: '415',
    });
  });

  it('returns tier=any when the RPC falls through to the any-active tier', async () => {
    mockSupabaseEnv();
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'phone_any',
          twilio_e164: '+15105550100',
          area_code: '510',
          tier: 'any',
        },
      ],
      error: null,
    });

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe('any');
      expect(result.phoneNumberId).toBe('phone_any');
    }
  });

  it('passes an empty area code to the RPC for non-US destinations', async () => {
    mockSupabaseEnv();
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'phone_any',
          twilio_e164: '+15105550100',
          area_code: '510',
          tier: 'any',
        },
      ],
      error: null,
    });

    await pickVapiNumber('+442071234567'); // UK number
    expect(rpcMock).toHaveBeenCalledWith('pick_vapi_number', {
      p_area_code: '',
    });
  });

  it('falls back to VAPI_PHONE_NUMBER_ID env when the pool is empty', async () => {
    mockSupabaseEnv();
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback';
    rpcMock.mockResolvedValue({ data: [], error: null });

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe('env_fallback');
      expect(result.phoneNumberId).toBe('phone_env_fallback');
    }
  });

  it('falls back to env when the RPC returns an error (does not throw)', async () => {
    mockSupabaseEnv();
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback';
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe('env_fallback');
    }

    // R31 capture: pool RPC error is a load-bearing ops signal
    // (silent degradation kills pickup rate). Assert it fired with
    // the canonical tag shape.
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionSpy.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^pickVapiNumber rpc errored: /);
    expect(ctx.tags).toEqual({
      lib: 'vapi-pool',
      reason: 'pickRpcErrored',
    });
  });

  it('falls back to env when the RPC throws (Supabase outage)', async () => {
    mockSupabaseEnv();
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback';
    rpcMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tier).toBe('env_fallback');

    // R31 capture: distinct reason from pickRpcErrored — lets ops
    // tell "Supabase transport down" apart from "RPC returned an
    // error" on the dashboard.
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionSpy.mock.calls[0] as [
      Error,
      { tags: Record<string, string> },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^pickVapiNumber rpc threw: /);
    expect(ctx.tags).toEqual({
      lib: 'vapi-pool',
      reason: 'pickRpcThrew',
    });
  });

  it('does NOT capture on the happy path (tier=area_code)', async () => {
    // Sanity: the capture boundary must not fire during normal ops.
    // A regression that captures on every call would flood Sentry
    // at request frequency.
    mockSupabaseEnv();
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'phone_area_match',
          twilio_e164: '+14155550100',
          area_code: '415',
          tier: 'area_code',
        },
      ],
      error: null,
    });
    await pickVapiNumber('+14155551234');
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('does NOT capture when the pool is empty (config state, not incident)', async () => {
    // An empty pool means "pool hasn't been populated yet" — that is
    // the INTENDED state for single-number deploys. R29 introduced
    // the config-state-no-capture pattern; this test locks it for
    // the vapi-pool lib. If this regresses, Sentry floods on every
    // single-number deploy.
    mockSupabaseEnv();
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback';
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('does NOT capture when Supabase env is missing (deploy-time config)', async () => {
    // Same pattern as the empty-pool case. Missing Supabase env is a
    // deploy-time misconfiguration; capturing here would ALSO flood
    // if someone spun up a dev-local build without env.
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_only';
    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('PII guard: captured tags and wrapped message never contain phone or area code', async () => {
    // Lock the contract: capture bag must never carry the destination
    // phone number or area code, and the wrapped error message must
    // not leak either. If the RPC error message itself contains a
    // phone substring (unusual but possible for some DB error strings),
    // a future refactor might concat it into the wrapped prefix — this
    // test makes that visible.
    mockSupabaseEnv();
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback';
    rpcMock.mockResolvedValue({
      data: null,
      // Error message intentionally benign — we're locking that the
      // captured surface carries no caller-PII regardless of input.
      error: { message: 'permission denied for function pick_vapi_number' },
    });
    await pickVapiNumber('+14155551234');
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1);
    const [err, ctx] = captureExceptionSpy.mock.calls[0] as [
      Error,
      { tags: Record<string, unknown> },
    ];
    const surface = JSON.stringify({ msg: err.message, tags: ctx.tags });
    expect(surface).not.toContain('+14155551234');
    expect(surface).not.toContain('4155551234');
    expect(surface).not.toContain('415'); // area-code leak guard
    // Tag bag must not carry any PII-adjacent fields.
    expect(ctx.tags).not.toHaveProperty('phone');
    expect(ctx.tags).not.toHaveProperty('toPhone');
    expect(ctx.tags).not.toHaveProperty('areaCode');
  });

  it('regression guard: only allow-listed reasons ever reach Sentry', async () => {
    // Lock the PickVapiNumberReason allow-list. If a future refactor
    // adds a new capture site with a catch-all reason (e.g.
    // 'unknown' / 'rpcFailed' / 'poolError'), this test fails and
    // forces an update to the type + allow-list together.
    const LOCKED_REASONS = new Set(['pickRpcErrored', 'pickRpcThrew']);

    // Trigger BOTH capture sites to get two entries in the mock.
    mockSupabaseEnv();
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_fallback';

    rpcMock.mockResolvedValueOnce({
      data: null,
      error: { message: 'rpc-returned-error' },
    });
    await pickVapiNumber('+14155551234');

    rpcMock.mockRejectedValueOnce(new Error('transport-threw'));
    await pickVapiNumber('+14155551234');

    expect(captureExceptionSpy).toHaveBeenCalledTimes(2);
    for (const call of captureExceptionSpy.mock.calls) {
      const ctx = call[1] as { tags: { lib: string; reason: string } };
      expect(ctx.tags.lib).toBe('vapi-pool');
      expect(LOCKED_REASONS.has(ctx.tags.reason)).toBe(true);
      // Forbidden catch-all reasons from past refactors / guessable
      // drift candidates.
      expect(ctx.tags.reason).not.toBe('unknown');
      expect(ctx.tags.reason).not.toBe('error');
      expect(ctx.tags.reason).not.toBe('rpcFailed');
      expect(ctx.tags.reason).not.toBe('poolError');
      expect(ctx.tags.reason).not.toBe('fallback');
    }
  });

  it('skips the RPC entirely when Supabase env vars are missing', async () => {
    // No mockSupabaseEnv() — Supabase URL and key stay unset.
    env.VAPI_PHONE_NUMBER_ID = 'phone_env_only';

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tier).toBe('env_fallback');
    // Critical: we should NOT have called the RPC at all.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('returns ok:false when pool is empty AND env var is unset', async () => {
    mockSupabaseEnv();
    rpcMock.mockResolvedValue({ data: [], error: null });

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no pool entries/i);
    }
  });

  it('normalizes unknown tier values to "any" (schema drift guard)', async () => {
    mockSupabaseEnv();
    rpcMock.mockResolvedValue({
      data: [
        {
          id: 'phone_x',
          twilio_e164: '+14155550100',
          area_code: '415',
          tier: 'future_tier_that_does_not_exist',
        },
      ],
      error: null,
    });

    const result = await pickVapiNumber('+14155551234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Unknown tier collapses to 'any' rather than leaking the raw value.
      expect(result.tier).toBe('any');
    }
  });

  it('exports DEFAULT_DAILY_CAP matching the DB function default', () => {
    // Sanity check: if you change the DB default, update this and ship
    // the migration in the same PR. This test guards the drift.
    expect(DEFAULT_DAILY_CAP).toBe(75);
  });
});
