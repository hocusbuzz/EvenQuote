'use client';

// Mount-once client component that reads utm_* params from the current
// URL and writes them into the persisted UTMs store.
//
// Renders nothing — this is pure side-effect plumbing. Mount it on
// /get-quotes (the picker) and /get-quotes/[category] (the per-vertical
// landing) so any landing path captures UTMs before the user starts
// the form.
//
// useSearchParams forces a Suspense boundary in some Next configs;
// the default export wraps in Suspense for safety so the host page
// doesn't have to.
//
// Why useEffect not useLayoutEffect: this isn't visual; we only need
// the write to happen before the user clicks "next" on the first form
// step (≥100ms in human time). useEffect is enough and avoids the
// SSR warning that useLayoutEffect generates.

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseUtmsFromSearchParams } from '@/lib/marketing/utms';
import { useUtmsStore } from '@/lib/marketing/utms-store';

function UtmCaptureInner() {
  const searchParams = useSearchParams();
  const captureFromUrl = useUtmsStore((s) => s.captureFromUrl);

  useEffect(() => {
    if (!searchParams) return;
    const incoming = parseUtmsFromSearchParams(searchParams);
    captureFromUrl(incoming);
  }, [searchParams, captureFromUrl]);

  return null;
}

export function UtmCapture() {
  return (
    <Suspense fallback={null}>
      <UtmCaptureInner />
    </Suspense>
  );
}
