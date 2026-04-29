// Hero section.
//
// Layout intent:
//   - Asymmetric: left column is text-heavy, right column is a
//     two-object stack — the oversized $9.99 "price sticker" on top,
//     a sample-report card on the bottom — to balance the left
//     column's tall stack of text + trust strips.
//   - Huge display serif for the headline. Letter-spacing tightened
//     to -4% so the three stacked lines read as one visual mass.
//     `max-w-[14ch]` caps line length so the rotating word never
//     pushes into the right-column area at mid-viewport breakpoints.
//   - Eyebrow label in monospace (uppercase, wide tracking) above the
//     headline — the "kicker" pattern from print magazines. The caret
//     (`|`) blinks subtly, nodding to the "working on it" feel.
//   - One clear primary CTA (lime), one secondary (ghost).
//   - Subtle noise texture via a pure-SVG background filter, not a PNG.
//   - Price sticker enters with a thud + overshoot then hands off to
//     the wobble loop. Feels alive; not cartoonish. Respects
//     prefers-reduced-motion via Tailwind's motion-safe/motion-reduce.
//
// This component needs to be a client component because VerticalStrip
// subscribes to the shared useRotatingIndex() hook so its active-pill
// highlight stays in sync with the headline rotator.

'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import {
  RotatingWord,
  ROTATING_WORDS,
  useRotatingIndex,
} from '@/components/site/rotating-word';
import { CurlyArrow } from '@/components/site/curly-arrow';

// The vertical-strip labels are deliberately worded slightly differently
// from the rotator's noun phrases (which end with periods and use
// "crews" etc.). This array is indexed in lockstep with ROTATING_WORDS.
const STRIP_LABELS = ['Movers', 'Cleaners', 'Handymen', 'Lawn care'] as const;

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-foreground/90 bg-background">
      {/* Grain overlay for atmosphere */}
      <div aria-hidden className="pointer-events-none absolute inset-0 noise opacity-60" />

      <div className="container relative grid grid-cols-1 items-center gap-10 py-20 sm:py-24 lg:grid-cols-[1.3fr_1fr] lg:gap-12 lg:py-28 xl:gap-16">
        {/* Left: headline + subhead + CTA */}
        <div className="animate-fade-up">
          <p className="label-eyebrow mb-6 inline-flex items-center gap-1 motion-safe:animate-slide-in-left">
            A new way to get quotes
            <span
              aria-hidden
              className="ml-1 inline-block motion-safe:animate-caret-blink text-foreground/80"
            >
              |
            </span>
          </p>

          {/* Tight leading (~0.92) pulls the three lines close enough
              that the descender of the "g" in "calling" visibly bleeds
              into the lime rect on the line below. That overlap is the
              point — it ties the two lines together as one visual unit
              rather than reading as two separate rows.
              Z-ordering: the "calling" span gets z-10 so its "g"
              descender renders IN FRONT of the lime rect below (which
              is z-0). Without this, the lime box paints on top and
              swallows the descender.
              Number-free copy as of R47.3: hard-coded "20" was a stale
              coupling to the old CALL_BATCH_SIZE. Generic phrasing
              survives any future tuning of the batch size. */}
          <h1 className="font-display display-tight leading-[0.92] text-[clamp(2.5rem,7vw,5.5rem)] font-bold max-w-[14ch] xl:max-w-[16ch]">
            <span className="block">Stop calling</span>
            <span className="relative z-10 block">around for</span>
            <span className="relative z-0 block -mt-2">
              <RotatingWord />
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            We dial them for you. Our AI talks to local pros — movers, cleaners, handymen,
            lawn care — asks the right questions, and delivers a clean side-by-side comparison
            in your inbox.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Button asChild variant="lime" size="xl" className="group">
              <Link href="/get-quotes">
                Get quotes for $9.99
                <ArrowRight className="!size-5 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-1.5 group-hover:-rotate-3" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg" className="text-base">
              <Link href="#how">How it works</Link>
            </Button>
          </div>

          {/* Vertical strip — synced with the rotator. The currently
              rotating vertical gets a lime underline + darker ink;
              the others fade back. Coming-soon ones stay italicised so
              they read as placeholders.
              Adds life without adding a second thing competing with the
              headline: same animation, different visual language. */}
          <VerticalStrip />

          {/* Trust strip — honest version, no fake social proof */}
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            <span>1 payment</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span>No subscription</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span>No spam to your phone</span>
          </div>
        </div>

        {/* Right: price sticker + sample-report card (stacked, offset).
            Both are decorative (aria-hidden) — the real product is the
            CTA. But visually they carry the right column the full
            height of the text column instead of floating at the top. */}
        <div className="relative hidden lg:block min-h-[32rem] xl:min-h-[36rem]">
          {/* 1. Tilted price "sticker" / editorial ornament.
                Enters with a thud (scale-overshoot) then hands off to
                the infinite wobble. Two animations on one element is
                fine — `thud-in` uses `both` to hold the final frame
                (rotate: -6deg scale: 1) and `sticker-wobble` takes over
                from that resting state. */}
          <div
            className="absolute right-4 top-4 aspect-square w-[19rem] xl:w-[22rem] -rotate-6 motion-safe:animate-[thud-in_0.55s_cubic-bezier(0.34,1.56,0.64,1)_both,sticker-wobble_5s_ease-in-out_infinite_0.6s] rounded-full border-2 border-foreground bg-lime shadow-[8px_8px_0_0_hsl(var(--foreground))] will-change-transform"
            aria-hidden
          >
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <p className="font-mono text-xs uppercase tracking-[0.25em]">Flat fee</p>
              <p className="mt-2 font-display text-7xl xl:text-8xl font-black leading-none text-ink">
                $9
                <span className="align-super text-3xl xl:text-4xl">⁹⁹</span>
              </p>
              <p className="mt-4 max-w-[18ch] font-display text-base italic text-ink">
                up to 10 calls, one report
              </p>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink/60">
                + tax if applicable
              </p>
            </div>
          </div>

          {/* Handwritten caption + curly arrow pointing at the sticker.
              Positioned to the LEFT of the circle, in the gutter
              between the two columns — well clear of the report card
              below and the sticker's circular edge to the right.
              max-w cap + right margin give "tag" at the line break
              breathing room from the sticker edge; the arrow self-
              draws on mount as a single graceful loop. */}
          <div
            className="absolute left-[-2rem] top-[7.5rem] flex flex-col items-start motion-safe:animate-fade-up [animation-delay:400ms] z-20"
            aria-hidden
          >
            <p className="max-w-[10rem] rotate-[-4deg] font-display text-sm italic leading-snug text-muted-foreground pr-6">
              What a week of phone tag should&rsquo;ve cost
            </p>
            {/* Arrow in ink (foreground) — lime/muted both read as
                afterthought; ink matches the rest of the hand-drawn
                detail language (sticker border, card shadow). */}
            <CurlyArrow
              width={140}
              height={90}
              className="text-foreground mt-1 ml-2"
            />
          </div>

          {/* 2. Sample-report card — the product's tangible output.
                Slams in diagonally with a brief blur to clear. Ends at
                its resting 2° tilt (opposite of the sticker's -6°) so
                the two objects "talk" to each other instead of leaning
                the same way. */}
          <div
            className="absolute bottom-0 left-0 w-[20rem] xl:w-[23rem] rotate-2 rounded-sm border-2 border-foreground bg-card p-4 shadow-[6px_6px_0_0_hsl(var(--foreground))] motion-safe:animate-slam-in [animation-delay:250ms]"
            aria-hidden
          >
            <div className="flex items-center justify-between border-b border-foreground/20 pb-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Your quote report
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                3 of 10
              </p>
            </div>
            <ul className="mt-3 space-y-2.5">
              <li className="flex items-center justify-between gap-3">
                <span className="font-display text-base text-foreground">Ace Movers</span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    $
                  </span>
                  <span className="font-display text-xl font-bold tabular-nums text-foreground">
                    1,180
                  </span>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3 rounded-sm bg-lime/40 -mx-1 px-1 py-0.5">
                <span className="font-display text-base text-foreground">
                  Two&nbsp;Guys &amp; a Truck
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    $
                  </span>
                  <span className="font-display text-xl font-bold tabular-nums text-foreground">
                    975
                  </span>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="font-display text-base text-foreground">BoxHaul Pro</span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    $
                  </span>
                  <span className="font-display text-xl font-bold tabular-nums text-foreground">
                    1,420
                  </span>
                </span>
              </li>
            </ul>
            <div className="mt-3 flex items-center justify-between border-t border-foreground/20 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <span>Best price highlighted</span>
              <span>Sent to inbox</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Vertical strip below the CTA. Highlights whichever vertical is
 * currently showing in the headline rotator.
 *
 * The active pill gets:
 *   - Full ink color (vs muted for the others)
 *   - An underline that "paints in" (same lime-sweep language as the
 *     headline highlight)
 * Everything else stays the same visual grammar as the old strip —
 * monospace, tracking-widest, small dot separators.
 */
