// Tests for lib/security/stripe-auth.
//
// The Stripe webhook is the single inbound write surface from Stripe
// that can insert a `payments` row with service-role privilege and
// advance a quote_request to 'paid'. Auth bypass → free $9.99 service.
// These tests cover:
//
//   • extractStripeSignature — header shape (only one variant,
//     unlike vapi/cron), missing-header branch.
//   • verifyStripeWebhook — the 500-on-missing-secret branch (fail
//     CLOSED), the 400-on-missing-signature branch, the 400-on-bad-
//     signature branch, and the happy path with a valid HMAC.
//
// We do NOT mock out Stripe's `constructEvent`. Using a real Stripe
// SDK instance + a real HMAC-SHA256 timestamp/signature string means
// we catch SDK-version drift at test time: if a future `stripe` major
// breaks the signing format, these tests fail loudly rather than
// silently.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyStripeWebhook,
  extractStripeSignature,
} from './stripe-auth';

// TS 5 + @types/node 20+ type NODE_ENV as a readonly literal union, so
// direct and bracket-with-literal assignment both fail `tsc --noEmit`.
// Route all env writes through this writable view.
const env = process.env as Record<string, string | undefined>;

/**
 * Build a Stripe-compatible `stripe-signature` header string for a
 * given raw body + secret. Matches the format constructEvent expects:
 *   `t=<unix>,v1=<hex-hmac-of(t.body)>`
 */
