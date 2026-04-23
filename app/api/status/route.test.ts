import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Broaden the env type so writes to NODE_ENV-like readonly keys don't
// trip @types/node 20+'s literal union. Other test files in this repo
// use the same pattern.
const env = process.env as Record<string, string | undefined>;

// Stripe SDK must be mocked before the route file imports it (it does a
// dynamic import, so a top-level vi.mock is enough).
const mockCustomersList = vi.fn();
vi.mock('@/lib/stripe/server', () => ({
  getStripe: () => ({
    customers: { list: mockCustomersList },
  }),
}));

// fetch is the Vapi transport — stub globally.
const originalFetch = global.fetch;

// We import the module via dynamic import inside each test so module-level
// state (env reads) is fresh per test.
async function loadRoute() {
  const mod = await import('./route');
  return mod;
}

describe('/api/status — auth', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns 401 when no secret is provided', async () => {
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status');
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('returns 401 when secret is wrong', async () => {
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'nope' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('accepts Bearer <token> auth header', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete env.CRON_SECRET;
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'anything' },
    });
    const res = await GET(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/CRON_SECRET/);
  });
});

describe('/api/status — happy path', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('200 with both checks ok when integrations respond', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ stripe: 'ok', vapi: 'ok' });
    expect(body.errors).toBeUndefined();
    expect(typeof body.checked_at).toBe('string');
  });

  it('sends the Vapi bearer token exactly once', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    await GET(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer vapi_x',
    });
  });

  it('does not cache (no-store header set)', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('/api/status — degraded path', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('503 when Stripe fails with an Error', async () => {
    mockCustomersList.mockRejectedValue(new Error('invalid key'));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.stripe).toBe('fail');
    expect(body.checks.vapi).toBe('ok');
    expect(body.errors?.stripe).toBe('invalid key');
  });

  it('503 when Vapi returns non-2xx (short message preserved)', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.vapi).toBe('fail');
    expect(body.errors?.vapi).toBe('HTTP 401');
  });

  it('503 when both integrations fail', async () => {
    mockCustomersList.mockRejectedValue(new Error('boom'));
    global.fetch = vi.fn().mockRejectedValue(new Error('econnreset'));
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.errors?.stripe).toBe('boom');
    expect(body.errors?.vapi).toBe('econnreset');
  });

  it('truncates long error messages to 200 chars to avoid leaking payloads', async () => {
    const longMessage = 'x'.repeat(500);
    mockCustomersList.mockRejectedValue(new Error(longMessage));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.errors?.stripe.length).toBe(200);
  });
});

describe('/api/status — skip when unconfigured', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports skip for any integration missing an env var', async () => {
    delete env.STRIPE_SECRET_KEY;
    delete env.VAPI_API_KEY;
    // stripe/vapi must not be invoked — if they are, this fails
    const stripeSpy = vi.fn();
    const fetchSpy = vi.fn();
    mockCustomersList.mockImplementation(stripeSpy);
    global.fetch = fetchSpy;

    const { GET } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200); // skip ≠ fail
    const body = await res.json();
    expect(body.checks).toEqual({ stripe: 'skip', vapi: 'skip' });
    expect(stripeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('/api/status — POST mirror', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCustomersList.mockReset();
    env.CRON_SECRET = 'test-secret';
    env.STRIPE_SECRET_KEY = 'sk_test_x';
    env.VAPI_API_KEY = 'vapi_x';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POST returns the same shape as GET', async () => {
    mockCustomersList.mockResolvedValue({ data: [] });
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    const { POST } = await loadRoute();
    const req = new Request('http://localhost/api/status', {
      method: 'POST',
      headers: { 'x-cron-secret': 'test-secret' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