function VerticalStrip() {
  const activeIndex = useRotatingIndex();

  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
      {STRIP_LABELS.map((label, i) => {
        const isActive = i === activeIndex;
        // Items 2 & 3 (handymen, lawn care) are marked "soon" — match
        // the prior copy's intent. Movers/cleaners are live.
        const isComingSoon = i >= 2;

        return (
          <span key={label} className="inline-flex items-center gap-x-4">
            <span
              className={
                'relative transition-all duration-300 ' +
                (isActive
                  ? 'font-bold text-foreground -translate-y-px'
                  : isComingSoon
                  ? 'text-muted-foreground/80 italic'
                  : 'text-foreground/60')
              }
            >
              {label}
              {isComingSoon ? (
                <span className="ml-1 normal-case tracking-normal opacity-70">(soon)</span>
              ) : null}

              {/* Lime underline that paints in when this item is active.
                  Uses the same paint-in keyframe as the headline
                  highlight — one visual language across the hero. A
                  chunkier 5px bar makes the sync with the rotator
                  obvious at a glance. */}
              {isActive ? (
                <span
                  aria-hidden
                  key={`underline-${activeIndex}`}
                  className="absolute -bottom-1.5 left-0 right-0 h-[5px] bg-lime motion-safe:animate-paint-in"
                />
              ) : null}
            </span>

            {/* Dot separator (not after the last item) */}
            {i < STRIP_LABELS.length - 1 ? (
              <span
                className="h-1 w-1 rounded-full bg-muted-foreground/50"
                aria-hidden
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

// Re-export so any other file importing from this module keeps the
// previous surface (ROTATING_WORDS was previously a private WORDS const).
// Kept here to avoid a separate lint flag for unused imports.
void ROTATING_WORDS;
