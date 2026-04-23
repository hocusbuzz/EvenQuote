import { describe, it, expect, beforeEach, vi } from 'vitest';

// Supabase server client is mocked. We need a handle to the
// exchangeCodeForSession spy so each test can assert on it.
const mockExchange = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: mockExchange },
  }),
}));

async function loadGet() {
  const { GET } = await import('./route');
  return GET;
}

function makeReq(path: string) {
  // NextRequest extends Request and accepts a URL in the constructor.
  // We use the plain Request type here — the handler only reads .url
  // so this is compatible at runtime.
  return new Request(`http://localhost${path}`) as unknown as Parameters<Awaited<ReturnType<typeof loadGet>>>[0];
}

describe('/auth/callback', () => {
  beforeEach(() => {
    vi.resetModules();
    mockExchange.mockReset();
  });

  it('redirects to /auth-code-error when no code is present', async () => {
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback'));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
    expect(loc).toContain('message=');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('redirects to /auth-code-error with provider error message', async () => {
    const GET = await loadGet();
    const res = await GET(
      makeReq('/auth/callback?error=access_denied&error_description=user%20declined')
    );
    expect(res.status).toBe(307);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
    // URLSearchParams round-trips "user declined" but spaces encode as '+'.
    // Use the URL API to decode rather than decodeURIComponent (which
    // does not decode '+').
    expect(new URL(loc).searchParams.get('message')).toBe('user declined');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('exchanges the code and redirects to /dashboard by default', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
    expect(mockExchange).toHaveBeenCalledWith('abc');
  });

  it('respects a safe ?next relative path', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc&next=%2Fdashboard%2Frequests%2F123'));
    expect(res.headers.get('location')).toBe('http://localhost/dashboard/requests/123');
  });

  it('rejects an absolute-URL ?next (open-redirect guard)', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    // Scheme-relative //evil.com/ — must NOT be followed
    const res = await GET(makeReq('/auth/callback?code=abc&next=%2F%2Fevil.com%2Fsteal'));
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
  });

  it('rejects a backslash in ?next (Windows-path trick)', async () => {
    mockExchange.mockResolvedValue({ error: null });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc&next=%2Fdash%5Cevil'));
    expect(res.headers.get('location')).toBe('http://localhost/dashboard');
  });

  it('redirects to /auth-code-error with message when exchange fails', async () => {
    mockExchange.mockResolvedValue({ error: { message: 'invalid code' } });
    const GET = await loadGet();
    const res = await GET(makeReq('/auth/callback?code=abc'));
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/auth-code-error');
    expect(new URL(loc).searchParams.get('message')).toBe('invalid code');
  });
});
