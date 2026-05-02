'use client';

// Cloudflare Turnstile widget — invisible (mostly) CAPTCHA.
//
// ENV-GATED: when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset, this
// component renders nothing — the parent form submits without a
// Turnstile token, and the server-side verifier (lib/security/
// turnstile.ts) soft-allows the request because TURNSTILE_SECRET_KEY
// is also unset. This means local dev / preview deploys / staging
// run frictionless without any Turnstile setup.
//
// Production must set BOTH env vars for the protection to fire.
//
// Loading the script lazily via <Script strategy="lazyOnload"> means
// it doesn't block LCP — Turnstile's challenge.js is ~25KB and is
// only needed at form-submit time, not at page-load.

import { useEffect, useRef } from 'react';
import Script from 'next/script';

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
          size?: 'normal' | 'compact' | 'invisible';
          appearance?: 'always' | 'execute' | 'interaction-only';
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

type Props = {
  /** Called whenever Turnstile produces a fresh token (or empties it). */
  onTokenChange: (token: string) => void;
  /**
   * Optional: force the visible-checkbox style instead of the
   * mostly-invisible default. Useful for forms where the user already
   * sees a "Submitting…" state and an extra "I am human" checkbox is
   * not surprising. Default: 'interaction-only' (visible only on
   * suspicious sessions, invisible otherwise).
   */
  appearance?: 'always' | 'interaction-only';
};

export function TurnstileWidget({
  onTokenChange,
  appearance = 'interaction-only',
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenChangeRef = useRef(onTokenChange);
  // Keep the callback ref stable so render() doesn't have to re-run
  // when the parent re-renders. Turnstile's render is idempotent but
  // the cost is real (~10-50ms).
  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey) return;
    if (!containerRef.current) return;
    if (widgetIdRef.current) return; // Already rendered.

    // Wait for window.turnstile to load. The Script tag below is
    // lazyOnload so on a slow connection it might not exist yet at
    // first paint.
    let cancelled = false;
    const tryRender = () => {
      if (cancelled) return;
      if (!window.turnstile) {
        setTimeout(tryRender, 100);
        return;
      }
      if (!containerRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        appearance,
        callback: (token: string) => onTokenChangeRef.current(token),
        'expired-callback': () => onTokenChangeRef.current(''),
        'error-callback': () => onTokenChangeRef.current(''),
      });
    };
    tryRender();

    return () => {
      cancelled = true;
      // Cleanup: drop the widget so a remount doesn't double-render.
      if (widgetIdRef.current && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Removal can throw if the script torn down first; safe to ignore.
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, appearance]);

  // Env-gated render — nothing in the DOM when not configured.
  if (!siteKey) return null;

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="lazyOnload"
      />
      <div ref={containerRef} className="my-3" />
    </>
  );
}