function signBody(rawBody: string, secret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${rawBody}`;
  const v1 = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('extractStripeSignature', () => {
  it('returns empty string when the header is absent', () => {
    const req = new Request('https://example.com/webhook', { method: 'POST' });
    expect(extractStripeSignature(req)).toBe('');
  });

  it('returns the header value verbatim when present', () => {
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=abc' },
    });
    expect(extractStripeSignature(req)).toBe('t=123,v1=abc');
  });

  it('does not fall back to Authorization: Bearer (unlike vapi)', () => {
    // Stripe's header spelling is exactly `stripe-signature`. We
    // intentionally do NOT accept Authorization as a fallback — it
    // would widen the auth surface for no benefit.
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { authorization: 'Bearer t=123,v1=abc' },
    });
    expect(extractStripeSignature(req)).toBe('');
  });
});

describe('verifyStripeWebhook', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET;
    saved.STRIPE_SECRET_KEY = env.STRIPE_SECRET_KEY;
    // getStripe requires STRIPE_SECRET_KEY; we only need the SDK
    // singleton for its `webhooks.constructEvent` helper, which does
    // not actually call the Stripe API — any non-empty key works.
    env.STRIPE_SECRET_KEY = 'sk_test_stripe_auth_tests_only';
  });

  afterEach(() => {
    if (saved.STRIPE_WEBHOOK_SECRET === undefined) delete env.STRIPE_WEBHOOK_SECRET;
    else env.STRIPE_WEBHOOK_SECRET = saved.STRIPE_WEBHOOK_SECRET;
    if (saved.STRIPE_SECRET_KEY === undefined) delete env.STRIPE_SECRET_KEY;
    else env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('returns 500 when STRIPE_WEBHOOK_SECRET is not configured (fail CLOSED)', async () => {
    delete env.STRIPE_WEBHOOK_SECRET;
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=abc' },
    });
    const result = await verifyStripeWebhook(req, '{}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe('Webhook misconfigured');
    }
  });

  it('returns 400 when the stripe-signature header is missing', async () => {
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_x';
    const req = new Request('https://example.com/webhook', { method: 'POST' });
    const result = await verifyStripeWebhook(req, '{}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain('Missing stripe-signature');
    }
  });

  it('returns 400 when the signature does not match the body', async () => {
    env.STRIPE_WEBHOOK_SECRET = 'whsec_correct_secret';
    const raw = '{"id":"evt_1","type":"checkout.session.completed"}';
    // Sign with a DIFFERENT secret — must fail HMAC verify.
    const bogus = signBody(raw, 'whsec_wrong_secret');
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': bogus },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Invalid signature/);
    }
  });

  it('returns 400 when the signed body does not match the passed rawBody', async () => {
    // This is the classic "parse before verify" foot-gun. If the
    // caller JSON.parses and re-stringifies, the body bytes differ
    // from what was signed → HMAC fails. We simulate by signing a
    // different body than we pass to verify.
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const signedRaw = '{"id":"evt_1"}';
    const differentRaw = '{"id": "evt_1"}'; // extra space
    const sig = signBody(signedRaw, 'whsec_test');
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
    });
    const result = await verifyStripeWebhook(req, differentRaw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it('returns the parsed Stripe.Event on valid signature', async () => {
    env.STRIPE_WEBHOOK_SECRET = 'whsec_test_happy';
    const raw = JSON.stringify({
      id: 'evt_test_happy',
      object: 'event',
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      api_version: '2025-02-24.acacia',
      data: { object: { id: 'cs_test_123' } },
    });
    const sig = signBody(raw, 'whsec_test_happy');
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': sig },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe('evt_test_happy');
      expect(result.event.type).toBe('checkout.session.completed');
    }
  });

  // ── R27: auth-failure-mode expansion ──────────────────────────────
  //
  // Round 26's suggested punchlist (e). Prior rounds covered the
  // "missing secret / missing header / bad HMAC" baseline. The gaps
  // below are attacker-reachable states the SDK rejects but we had
  // not explicitly locked:
  //
  //   • Malformed timestamp — header present but `t=` value is
  //     non-numeric. Stripe SDK throws a distinct error; we route it
  //     to 400.
  //   • Replayed signature with old timestamp — a signature correctly
  //     HMAC'd over (t.body) but with `t` more than the default 300s
  //     tolerance in the past. Stripe SDK rejects these to limit the
  //     replay window. Without this test, a future migration to
  //     `constructEventAsync` with a long tolerance would silently
  //     widen the replay surface.
  //   • Header present but structurally malformed (no `v1=` part) —
  //     covers the case where a proxy strips half the comma-separated
  //     pairs.
  //   • Unicode / binary in the header — defensive check that we
  //     don't crash the SDK with non-string or non-ASCII content,
  //     which would surface as a 500 instead of a 400.
  //
  // All failure paths MUST route to 400 (not 500), matching the
  // "stop Stripe's retry loop on tampered input" contract.

  it('returns 400 when the signature header has a malformed timestamp (non-numeric t=)', async () => {
    env.STRIPE_WEBHOOK_SECRET = 'whsec_malformed_ts';
    const raw = '{"id":"evt_malformed_ts"}';
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: {
        'stripe-signature': 't=not-a-number,v1=deadbeef0123456789',
      },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must be 400 — attacker-controlled input. 500 here would turn
      // into a retry storm from Stripe.
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Invalid signature/);
    }
  });

  it('returns 400 when the signature timestamp is outside the tolerance window (replay guard)', async () => {
    // Stripe SDK default tolerance is 300 seconds. A signature with a
    // timestamp 1 hour in the past is a classic replay attempt — an
    // attacker who captured a signed webhook body in flight and tries
    // to redeliver it must be rejected.
    env.STRIPE_WEBHOOK_SECRET = 'whsec_replay_guard';
    const raw = JSON.stringify({
      id: 'evt_replay',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_replay' } },
    });
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    // The signature itself is CRYPTOGRAPHICALLY VALID — HMAC over the
    // body + stale timestamp. Only the timestamp is out-of-tolerance.
    // This is the exact shape of a replay attack, not a tampering
    // attempt.
    const staleSig = signBody(raw, 'whsec_replay_guard', oneHourAgo);
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': staleSig },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Invalid signature/);
    }
  });

  it('returns 400 when the signature header is structurally malformed (no v1= part)', async () => {
    // A proxy or mis-written fetch could strip the `v1=<hex>` pair.
    // Stripe SDK throws "No signatures found matching the expected
    // signature for payload" — we map to 400.
    env.STRIPE_WEBHOOK_SECRET = 'whsec_structural';
    const raw = '{"id":"evt_structural"}';
    const t = Math.floor(Date.now() / 1000);
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      // Only the timestamp pair, no v1= signature.
      headers: { 'stripe-signature': `t=${t}` },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Invalid signature/);
    }
  });

  it('returns 400 when the signature hex is truncated (not a full HMAC-SHA256 digest)', async () => {
    // An attacker who only has partial hex bytes (e.g. from a leaky
    // log) cannot forge a full signature — but the SDK must reject
    // the short value without throwing an unhandled exception.
    env.STRIPE_WEBHOOK_SECRET = 'whsec_truncated';
    const raw = '{"id":"evt_truncated"}';
    const t = Math.floor(Date.now() / 1000);
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      // Only 8 hex chars instead of 64.
      headers: { 'stripe-signature': `t=${t},v1=deadbeef` },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it('returns 400 when the signature header is a random non-stripe string', async () => {
    // Defensive: the helper must reject even a header that does not
    // match the `t=...,v1=...` shape at all (e.g. a copy-pasted JWT
    // or OAuth bearer token). Must never surface 500 — would retry-storm.
    env.STRIPE_WEBHOOK_SECRET = 'whsec_gibberish';
    const raw = '{"id":"evt_gibberish"}';
    const req = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'Bearer eyJhbGci.garbage.whatever' },
    });
    const result = await verifyStripeWebhook(req, raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Contract: attacker-reachable → 400, not 500.
      expect(result.status).toBe(400);
    }
  });
});
