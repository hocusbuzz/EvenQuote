import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const env = process.env as Record<string, string | undefined>;

// Mock the admin supabase client. The sitemap late-imports it, so we
// need to declare the mock before each test that exercises it.
const mockEq = vi.fn();
const mockSelect = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ select: mockSelect }));
const mockCreateAdminClient = vi.fn(() => ({ from: mockFrom }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mockCreateAdminClient,
}));

describe('sitemap', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateAdminClient.mockClear();
    mockFrom.mockClear();
    mockSelect.mockClear();
    mockEq.mockReset();
    env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
  });

  afterEach(() => {
    delete env.NEXT_PUBLIC_APP_URL;
  });

  it('includes / and /get-quotes even when the DB returns no categories', async () => {
    mockEq.mockResolvedValue({ data: [] });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://evenquote.com/');
    expect(urls).toContain('https://evenquote.com/get-quotes');
  });

  it('adds one dynamic entry per active service category', async () => {
    mockEq.mockResolvedValue({
      data: [
        { slug: 'moving', updated_at: '2026-01-01T00:00:00Z' },
        { slug: 'cleaning', updated_at: '2026-02-01T00:00:00Z' },
      ],
    });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://evenquote.com/get-quotes/moving');
    expect(urls).toContain('https://evenquote.com/get-quotes/cleaning');
  });

  it('filters to is_active categories only (delegates to Supabase .eq)', async () => {
    mockEq.mockResolvedValue({ data: [] });
    const sitemap = (await import('./sitemap')).default;
    await sitemap();
    expect(mockEq).toHaveBeenCalledWith('is_active', true);
  });

  it('falls back to static-only sitemap when the DB throws', async () => {
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error('unreachable');
    });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    // Only the two STATIC_ENTRIES should remain.
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.url)).toEqual([
      'https://evenquote.com/',
      'https://evenquote.com/get-quotes',
    ]);
  });

  it('does NOT include gated routes (regression guard)', async () => {
    mockEq.mockResolvedValue({ data: [{ slug: 'moving', updated_at: null }] });
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    for (const forbidden of [
      '/dashboard',
      '/admin',
      '/get-quotes/checkout',
      '/get-quotes/success',
      '/api/',
      '/auth/',
      '/legal/privacy',
      '/legal/terms',
    ]) {
      expect(urls.some((u) => u.includes(forbidden))).toBe(false);
    }
  });

  it('respects NEXT_PUBLIC_APP_URL override with trailing-slash stripping', async () => {
    env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    mockEq.mockResolvedValue({ data: [] });
    vi.resetModules();
    const sitemap = (await import('./sitemap')).default;
    const entries = await sitemap();
    // Exactly one slash after the host, never two
    for (const e of entries) {
      expect(e.url).not.toMatch(/https:\/\/[^/]+\/\//);
    }
    expect(entries[0].url).toBe('https://staging.evenquote.com/');
  });
});
