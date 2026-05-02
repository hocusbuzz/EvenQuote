// Tests for the /auth/verify proxy route.
//
// Locks the contract:
//   • 302 redirect to <NEXT_PUBLIC_SUPABASE_URL>/auth/v1/verify
//   • Query string is preserved verbatim (token + type + redirect_to
//     + any future Supabase-added params)
//   • Misconfigured deploy returns 500 with a clear message rather
//     than silently breaking auth
//   • The supabase-host destination is hardcoded from env, NOT
//     attacker-supplied — guards against the obvious open-redirect
//     hijack vector

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const origSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

async function loadGet() {
  const { GET } = await import('./route');
  return GET;
}

function makeReq(path: string) {
  return new Request(`http://localhost${path}`) as unknown as Parameters<
    Awaited<ReturnType<typeof loadGet>>
  >[0];
}

describe('/auth/verify proxy', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  });
  afterEach(() => {
    if (origSupabaseUrl !== undefined) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = origSupabaseUrl;
    }
  });

  it('302-redirects to <supabase-host>/auth/v1/verify with the same query string', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdef.supabase.co';
    const GET = await loadGet();
    const res = await GET(
      makeReq(
        '/auth/verify?token=tok123&type=magiclink&redirect_to=' +
          encodeURIComponent('https://evenquote.com/auth/callback?next=/dashboard'),
      ),
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://abcdef.supabase.co/auth/v1/verify?')).toBe(true);
    // Verify the upstream URL keeps every original query param intact.
    const upstream = new URL(loc);
    expect(upstream.searchParams.get('token')).toBe('tok123');
    expect(upstream.searchParams.get('type')).toBe('magiclink');
    expect(upstream.searchParams.get('redirect_to')).toBe(
      'https://evenquote.com/auth/callback?next=/dashboard',
    );
  });

  it('returns 500 when NEXT_PUBLIC_SUPABASE_URL is unset (misconfigured deploy)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/verify?token=tok123&type=magiclink'));
    expect(res.status).toBe(500);
  });

  it('preserves an empty query string (degenerate but should not crash)', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdef.supabase.co';
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/verify'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://abcdef.supabase.co/auth/v1/verify',
    );
  });

  it('open-redirect guard: cannot be tricked into pointing at another host via query param', async () => {
    // Defensive: even if the user sends `?supabase_host=evil.com`, the
    // upstream URL is built from env, not the request. Lock the
    // invariant.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdef.supabase.co';
    const GET = await loadGet();
    const res = await GET(
      makeReq('/auth/verify?token=tok123&supabase_host=evil.com&host=evil.com'),
    );
    const loc = res.headers.get('location')!;
    // The HOST is what matters for the open-redirect class. Even if
    // decoy query params get echoed (Supabase will ignore them
    // upstream), the destination host stays under our control.
    expect(new URL(loc).host).toBe('abcdef.supabase.co');
    expect(loc).toContain('supabase_host=evil.com');
  });

  it('handles a trailing-slash supabase URL gracefully', async () => {
    // URL constructor normalizes — locking we don't break.
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdef.supabase.co/';
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/verify?token=tok123'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://abcdef.supabase.co/auth/v1/verify?token=tok123',
    );
  });
});
