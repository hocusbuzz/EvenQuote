// Tests for the CSP module.
//
// Three concerns:
//   1. buildCsp emits the directives we expect, with the nonce baked
//      into script-src exactly once.
//   2. generateNonce returns a non-empty, base64-y string and produces
//      different values on successive calls (entropy sanity check).
//   3. The env-flag helpers (isCspNonceEnabled, cspHeaderName) read
//      env correctly and default to "off / report-only".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildCsp,
  cspHeaderName,
  generateNonce,
  isCspNonceEnabled,
} from './csp';

const env = process.env as Record<string, string | undefined>;

describe('buildCsp', () => {
  const originalSupabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  afterEach(() => {
    if (originalSupabaseUrl === undefined) delete env.NEXT_PUBLIC_SUPABASE_URL;
    else env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
  });

  it('includes the nonce inside script-src exactly once', () => {
    const csp = buildCsp({ nonce: 'abc123' });
    expect(csp).toContain(`'nonce-abc123'`);
    // Critical: only ONE script-src directive — any duplicate would
    // make the second one a parse error in browsers and the first one
    // would silently win, so the nonce on the second one would be a
    // no-op without us noticing.
    const matches = csp.match(/script-src/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('uses strict-dynamic so nonced scripts can load their deps', () => {
    const csp = buildCsp({ nonce: 'n' });
    expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
  });

  it('blocks framing entirely (frame-ancestors none)', () => {
    expect(buildCsp({ nonce: 'n' })).toMatch(/frame-ancestors 'none'/);
  });

  it('allows form-action to Stripe checkout (we POST there)', () => {
    expect(buildCsp({ nonce: 'n' })).toMatch(
      /form-action 'self' https:\/\/checkout\.stripe\.com/
    );
  });

  it('whitelists Stripe + Supabase in connect-src', () => {
    env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdef.supabase.co';
    const csp = buildCsp({ nonce: 'n' });
    expect(csp).toMatch(/connect-src[^;]*https:\/\/abcdef\.supabase\.co/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.stripe\.com/);
  });

  it('falls back to *.supabase.co when NEXT_PUBLIC_SUPABASE_URL is absent', () => {
    delete env.NEXT_PUBLIC_SUPABASE_URL;
    const csp = buildCsp({ nonce: 'n' });
    expect(csp).toMatch(/connect-src[^;]*https:\/\/\*\.supabase\.co/);
  });

  it('falls back to *.supabase.co when NEXT_PUBLIC_SUPABASE_URL is malformed', () => {
    env.NEXT_PUBLIC_SUPABASE_URL = 'not-a-url';
    const csp = buildCsp({ nonce: 'n' });
    expect(csp).toMatch(/connect-src[^;]*https:\/\/\*\.supabase\.co/);
  });

  it('appends report-uri only when reportEndpoint is supplied', () => {
    expect(buildCsp({ nonce: 'n' })).not.toContain('report-uri');
    const withReport = buildCsp({ nonce: 'n', reportEndpoint: '/api/csp-report' });
    expect(withReport).toMatch(/report-uri \/api\/csp-report/);
  });

  it('emits the upgrade-insecure-requests directive', () => {
    expect(buildCsp({ nonce: 'n' })).toMatch(/upgrade-insecure-requests/);
  });
});

describe('generateNonce', () => {
  it('returns a non-empty string', () => {
    const n = generateNonce();
    expect(typeof n).toBe('string');
    expect(n.length).toBeGreaterThan(0);
  });

  it('returns different values on successive calls', () => {
    // Entropy sanity check — the same nonce twice would defeat CSP.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateNonce());
    expect(seen.size).toBe(50);
  });

  it('is safe to embed in a CSP header (no quote / semicolon characters)', () => {
    // base64 alphabet is [A-Za-z0-9+/=] — none of which can break a
    // CSP directive.
    const n = generateNonce();
    expect(n).not.toMatch(/['";\s]/);
  });
});

describe('isCspNonceEnabled', () => {
  const original = env.CSP_NONCE_ENABLED;
  beforeEach(() => {
    delete env.CSP_NONCE_ENABLED;
  });
  afterEach(() => {
    if (original === undefined) delete env.CSP_NONCE_ENABLED;
    else env.CSP_NONCE_ENABLED = original;
  });

  it('defaults to false (off)', () => {
    expect(isCspNonceEnabled()).toBe(false);
  });

  it('returns true when env is the string "true"', () => {
    env.CSP_NONCE_ENABLED = 'true';
    expect(isCspNonceEnabled()).toBe(true);
  });

  it('is case-insensitive', () => {
    env.CSP_NONCE_ENABLED = 'TRUE';
    expect(isCspNonceEnabled()).toBe(true);
    env.CSP_NONCE_ENABLED = 'TrUe';
    expect(isCspNonceEnabled()).toBe(true);
  });

  it('returns false for non-"true" values like "1" or "yes"', () => {
    env.CSP_NONCE_ENABLED = '1';
    expect(isCspNonceEnabled()).toBe(false);
    env.CSP_NONCE_ENABLED = 'yes';
    expect(isCspNonceEnabled()).toBe(false);
  });
});

describe('cspHeaderName', () => {
  const original = env.CSP_ENFORCE;
  beforeEach(() => {
    delete env.CSP_ENFORCE;
  });
  afterEach(() => {
    if (original === undefined) delete env.CSP_ENFORCE;
    else env.CSP_ENFORCE = original;
  });

  it('defaults to Report-Only (the safe rollout posture)', () => {
    expect(cspHeaderName()).toBe('Content-Security-Policy-Report-Only');
  });

  it('flips to enforcing when CSP_ENFORCE=true', () => {
    env.CSP_ENFORCE = 'true';
    expect(cspHeaderName()).toBe('Content-Security-Policy');
  });
});
