// Tests for the auth server actions' rate limit + email validation paths.
//
// Strategy:
//   • Mock @/lib/supabase/server so we don't touch cookies/Next internals.
//   • Mock next/headers so clientKeyFromHeaders() has something to read.
//   • Each test manipulates env + rate-limiter state via vi.resetModules()
//     so buckets don't leak across cases.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory tracker for calls made on the fake supabase client, so tests
// can assert signInWithOtp was or wasn't invoked.
const state = { otpCalls: 0, oauthCalls: 0 };

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async (_args: unknown) => {
        state.otpCalls += 1;
        return { error: null };
      },
      signInWithOAuth: async (_args: unknown) => {
        state.oauthCalls += 1;
        return { data: { url: 'https://accounts.google.com/o/auth2' }, error: null };
      },
      signOut: async () => ({ error: null }),
    },
  }),
}));

// next/headers — signInWithMagicLink reads this for both getSiteUrl()
// and rate-limit keying. Use a distinct x-forwarded-for per test when we
// want separate buckets.
let headersMock = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: () => ({
    get: (name: string) => headersMock.get(name.toLowerCase()) ?? null,
  }),
}));

// next/navigation.redirect throws a NEXT_REDIRECT sentinel; we don't
// care about the throw itself, just that signInWithGoogle would call it.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

describe('signInWithMagicLink', () => {
  beforeEach(async () => {
    vi.resetModules();
    state.otpCalls = 0;
    state.oauthCalls = 0;
    headersMock = new Map([
      ['x-forwarded-for', `${Math.random()}`], // fresh IP per test
      ['host', 'localhost:3000'],
      ['x-forwarded-proto', 'http'],
    ]);
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED;
  });

  it('rejects an invalid email with a readable error', async () => {
    const { signInWithMagicLink } = await import('./auth');
    const fd = new FormData();
    fd.set('email', 'not-an-email');
    const res = await signInWithMagicLink(fd);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/valid email/i);
    expect(state.otpCalls).toBe(0);
  });

  it('returns ok:true on valid email', async () => {
    const { signInWithMagicLink } = await import('./auth');
    const fd = new FormData();
    fd.set('email', 'user@example.com');
    const res = await signInWithMagicLink(fd);
    expect(res).toEqual({ ok: true });
    expect(state.otpCalls).toBe(1);
  });

  it('rate-limits after 5 requests from the same IP', async () => {
    headersMock.set('x-forwarded-for', '198.51.100.7');
    const { signInWithMagicLink } = await import('./auth');
    for (let i = 0; i < 5; i++) {
      const fd = new FormData();
      fd.set('email', `u${i}@example.com`);
      const res = await signInWithMagicLink(fd);
      expect(res).toEqual({ ok: true });
    }
    const fd = new FormData();
    fd.set('email', 'u6@example.com');
    const blocked = await signInWithMagicLink(fd);
    expect('error' in blocked).toBe(true);
    if ('error' in blocked) expect(blocked.error).toMatch(/too many/i);
    // Supabase should have been called exactly 5 times, not 6.
    expect(state.otpCalls).toBe(5);
  });
});

describe('signInWithGoogle', () => {
  beforeEach(() => {
    vi.resetModules();
    state.otpCalls = 0;
    state.oauthCalls = 0;
    headersMock = new Map([
      ['x-forwarded-for', `${Math.random()}`],
      ['host', 'localhost:3000'],
    ]);
    delete process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED;
  });

  it('refuses when NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED is not set', async () => {
    const { signInWithGoogle } = await import('./auth');
    const fd = new FormData();
    const res = await signInWithGoogle(fd);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/not enabled/i);
    expect(state.oauthCalls).toBe(0);
  });

  it('redirects to Google when OAuth is enabled', async () => {
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED = 'true';
    const { signInWithGoogle } = await import('./auth');
    const fd = new FormData();
    await expect(signInWithGoogle(fd)).rejects.toThrow(/NEXT_REDIRECT:/);
    expect(state.oauthCalls).toBe(1);
  });
});
