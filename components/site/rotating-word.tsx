// Rotating word for the hero headline.
//
// Cycles through the vertical nouns (movers → cleaners → handymen → lawn
// crews) with a stamp-in reveal on each swap. The lime highlight box
// hugs each word's natural width — "movers." is narrow, "lawn crews."
// is wide, and the box transitions smoothly between them. No invisible
// max-width "probe" is held behind the scenes: the layout on the line
// below the headline is allowed to shift as the lime expands/contracts.
// Because RotatingWord sits on its own line inside the H1 (see hero.tsx),
// the shift is horizontal only — it doesn't bump vertical baselines.
//
// Design:
//   - Pure key-driven animation: bumping `index` re-mounts the inner
//     <span>, re-running the CSS animation. No nested setTimeout.
//   - Rotation index is exposed via useRotatingIndex() so sibling
//     components (the vertical strip below the CTA) can highlight the
//     same vertical in lockstep.
//   - Respects prefers-reduced-motion via Tailwind's motion-safe/
//     motion-reduce variants.

'use client';

import { useEffect, useState } from 'react';

export const ROTATING_WORDS = [
  'movers.',
  'cleaners.',
  'handymen.',
  'lawn crews.',
] as const;
const INTERVAL_MS = 2600;

/**
 * Shared hook so multiple components can animate in sync with the
 * hero rotator. Returns the current index into ROTATING_WORDS.
 */
export function useRotatingIndex(): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % ROTATING_WORDS.length);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  return index;
}

export function RotatingWord() {
  const index = useRotatingIndex();
  const word = ROTATING_WORDS[index];

  return (
    // The outer <em> is the lime highlight box. Its width is
    // content-sized (inline-block fits the inner span) so it hugs the
    // current word. A CSS width transition smooths the size change
    // between rotations — the outer box appears to shrink/grow into
    // the next word's shape rather than snap.
    // `key={index}` on the OUTER em re-mounts the paint-in animation
    // every rotation so the lime sweeps across the new word.
    //
    // Padding is asymmetric: a touch more on the bottom so descenders
    // ("y" in handymen, ",") aren't clipped by the lime rect, and
    // enough on the top so the lime extends upward past the cap-line
    // — that upward extension is what the "g" descender from the line
    // above crosses into. The parent line itself uses z-index so the
    // "g" renders in FRONT of the lime (see hero.tsx).
    <em
      key={index}
      aria-live="polite"
      className="not-italic relative inline-block bg-lime px-3 pt-2 pb-3 align-baseline motion-safe:animate-paint-in transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      {/* Inner span is also keyed — re-mount re-triggers the stamp-in
          animation on the text itself, independent of the paint-in on
          the lime box. Whitespace-nowrap keeps multi-word entries
          ("lawn crews.") on a single line. */}
      <span
        key={`inner-${index}`}
        className="inline-block whitespace-nowrap motion-safe:animate-stamp-in"
      >
        {word}
      </span>
    </em>
  );
}
