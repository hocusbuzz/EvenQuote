// How-it-works section.
//
// 3 steps, each with a character illustration that tells the beat
// of the journey: stressed (you, pre-EvenQuote), magic-phone (our AI
// doing the calling), reading (you with the report). The three
// characters together are the "little person" storyline — before,
// during, and after — that replaces a separate hero comic strip.
//
// Layout: 3-column grid on desktop, stacked on mobile. Each column
// has a thin top rule and the oversized step number (typography IS
// the decoration — the character sits alongside it, not over it).

import type { CharacterVariant } from '@/components/site/character';
import { Character } from '@/components/site/character';

const steps: Array<{
  number: string;
  label: string;
  title: string;
  body: string;
  character: CharacterVariant;
}> = [
  {
    number: '01',
    label: 'Tell us',
    title: 'Tell us what you need.',
    body: 'Answer a short intake — where you\'re moving, when, how big. Takes about 90 seconds.',
    character: 'stressed',
  },
  {
    number: '02',
    label: 'We call',
    title: 'We call up to 10 local pros.',
    body: 'Our AI assistant dials each business, confirms availability, and pulls a real price range — not a vague "we\'ll get back to you".',
    character: 'magic',
  },
  {
    number: '03',
    label: 'You compare',
    title: 'You get a single report.',
    body: 'Side-by-side pricing, what\'s included, who answered, who didn\'t. Reach out to whichever pro makes sense.',
    character: 'reading',
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="container py-24 sm:py-32">
      <div className="mb-16 max-w-2xl">
        <p className="label-eyebrow mb-4">How it works</p>
        <h2 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
          Three steps. No phone&nbsp;tag.
        </h2>
      </div>

      <ol className="grid gap-10 md:grid-cols-3 md:gap-8">
        {steps.map((step, i) => (
          <li
            key={step.number}
            className="group animate-fade-up"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <div className="rule-top pt-6">
              <div className="mb-8 flex items-baseline justify-between">
                {/* Big step number punches in with a small stagger so
                    the three read 01 → 02 → 03 in rapid fire, not all
                    at once. Extra delay on top of the parent's fade-up
                    so the number lands a beat AFTER the column
                    reveals. On hover, the number tilts a hair — subtle
                    invitation to read. */}
                <span
                  className="font-display text-7xl font-black leading-none text-foreground motion-safe:animate-number-punch inline-block transition-transform duration-300 group-hover:-rotate-3"
                  style={{ animationDelay: `${180 + i * 180}ms` }}
                >
                  {step.number}
                </span>
                <span className="label-eyebrow">{step.label}</span>
              </div>

              {/* Character — the little person per step. Sized so it
                  lives to the right of the heading on desktop, above
                  the heading on narrow columns. text-foreground drives
                  the ink stroke via currentColor. */}
              <div className="mb-5 text-foreground">
                <Character
                  variant={step.character}
                  size={88}
                  className="motion-safe:animate-fade-up"
                  style={{ animationDelay: `${300 + i * 180}ms` }}
                />
              </div>

              <h3 className="mb-3 font-display text-2xl font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
