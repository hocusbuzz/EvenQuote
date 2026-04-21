// FAQ section.
//
// Accordion from shadcn — keeps the page calm and focused (one question
// visible at a time by default). Questions are the ones a real person
// would ask before dropping $10 on this, answered honestly. The goal
// here is to remove objections, not to pad the page.

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const faqs = [
  {
    q: 'How long does this take?',
    a: "Most reports are ready within 1-2 hours. We place calls in parallel and only hit 'generate report' once we've heard back from enough businesses — usually 60-90 minutes after you pay.",
  },
  {
    q: 'What if businesses don\'t pick up?',
    a: "We retry no-answers twice, spaced out. We typically reach 12-18 of the 25 we dial — which is still way more than you'd realistically call yourself. The report tells you who we reached, who we didn't, and why.",
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
    a: 'US only for now, and moving is our only category at launch. We\'re expanding to more services (HVAC, cleaning, contractors) once we prove the moving experience end-to-end.',
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
        {/* Sidebar heading — editorial two-column layout */}
        <div>
          <p className="label-eyebrow mb-4">Questions</p>
          <h2 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
            Fair to&nbsp;ask.
          </h2>
          <p className="mt-6 text-muted-foreground">
            Here's what people usually want to know before they pay.
          </p>
        </div>

        {/* Accordion */}
        <Accordion type="single" collapsible className="w-full">
          {faqs.map((faq, i) => (
            <AccordionItem key={i} value={`item-${i}`}>
              <AccordionTrigger>{faq.q}</AccordionTrigger>
              <AccordionContent>{faq.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
