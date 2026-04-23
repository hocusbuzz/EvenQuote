// Tests for lib/auth.ts — the tiered helper suite used by server
// components and server actions to gate access. Three things matter:
//   1. getUser/getProfile return the expected shapes (or null).
//   2. requireUser redirects to /login (and preserves ?next) when there's
//      no session. This is defense-in-depth against bypass paths that
//      skip middleware.
//   3. requireAdmin redirects away from admin surfaces when the role
//      isn't 'admin' — and crucially redirects to '/' (a 404-ish UX) so
//      we don't confirm the admin surface exists.
//
// We mock both next/navigation (to capture redirect) and
// @/lib/supabase/server (to return a controllable client).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// redirect() in Next's real implementation throws a sentinel error so
// the caller stops executing. Mirror that here so code after a redirect
// call doesn't run.
const redirectSpy = vi.fn((url: string): never => {
  throw new Error(`__REDIRECT__ ${url}`);
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectSpy(url),
}));

// Client factory — each test rebinds `clientImpl` to shape the response.
type MockClient = {
  auth: { getUser: () => Promise<{ data: { user: unknown } }> };
  from: (table: string) => unknown;
};
let clientImpl: () => MockClient = () => ({
  auth: { getUser: async () => ({ data: { user: null } }) },
  from: () => {
    throw new Error('unexpected .from() — no user in default client');
  },
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => clientImpl(),
}));

// Import under test AFTER mocks register.
import { getUser, getProfile, requireUser, requireAdmin, type Profile } from './auth';

// ─── Fixtures ─────────────────────────────────────────────────────────

function userFixture(overrides: Record<string, unknown> = {}) {
  return { id: 'user_1', email: 'alex@example.com', ...overrides };
}

function profileFixture(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'user_1',
    email: 'alex@example.com',
    full_name: 'Alex',
    phone: null,
    role: 'customer',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Build a client that returns a specific user and a specific profile
// row from .from('profiles').select().eq().single().
function clientWith(opts: {
  user: unknown;
  profile?: Profile | null;
  profileError?: { message: string } | null;
}): MockClient {
  return {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    from: (table: string) => {
      if (table !== 'profiles') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: opts.profile ?? null,
              error: opts.profileError ?? null,
            }),
          }),
        }),
      };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('getUser', () => {
  beforeEach(() => {
    redirectSpy.mockClear();
  });

  it('returns null when no session', async () => {
    clientImpl = () => clientWith({ user: null });
    const user = await getUser();
    expect(user).toBeNull();
  });

  it('returns the user when session exists', async () => {
    const u = userFixture();
    clientImpl = () => clientWith({ user: u });
    const user = await getUser();
    expect(user).toEqual(u);
  });
});

describe('getProfile', () => {
  beforeEach(() => {
    redirectSpy.mockClear();
  });

  it('returns null when no session', async () => {
    clientImpl = () => clientWith({ user: null });
    const profile = await getProfile();
    expect(profile).toBeNull();
  });

  it('returns the profile row for the authed user', async () => {
    const p = profileFixture();
    clientImpl = () => clientWith({ user: userFixture(), profile: p });
    const profile = await getProfile();
    expect(profile).toEqual(p);
  });

  it('returns null (not throw) when profile lookup errors', async () => {
    clientImpl = () =>
      clientWith({
        user: userFixture(),
        profile: null,
        profileError: { message: 'RLS denied' },
      });
    const profile = await getProfile();
    // Callers are expected to handle null — log channel carries the error.
    expect(profile).toBeNull();
  });
});

describe('requireUser', () => {
  beforeEach(() => {
    redirectSpy.mockClear();
  });

  it('redirects to /login when no session', async () => {
    clientImpl = () => clientWith({ user: null });
    await expect(requireUser()).rejects.toThrow(/__REDIRECT__ \/login$/);
    expect(redirectSpy).toHaveBeenCalledWith('/login');
  });

  it('redirects to /login?next=<encoded> when redirectTo provided', async () => {
    clientImpl = () => clientWith({ user: null });
    await expect(requireUser('/dashboard/requests/abc')).rejects.toThrow(
      /__REDIRECT__ \/login\?next=/
    );
    expect(redirectSpy).toHaveBeenCalledWith(
      '/login?next=%2Fdashboard%2Frequests%2Fabc'
    );
  });

  it('returns the user when session exists (no redirect)', async () => {
    const u = userFixture();
    clientImpl = () => clientWith({ user: u });
    const result = await requireUser();
    expect(result).toEqual(u);
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});

describe('requireAdmin', () => {
  beforeEach(() => {
    redirectSpy.mockClear();
  });

  it('redirects to /login when no session (no profile to fetch)', async () => {
    clientImpl = () => clientWith({ user: null });
    await expect(requireAdmin()).rejects.toThrow(/__REDIRECT__ \/login/);
    expect(redirectSpy).toHaveBeenCalledWith('/login');
  });

  it("redirects to '/' (not 403) when role is 'customer' — don't confirm admin surface exists", async () => {
    clientImpl = () =>
      clientWith({
        user: userFixture(),
        profile: profileFixture({ role: 'customer' }),
      });
    await expect(requireAdmin()).rejects.toThrow(/__REDIRECT__ \/$/);
    expect(redirectSpy).toHaveBeenCalledWith('/');
  });

  it("returns the profile when role='admin'", async () => {
    const adminProfile = profileFixture({ role: 'admin' });
    clientImpl = () =>
      clientWith({
        user: userFixture(),
        profile: adminProfile,
      });
    const result = await requireAdmin();
    expect(result).toEqual(adminProfile);
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it('redirects to /login when profile lookup fails (treat as unauthenticated)', async () => {
    clientImpl = () =>
      clientWith({
        user: userFixture(),
        profile: null,
        profileError: { message: 'RLS' },
      });
    await expect(requireAdmin()).rejects.toThrow(/__REDIRECT__ \/login/);
    expect(redirectSpy).toHaveBeenCalledWith('/login');
  });
});
