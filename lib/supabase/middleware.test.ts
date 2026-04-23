// Tests for lib/supabase/middleware.ts (updateSession).
//
// Coverage goals:
//   • Unauthenticated user hitting a protected path → redirect to /login
//     with ?next=<pathname>.
//   • Authenticated user hitting /login or /signup → redirect to /dashboard.
//   • Unprotected path with no user → pass-through (NextResponse.next).
//   • Nested protected path (/dashboard/requests/abc) → treated as protected.
//
// We stub @supabase/ssr's createServerClient so getUser() returns a
// configurable user (or null). No network, no cookies round-tripping.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

function makeReq(path: string): NextRequest {
  return new NextRequest(new Request(`https://example.com${path}`));
}

describe('updateSession (supabase/middleware)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon_test_key',
    };
  });

  it('redirects an unauthenticated user from /dashboard to /login?next=/dashboard', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: { getUser: async () => ({ data: { user: null } }) },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/dashboard'));
    expect(res.status).toBe(307); // Next's redirect
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    expect(loc).toContain('next=%2Fdashboard');
  });

  it('redirects an unauthenticated user from a nested /dashboard/* path with the full next= preserved', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: { getUser: async () => ({ data: { user: null } }) },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/dashboard/requests/abc-123'));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location');
    expect(loc).toContain('/login');
    // The full nested path must round-trip in the `next` query.
    expect(loc).toContain('next=%2Fdashboard%2Frequests%2Fabc-123');
  });

  it('redirects an unauthenticated user from /admin to /login', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: { getUser: async () => ({ data: { user: null } }) },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/admin/failed-calls'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('redirects an authenticated user away from /login to /dashboard', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: 'u1', email: 'x@y.com' } } }),
        },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/login'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/dashboard');
  });

  it('lets an authenticated user through to /dashboard', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: 'u1' } } }),
        },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/dashboard'));
    // Pass-through: no redirect, and the x-middleware-next marker is set.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('passes through public paths without a user', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: { getUser: async () => ({ data: { user: null } }) },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/'));
    // Not a protected path — we hand back the unmodified response.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not redirect a logged-in user visiting a public path', async () => {
    vi.doMock('@supabase/ssr', () => ({
      createServerClient: () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
      }),
    }));
    const { updateSession } = await import('./middleware');
    const res = await updateSession(makeReq('/get-quotes'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
