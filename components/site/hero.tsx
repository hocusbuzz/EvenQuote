// Hero section.
//
// Layout intent:
//   - Asymmetric: left column is text-heavy, right column has an
//     oversized $9.99 "price sticker" rotated slightly for editorial feel.
//   - Huge display serif for the headline. Letter-spacing tightened to -4%
//     so the three stacked lines read as one visual mass.
//   - Eyebrow label in monospace (uppercase, wide tracking) above the
//     headline — the "kicker" pattern from print magazines.
//   - One clear primary CTA (lime), one secondary (ghost). No A/B-test-ready
//     row of five buttons.
//   - Subtle noise texture via a pure-SVG background filter, not a PNG.

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-foreground/90 bg-background">
      {/* Grain overlay for atmosphere */}
      <div aria-hidden className="pointer-events-none absolute inset-0 noise opacity-60" />

      <div className="container relative grid grid-cols-1 gap-10 py-20 sm:py-28 lg:grid-cols-[1.4fr_1fr] lg:gap-16 lg:py-36">
        {/* Left: headline + subhead + CTA */}
        <div className="animate-fade-up">
          <p className="label-eyebrow mb-6">A new way to get quotes</p>

          <h1 className="font-display display-tight text-[clamp(2.75rem,8vw,6.5rem)] font-bold">
            <span className="block">Stop</span>
            <span className="block">calling 20</span>
            <span className="block">
              <em className="not-italic bg-lime px-3 py-0.5">movers.</em>
            </span>
          </h1>

          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            We dial them for you. Our AI talks to local pros — movers, cleaners, handymen,
            lawn care — asks the right questions, and delivers a clean side-by-side comparison
            in your inbox.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Button asChild variant="lime" size="xl">
              <Link href="/get-quotes">
                Get quotes for $9.99
                <ArrowRight className="!size-5" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg" className="text-base">
              <Link href="#how">How it works</Link>
            </Button>
          </div>

          {/* Vertical strip — shows the breadth */}
          <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            <span className="text-foreground">Movers</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span className="text-foreground">Cleaners</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span>Handymen (soon)</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span>Lawn care (soon)</span>
          </div>

          {/* Trust strip — honest version, no fake social proof */}
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
            <span>1 payment</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span>No subscription</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" aria-hidden />
            <span>No spam to your phone</span>
          </div>
        </div>

        {/* Right: tilted price "sticker" / editorial ornament */}
        <div className="relative hidden lg:block">
          <div
            className="absolute right-0 top-8 aspect-square w-[22rem] -rotate-6 rounded-full border-2 border-foreground bg-lime shadow-[8px_8px_0_0_hsl(var(--foreground))]"
            aria-hidden
          >
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <p className="font-mono text-xs uppercase tracking-[0.25em]">Flat fee</p>
              <p className="mt-2 font-display text-8xl font-black leading-none text-ink">
                $9
                <span className="align-super text-4xl">⁹⁹</span>
              </p>
              <p className="mt-4 max-w-[18ch] font-display text-base italic text-ink">
                up to 25 calls, one report
              </p>
            </div>
          </div>

          {/* Small caption, hand-written-ish */}
          <p
            className="absolute -bottom-4 right-8 max-w-[14rem] rotate-[-4deg] font-display text-sm italic text-muted-foreground"
            aria-hidden
          >
            ↑ what a week of phone tag should've cost
          </p>
        </div>
      </div>
    </section>
  );
}
