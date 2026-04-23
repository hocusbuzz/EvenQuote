import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import robots from './robots';

const env = process.env as Record<string, string | undefined>;

describe('robots', () => {
  beforeEach(() => {
    env.NEXT_PUBLIC_APP_URL = 'https://evenquote.com';
  });
  afterEach(() => {
    delete env.NEXT_PUBLIC_APP_URL;
  });

  it('allows root and declares the sitemap', () => {
    const r = robots();
    expect(r.sitemap).toBe('https://evenquote.com/sitemap.xml');
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const wildcard = rules.find((x) => x.userAgent === '*');
    expect(wildcard).toBeDefined();
    const allow = Array.isArray(wildcard!.allow) ? wildcard!.allow : [wildcard!.allow];
    expect(allow).toContain('/');
  });

  it('disallows gated and transactional paths', () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const wildcard = rules.find((x) => x.userAgent === '*')!;
    const disallow = wildcard.disallow;
    const list = Array.isArray(disallow) ? disallow : [disallow];

    const mustBeBlocked = [
      '/api/',
      '/auth/',
      '/dashboard',
      '/admin',
      '/get-quotes/checkout',
      '/get-quotes/success',
    ];
    for (const p of mustBeBlocked) {
      expect(list).toContain(p);
    }
  });

  it('respects NEXT_PUBLIC_APP_URL with trailing-slash stripping', () => {
    env.NEXT_PUBLIC_APP_URL = 'https://staging.evenquote.com/';
    const r = robots();
    expect(r.sitemap).toBe('https://staging.evenquote.com/sitemap.xml');
  });

  it('falls back to the canonical domain when env is unset', () => {
    delete env.NEXT_PUBLIC_APP_URL;
    const r = robots();
    expect(r.sitemap).toBe('https://evenquote.com/sitemap.xml');
  });
});
