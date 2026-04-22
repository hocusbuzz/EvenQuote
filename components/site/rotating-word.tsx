// Rotating word for the hero headline.
//
// Cycles through the vertical nouns (movers → cleaners → handymen → lawn
// crews) with a slide-up + fade transition. The lime highlight box stays
// fixed; only the word inside animates, so the visual weight of the headline
// doesn't jitter.
//
// Implementation notes:
//   - Client component: it uses an interval + state. Keeping it isolated
//     means the rest of the hero stays server-rendered.
//   - The wrapper keeps a stable width based on the LONGEST word in the
//     rotation. Without this, the headline would jump around as each word
//     swaps in. Measured once on mount via an offscreen probe, then locked.
//   - Respects prefers-reduced-motion: with that set, we skip the animation
//     and the words cross-fade instantly.
//   - Uses aria-live="polite" on the visible text so screen readers announce
//     the rotation without stepping on the user.

'use client';

import { useEffect, useRef, useState } from 'react';

const WORDS = ['movers.', 'cleaners.', 'handymen.', 'lawn crews.'];
const INTERVAL_MS = 2200;

export function RotatingWord() {
  const [index, setIndex] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [minWidth, setMinWidth] = useState<number | null>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const reducedMotionRef = useRef(false);

  // Measure the widest word so the lime box doesn't reflow.
  useEffect(() => {
    if (!probeRef.current) return;
    const spans = probeRef.current.querySelectorAll<HTMLSpanElement>(
      '[data-probe-word]'
    );
    let max = 0;
    spans.forEach((s) => {
      max = Math.max(max, s.getBoundingClientRect().width);
    });
    if (max > 0) setMinWidth(Math.ceil(max));
  }, []);

  // Respect reduced-motion preference.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Rotation loop.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (reducedMotionRef.current) {
        setIndex((i) => (i + 1) % WORDS.length);
        return;
      }
      setAnimating(true);
      // After the slide-out finishes, swap the word and slide it back in.
      window.setTimeout(() => {
        setIndex((i) => (i + 1) % WORDS.length);
        setAnimating(false);
      }, 320);
    }, INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className="relative inline-block align-baseline"
      style={minWidth ? { minWidth: `${minWidth}px` } : undefined}
    >
      {/* Offscreen probe — renders every word once to measure the widest. */}
      <span
        ref={probeRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
      >
        {WORDS.map((w) => (
          <span
            key={w}
            data-probe-word
            className="font-display display-tight font-bold"
          >
            {w}
          </span>
        ))}
      </span>

      {/* The visible lime highlight + animated word */}
      <em
        className="not-italic inline-block bg-lime px-3 py-0.5"
        aria-live="polite"
      >
        <span
          key={index}
          className={
            'inline-block whitespace-nowrap transition-all duration-300 ease-out motion-reduce:transition-none motion-reduce:animate-none ' +
            (animating
              ? '-translate-y-3 opacity-0'
              : 'translate-y-0 opacity-100 animate-fade-up')
          }
        >
          {WORDS[index]}
        </span>
      </em>
    </span>
  );
}
