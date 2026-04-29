import { describe, it, expect, beforeEach, vi } from 'vitest';

// Import lazily with vi.resetModules so env.ts's internal _cached
// module variable starts fresh per test.
async function freshImport() {
  vi.resetModules();
  return await import('./env');
}

const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.placeholder.sig',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.svc.placeholder.sig',
};

describe('validateServerEnv', () => {
  beforeEach(() => {
    // Clear known env keys so leak between tests is controlled.
    for (const key of Object.keys(REQUIRED)) delete process.env[key];
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.CRON_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.VAPI_API_KEY;
    delete process.env.VAPI_ASSISTANT_ID;
    delete process.env.VAPI_PHONE_NUMBER_ID;
    delete process.env.VAPI_WEBHOOK_SECRET;
    delete process.env.TEST_OVERRIDE_PHONE;
  });

  it('parses a valid development env', async () => {
    Object.assign(process.env, REQUIRED, { NODE_ENV: 'development' });
    const mod = await freshImport();
    const env = mod.validateServerEnv();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(REQUIRED.NEXT_PUBLIC_SUPABASE_URL);
  });

  it('throws on missing required Supabase vars', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    // no NEXT_PUBLIC_SUPABASE_URL
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/Invalid environment/);
  });

  it('throws on malformed URL', async () => {
    Object.assign(process.env, REQUIRED, {
      NEXT_PUBLIC_SUPABASE_URL: 'not-a-url',
      NODE_ENV: 'development',
    });
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/Invalid environment/);
  });

  it('requires production-only vars in production', async () => {
    Object.assign(process.env, REQUIRED, { NODE_ENV: 'production' });
    // intentionally no STRIPE_SECRET_KEY / CRON_SECRET etc.
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/Production env missing/);
  });

  it('accepts a complete production env', async () => {
    Object.assign(process.env, REQUIRED, {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_xxx',
      STRIPE_WEBHOOK_SECRET: 'whsec_xxx',
      CRON_SECRET: 'a-long-enough-secret-value',
      NEXT_PUBLIC_APP_URL: 'https://evenquote.com',
      // RESEND_* are prod-required as of the P1-2 fix — without them
      // sendEmail() silently returns simulated-success and callers (e.g.
      // release-contact, report dispatch) mark work as delivered even
      // though no mail went out.
      RESEND_API_KEY: 're_xxx',
      RESEND_FROM: 'no-reply@evenquote.com',
      // VAPI_* are prod-required as of R47.4 — without them
      // startOutboundCall() silently returns sim_* fake call ids and
      // the engine advances paid requests on synthetic data.
      VAPI_API_KEY: 'vapi-prod-key',
      VAPI_ASSISTANT_ID: 'asst_xxx',
      VAPI_PHONE_NUMBER_ID: 'pn_xxx',
      VAPI_WEBHOOK_SECRET: 'vapi-secret',
    });
    delete process.env.TEST_OVERRIDE_PHONE;
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).not.toThrow();
  });

  it('rejects production env that lists Vapi as missing', async () => {
    Object.assign(process.env, REQUIRED, {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_xxx',
      STRIPE_WEBHOOK_SECRET: 'whsec_xxx',
      CRON_SECRET: 'a-long-enough-secret-value',
      NEXT_PUBLIC_APP_URL: 'https://evenquote.com',
      RESEND_API_KEY: 're_xxx',
      RESEND_FROM: 'no-reply@evenquote.com',
      // VAPI_* deliberately omitted.
    });
    delete process.env.TEST_OVERRIDE_PHONE;
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/VAPI_API_KEY/);
  });

  it('refuses to boot when TEST_OVERRIDE_PHONE is set in production', async () => {
    Object.assign(process.env, REQUIRED, {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_xxx',
      STRIPE_WEBHOOK_SECRET: 'whsec_xxx',
      CRON_SECRET: 'a-long-enough-secret-value',
      NEXT_PUBLIC_APP_URL: 'https://evenquote.com',
      RESEND_API_KEY: 're_xxx',
      RESEND_FROM: 'no-reply@evenquote.com',
      VAPI_API_KEY: 'vapi-prod-key',
      VAPI_ASSISTANT_ID: 'asst_xxx',
      VAPI_PHONE_NUMBER_ID: 'pn_xxx',
      VAPI_WEBHOOK_SECRET: 'vapi-secret',
      TEST_OVERRIDE_PHONE: '+15555550100',
    });
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/TEST_OVERRIDE_PHONE/);
  });

  it('rejects a non-numeric CALL_BATCH_SIZE', async () => {
    Object.assign(process.env, REQUIRED, {
      NODE_ENV: 'development',
      CALL_BATCH_SIZE: 'seven',
    });
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/CALL_BATCH_SIZE/);
  });

  it('rejects an out-of-range CALL_BATCH_SIZE', async () => {
    Object.assign(process.env, REQUIRED, {
      NODE_ENV: 'development',
      CALL_BATCH_SIZE: '999',
    });
    const mod = await freshImport();
    expect(() => mod.validateServerEnv()).toThrow(/CALL_BATCH_SIZE/);
  });
});

describe('getCallBatchSize', () => {
  it('defaults to 10 when unset', async () => {
    delete process.env.CALL_BATCH_SIZE;
    const mod = await import('./env');
    expect(mod.getCallBatchSize()).toBe(10);
  });

  it('parses and floors a valid value', async () => {
    process.env.CALL_BATCH_SIZE = '7';
    const mod = await import('./env');
    expect(mod.getCallBatchSize()).toBe(7);
  });

  it('falls back to 10 on an unparseable runtime value', async () => {
    process.env.CALL_BATCH_SIZE = 'garbage';
    const mod = await import('./env');
    expect(mod.getCallBatchSize()).toBe(10);
  });
});

describe('featureReadiness', () => {
  it('reports everything off when no integrations are set', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.VAPI_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    const mod = await import('./env');
    const report = mod.featureReadiness();
    expect(report.stripe).toBe(false);
    expect(report.vapi).toBe(false);
    expect(report.resend).toBe(false);
    expect(report.anthropic).toBe(false);
    expect(report.placesIngest).toBe(false);
  });

  it('reports Stripe on only when BOTH secret and webhook secret are set', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live';
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { featureReadiness } = await import('./env');
    expect(featureReadiness().stripe).toBe(false);

    process.env.STRIPE_WEBHOOK_SECRET = 'whsec';
    const mod = await import('./env');
    expect(mod.featureReadiness().stripe).toBe(true);
  });
});
