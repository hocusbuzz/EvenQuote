// Final CTA section.
//
// The page's closing line. One more big display-type statement, one
// button. Uses a cream-over-lime block so the color flips one last
// time and feels like a punctuation mark rather than another generic
// "Sign up today" footer bar.

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export function FinalCTA() {
  return (
    <section className="relative overflow-hidden border-y border-foreground bg-lime">
      {/* Radiating lime-deep "sunburst" rays — a large SVG anchored to
          the left side of the section, rotating very slowly (40s/rev).
          Adds kinetic interest to the flat lime block without
          competing with the headline. The lime-deep tint is close
          enough to the base that the rays read as texture, not
          decoration, and the slow rotation is below the "notice it"
          threshold unless you look directly at it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-40 h-[44rem] w-[44rem] motion-safe:animate-sweep-rays"
      >
        <svg viewBox="0 0 400 400" className="h-full w-full opacity-40">
          {Array.from({ length: 24 }).map((_, i) => (
            <rect
              key={i}
              x="196"
              y="0"
              width="8"
              height="200"
              fill="#9FCC00"
              transform={`rotate(${(i * 360) / 24} 200 200)`}
            />
          ))}
        </svg>
      </div>

      {/* Mirrored smaller burst on the right to balance composition */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -bottom-32 h-[28rem] w-[28rem] motion-safe:animate-sweep-rays [animation-duration:55s] [animation-direction:reverse]"
      >
        <svg viewBox="0 0 400 400" className="h-full w-full opacity-30">
          {Array.from({ length: 18 }).map((_, i) => (
            <rect
              key={i}
              x="198"
              y="0"
              width="4"
              height="200"
              fill="#9FCC00"
              transform={`rotate(${(i * 360) / 18} 200 200)`}
            />
          ))}
        </svg>
      </div>

      <div aria-hidden className="pointer-events-none absolute inset-0 noise opacity-30" />

      <div className="container relative flex flex-col items-start gap-10 py-24 sm:py-32 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl animate-fade-up">
          <p className="label-eyebrow mb-4 !text-ink/60">Ready?</p>
          <h2 className="font-display display-tight text-[clamp(2.5rem,7vw,5.5rem)] font-black text-ink">
            Let someone else
            <br />
            do the&nbsp;calling.
          </h2>
        </div>

        {/* The CTA gets the same press-in hover as before (translate +
            reduced shadow) plus an arrow-nudge loop on hover — the
            idle state is still; on hover the arrow paces forward and
            back, inviting the click. */}
        <Button
          asChild
          size="xl"
          className="group shrink-0 border-2 border-ink bg-ink text-cream shadow-[6px_6px_0_0_hsl(var(--foreground))] hover:bg-ink/90 hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[4px_4px_0_0_hsl(var(--foreground))] transition-all motion-safe:animate-fade-up [animation-delay:200ms]"
        >
          <Link href="/get-quotes">
            Start for $9.99
            <ArrowRight className="!size-5 motion-safe:group-hover:animate-arrow-nudge" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
