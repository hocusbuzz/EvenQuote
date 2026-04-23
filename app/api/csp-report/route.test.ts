// Tests for /api/csp-report.
//
// Three concerns:
//   • Always returns 204 (browsers don't read the body).
//   • Accepts both `report-uri` and `report-to` body shapes.
//   • Surfaces a summary log line per violation; only logs the full
//     payload when LOG_FULL_CSP=true.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const env = process.env as Record<string, string | undefined>;

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function loadRoute() {
  return await import('./route');
}

function postJson(body: unknown) {
  return new Request('https://example.com/api/csp-report', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('/api/csp-report', () => {
  beforeEach(() => {
    vi.resetModules();
    warn.mockReset();
    delete env.LOG_FULL_CSP;
  });

  it('returns 204 for a valid report-uri payload', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson({
        'csp-report': {
          'document-uri': 'https://evenquote.com/login',
          'violated-directive': "script-src 'self'",
          'blocked-uri': 'https://attacker.example/bad.js',
        },
      })
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = warn.mock.calls[0];
    expect(msg).toBe('csp violation');
    expect(ctx.directive).toMatch(/script-src/);
    expect(ctx.blocked).toBe('attacker.example');
    expect(ctx.full).toBeUndefined();
  });

  it('accepts the report-to (array) body shape', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson([
        {
          type: 'csp-violation',
          body: {
            'document-uri': 'https://evenquote.com/dashboard',
            'effective-directive': 'style-src',
            'blocked-uri': 'inline',
          },
        },
      ])
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1].directive).toBe('style-src');
    // 'inline' is a keyword (not a URL) — should be passed through as-is.
    expect(warn.mock.calls[0][1].blocked).toBe('inline');
  });

  it('returns 204 silently for malformed JSON', async () => {
    const { POST } = await loadRoute();
    const res = await POST(postJson('not-json{{{'));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns 204 silently for unrecognised body shapes', async () => {
    const { POST } = await loadRoute();
    const res = await POST(postJson({ unrelated: 'shape' }));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs the full payload only when LOG_FULL_CSP=true', async () => {
    env.LOG_FULL_CSP = 'true';
    const { POST } = await loadRoute();
    const fullReport = {
      'document-uri': 'https://evenquote.com/x',
      'violated-directive': "img-src 'self'",
      'blocked-uri': 'https://tracker.example/p.gif',
      'source-file': 'https://evenquote.com/_next/static/chunks/app.js',
      'line-number': 42,
    };
    const res = await POST(postJson({ 'csp-report': fullReport }));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1].full).toEqual(fullReport);
  });

  it('coalesces multiple report-to entries into individual log lines', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson([
        { type: 'csp-violation', body: { 'violated-directive': 'a', 'blocked-uri': 'inline' } },
        { type: 'csp-violation', body: { 'violated-directive': 'b', 'blocked-uri': 'eval' } },
        // Filtered out — wrong type.
        { type: 'network-error', body: { foo: 'bar' } },
      ])
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('handles a non-URL blocked-uri ("eval") without throwing', async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      postJson({
        'csp-report': {
          'violated-directive': "script-src",
          'blocked-uri': 'eval',
        },
      })
    );
    expect(res.status).toBe(204);
    expect(warn.mock.calls[0][1].blocked).toBe('eval');
  });
});
