// FAQ section.
//
// Accordion from shadcn — keeps the page calm and focused (one question
// visible at a time by default). Questions are the ones a real person
// would ask before dropping $10 on this, answered honestly. The goal
// here is to remove objections, not to pad the page.
//
// The sidebar carries the same "little person" character as HowItWorks,
// in the "puzzled" variant — two question marks bobbing above their
// head. It mirrors the section's headline "Fair to ask." without
// over-selling the joke.

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Character } from '@/components/site/character';

const faqs = [
  {
    q: 'How long does this take?',
    a: "Most reports are ready within 1-2 hours. We place calls in parallel and only hit 'generate report' once we've heard back from enough businesses — usually 60-90 minutes after you pay.",
  },
  {
    q: 'What if businesses don\'t pick up?',
    a: "We retry no-answers twice, spaced out. We typically reach 3-4 of the 5 we dial — which is still way more than you'd realistically call yourself. The report tells you who we reached, who we didn't, and why.",
  },
  {
    q: 'Do the businesses know it\'s an AI?',
    a: "Yes. Every call opens with a clear disclosure that it's an AI assistant calling on behalf of a customer. We comply with AI disclosure laws in California, Florida, and other states. No trickery — businesses can decline and we end the call.",
  },
  {
    q: "What if I don't like any of the quotes?",
    a: "The $9.99 covers the calling work, not a guarantee of good prices. If every business was out of your budget or unavailable, you'll still get the report — it just means you now know the market for your move without having spent a week on hold.",
  },
  {
    q: 'What areas do you cover?',
    a: 'US only for now. Moving and house cleaning are live; handymen and lawn care are rolling out next. We start with a vertical once we have enough quality local businesses seeded to make the report feel comprehensive.',
  },
  {
    q: 'Will businesses start spamming my phone?',
    a: 'We never share your number with the businesses we call. The call is between us and the business. You only hear from them if you reach out directly from the report.',
  },
];

export function FAQ() {
  return (
    <section id="faq" className="container py-24 sm:py-32">
      <div className="grid gap-12 md:grid-cols-[1fr_1.8fr] md:gap-16">
        {/* Sidebar heading — editorial two-column layout. The
            puzzled character lives under the subheading, sized so it's
            a soft focal point rather than a logo. Bobbing question
            marks tie visually to the headline's voice. */}
        <div>
          <p className="label-eyebrow mb-4">Questions</p>
          <h2 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
            Fair to&nbsp;ask.
          </h2>
          <p className="mt-6 text-muted-foreground">
            Here&rsquo;s what people usually want to know before they pay.
          </p>
          <div className="mt-10 text-foreground">
            <Character variant="puzzled" size={140} />
          </div>
        </div>

        {/* Accordion. Each FAQ item fades up with a walking stagger
            (60ms per item) so the list pours in top-to-bottom when the
            section enters view rather than all at once. */}
        <Accordion type="single" collapsible className="w-full">
          {faqs.map((faq, i) => (
            <AccordionItem
              key={i}
              value={`item-${i}`}
              className="animate-fade-up"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <AccordionTrigger>{faq.q}</AccordionTrigger>
              <AccordionContent>{faq.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
