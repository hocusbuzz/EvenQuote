// Unit tests for the PURE helpers in scripts/smoke-webhook-preview.ts.
//
// Why tests on a smoke script: the helpers (parseArgs,
// computeTwilioSignature) and the Stripe / Vapi signing paths are
// entirely deterministic. If they drift, the smoke run against the
// preview deploy returns 401s that look like "the preview's webhook
// secret doesn't match" but actually reflect a bug in the script. A
// 30-second unit test catches that before you go hunting through
// Vercel logs.
//
// We do NOT exercise the network-hitting leg runners here — they'd
// require mocking fetch and the value-add is low (any 4xx/5xx from
// a real preview is self-evident). Leg runners are tested manually
// against a live preview (see route.test.ts siblings for the mocked
// equivalents).

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { parseArgs, computeTwilioSignature } from './smoke-webhook-preview';

describe('parseArgs', () => {
  it('returns defaults when no args are passed', () => {
    const opts = parseArgs(['node', 'smoke.ts']);
    expect(opts.only).toBeNull();
    expect(opts.retries).toBe(20);
    expect(opts.timeoutMs).toBe(15000);
    expect(opts.dryRun).toBe(false);
  });

  it('parses --only=stripe correctly', () => {
    const opts = parseArgs(['node', 'smoke.ts', '--only=stripe']);
    expect(opts.only).toBe('stripe');
  });

  it('parses --only=vapi and --only=twilio', () => {
    expect(parseArgs(['node', 'smoke.ts', '--only=vapi']).only).toBe('vapi');
    expect(parseArgs(['node', 'smoke.ts', '--only=twilio']).only).toBe('twilio');
  });

  it('parses --retries=N correctly', () => {
    const opts = parseArgs(['node', 'smoke.ts', '--retries=5']);
    expect(opts.retries).toBe(5);
  });

  it('parses --timeout-ms=N correctly', () => {
    const opts = parseArgs(['node', 'smoke.ts', '--timeout-ms=3000']);
    expect(opts.timeoutMs).toBe(3000);
  });

  it('parses --dry-run correctly', () => {
    const opts = parseArgs(['node', 'smoke.ts', '--dry-run']);
    expect(opts.dryRun).toBe(true);
  });

  it('parses a combination of flags', () => {
    const opts = parseArgs([
      'node',
      'smoke.ts',
      '--only=vapi',
      '--retries=1',
      '--dry-run',
    ]);
    expect(opts.only).toBe('vapi');
    expect(opts.retries).toBe(1);
    expect(opts.dryRun).toBe(true);
  });
});

describe('computeTwilioSignature', () => {
  // The algorithm must exactly match route.ts:
  //   HMAC-SHA1(token, url + sortedKeys.map(k => k + v).join(''))
  // If this drifts from the real route verifier, the smoke run would
  // fail with "signature invalid" even when the payload is correct.
  const url = 'https://example.com/api/twilio/sms';
  const token = 'authtoken_abc';

  it('matches the route-side HMAC for a single-param payload', () => {
    const params = new URLSearchParams();
    params.set('Body', 'hi');
    const expected = crypto
      .createHmac('sha1', token)
      .update(url + 'Body' + 'hi')
      .digest('base64');
    expect(computeTwilioSignature(url, params, token)).toBe(expected);
  });

  it('sorts keys alphabetically before concatenation', () => {
    const unsortedParams = new URLSearchParams();
    unsortedParams.set('Z', '1');
    unsortedParams.set('A', '2');
    // Expected: A concatenated first, then Z.
    const expected = crypto
      .createHmac('sha1', token)
      .update(url + 'A' + '2' + 'Z' + '1')
      .digest('base64');
    expect(computeTwilioSignature(url, unsortedParams, token)).toBe(expected);
  });

  it('differs when the token changes (signature is secret-dependent)', () => {
    const params = new URLSearchParams();
    params.set('Body', 'hi');
    const s1 = computeTwilioSignature(url, params, 'tok-a');
    const s2 = computeTwilioSignature(url, params, 'tok-b');
    expect(s1).not.toBe(s2);
  });

  it('differs when the URL changes (signature is target-dependent)', () => {
    const params = new URLSearchParams();
    params.set('Body', 'hi');
    const s1 = computeTwilioSignature('https://a.example.com', params, token);
    const s2 = computeTwilioSignature('https://b.example.com', params, token);
    expect(s1).not.toBe(s2);
  });

  it('handles empty params (base URL only)', () => {
    const params = new URLSearchParams();
    const expected = crypto.createHmac('sha1', token).update(url).digest('base64');
    expect(computeTwilioSignature(url, params, token)).toBe(expected);
  });
});
