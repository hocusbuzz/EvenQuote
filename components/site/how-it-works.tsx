// How-it-works section.
//
// 3 steps. Each one is a number (oversized serif), a heading, and a
// paragraph. Laid out as a 3-column grid on desktop, stacked on mobile.
// The left edge of each column has a thin top rule — editorial cue.
//
// No stock illustrations, no lottie animations — the typography IS the
// decoration. This matches the "bold + direct, editorial" direction.

const steps = [
  {
    number: '01',
    label: 'Tell us',
    title: 'Tell us what you need.',
    body: 'Answer a short intake — where you\'re moving, when, how big. Takes about 90 seconds.',
  },
  {
    number: '02',
    label: 'We call',
    title: 'We call up to 25 local pros.',
    body: 'Our AI assistant dials each business, confirms availability, and pulls a real price range — not a vague "we\'ll get back to you".',
  },
  {
    number: '03',
    label: 'You compare',
    title: 'You get a single report.',
    body: 'Side-by-side pricing, what\'s included, who answered, who didn\'t. Reach out to whichever mover makes sense.',
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
            className="animate-fade-up"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <div className="rule-top pt-6">
              <div className="mb-8 flex items-baseline justify-between">
                <span className="font-display text-7xl font-black leading-none text-foreground">
                  {step.number}
                </span>
                <span className="label-eyebrow">{step.label}</span>
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
