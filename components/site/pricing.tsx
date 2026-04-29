// Pricing section.
//
// One tier. No "Starter / Pro / Enterprise" decoy columns. The price
// and what's included are the whole point — presented as a single
// oversized card on an ink background so it pops against the cream page.
//
// The Check/X icons from lucide are sized-down and colored so they
// feel like editorial marks rather than SaaS checklists.

import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const includes = [
  'Up to 10 calls to local pros',
  'Structured price range from each business',
  'Availability check for your move date',
  'What\'s included: movers, truck size, insurance',
  'Clean comparison report, delivered by email',
  'Access to full call recordings in your dashboard',
];

const notIncludes = [
  'Subscription or renewal',
  'Marketing calls or emails to your phone',
  'Any data sold to third parties',
];

export function Pricing() {
  return (
    <section id="pricing" className="bg-ink py-24 text-cream sm:py-32">
      <div className="container">
        <div className="mb-16 max-w-2xl">
          <p className="label-eyebrow mb-4 !text-cream/60">Pricing</p>
          <h2 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
            One price. <em className="not-italic text-lime">One report.</em>
          </h2>
        </div>

        {/* The whole pricing card gets a slow tilt-wobble (±0.6° over
            8s) so it feels alive without grabbing attention. Paired
            with the hero sticker's existing wobble, the site has a
            consistent "nothing is static" undercurrent. */}
        <div className="mx-auto grid max-w-5xl overflow-hidden rounded-xl border-2 border-cream motion-safe:animate-tilt-wobble md:grid-cols-[1fr_1.4fr]">
          {/* Left panel — price */}
          <div className="flex flex-col justify-between border-b-2 border-cream bg-lime p-8 text-ink md:border-b-0 md:border-r-2 md:p-12">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.25em]">Flat fee</p>
              <p className="mt-4 font-display font-black leading-none display-tight text-[clamp(4rem,14vw,8rem)]">
                $9
                <span className="align-top text-5xl">⁹⁹</span>
              </p>
              <p className="mt-2 font-mono text-xs uppercase tracking-[0.2em] text-ink/60">
                + tax if applicable
              </p>
              <p className="mt-4 max-w-xs font-display text-xl leading-snug">
                One payment per request. Pay only when you're ready to collect quotes.
              </p>
            </div>

            <Button asChild variant="default" size="xl" className="mt-10 w-full bg-ink text-cream hover:bg-ink/90 group">
              <Link href="/get-quotes">
                Start a request
              </Link>
            </Button>
          </div>

          {/* Right panel — what's included */}
          <div className="p-8 md:p-12">
            <p className="label-eyebrow mb-5 !text-cream/60">What's included</p>
            <ul className="space-y-3">
              {includes.map((item, i) => (
                <li key={item} className="flex items-start gap-3 text-base leading-relaxed">
                  {/* Check marks pop in with a quick stagger so the
                      list "lights up" as it enters view. Small
                      animation-delay walks down the list at ~80ms
                      increments — fast enough that the whole list
                      feels snappy, not sluggish. */}
                  <Check
                    className="mt-1 size-4 shrink-0 text-lime motion-safe:animate-check-pop"
                    style={{ animationDelay: `${i * 80}ms` }}
                    strokeWidth={3}
                    aria-hidden
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="my-8 h-px bg-cream/15" aria-hidden />

            <p className="label-eyebrow mb-5 !text-cream/60">What you'll never get</p>
            <ul className="space-y-3">
              {notIncludes.map((item, i) => (
                <li
                  key={item}
                  className="flex items-start gap-3 text-base leading-relaxed text-cream/70"
                >
                  <X
                    className="mt-1 size-4 shrink-0 text-cream/40 motion-safe:animate-check-pop"
                    style={{ animationDelay: `${(includes.length + i) * 80}ms` }}
                    strokeWidth={3}
                    aria-hidden
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
