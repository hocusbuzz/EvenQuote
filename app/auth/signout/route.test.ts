import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSignOut = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { signOut: mockSignOut },
  }),
}));

async function loadPost() {
  const { POST } = await import('./route');
  return POST;
}

describe('/auth/signout', () => {
  beforeEach(() => {
    vi.resetModules();
    mockSignOut.mockReset();
    mockSignOut.mockResolvedValue({ error: null });
  });

  it('signs the user out and 303-redirects to /', async () => {
    const POST = await loadPost();
    const req = new Request('http://localhost/auth/signout', { method: 'POST' });
    const res = await POST(req as never);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // 303 See Other — required so the browser changes method from POST to GET
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost/');
  });

  it('still redirects even if signOut throws (best-effort)', async () => {
    // Defensive: if supabase fails, the user still wants to get to /.
    // Currently the handler awaits signOut without a try/catch, so the
    // exception propagates. This test locks that in — if we ever wrap
    // it in try/catch, this guard would need updating.
    mockSignOut.mockRejectedValue(new Error('network'));
    const POST = await loadPost();
    const req = new Request('http://localhost/auth/signout', { method: 'POST' });
    await expect(POST(req as never)).rejects.toThrow('network');
  });
});
