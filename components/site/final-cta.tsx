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
      <div aria-hidden className="pointer-events-none absolute inset-0 noise opacity-30" />

      <div className="container relative flex flex-col items-start gap-10 py-24 sm:py-32 md:flex-row md:items-center md:justify-between">
        <div className="max-w-2xl">
          <p className="label-eyebrow mb-4 !text-ink/60">Ready?</p>
          <h2 className="font-display display-tight text-[clamp(2.5rem,7vw,5.5rem)] font-black text-ink">
            Let someone else
            <br />
            do the&nbsp;calling.
          </h2>
        </div>

        <Button
          asChild
          size="xl"
          className="shrink-0 border-2 border-ink bg-ink text-cream shadow-[6px_6px_0_0_hsl(var(--foreground))] hover:bg-ink/90 hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[4px_4px_0_0_hsl(var(--foreground))] transition-all"
        >
          <Link href="/get-quotes">
            Start for $9.99
            <ArrowRight className="!size-5" />
          </Link>
        </Button>
      </div>
    </section>
  );
}
