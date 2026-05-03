// /pricing — standalone pricing page.
//
// Why a dedicated route (vs the homepage Pricing section): paid-traffic
// sitelinks ("View pricing"), Google Ads quality-score gating on
// landing-page relevance, and "<vertical> pricing" organic searches all
// expect a real /pricing URL. Splitting it out from the homepage section
// also lets us spend more screen real estate on objections (refunds,
// taxes, scope) without bloating the main scroll.
//
// Reuses the homepage's <Pricing/> component as the centerpiece so the
// price card stays single-source-of-truth. Surrounds it with comparison +
// refund clarity + pricing-specific FAQ that wouldn't fit on the
// homepage without competing with the broader pitch.

import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, X } from 'lucide-react';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';
import { Pricing } from '@/components/site/pricing';
import { Button } from '@/components/ui/button';
import { JsonLd } from '@/lib/seo/json-ld';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export const metadata: Metadata = {
  title: 'Pricing — $9.99 flat per quote request',
  description:
    'One flat fee per request. No subscription, no upsells. Refund if we can\'t deliver quotes from local pros in your area.',
  // Canonical so paid traffic + Google Ads sitelinks consolidate on
  // this URL instead of fragmenting across UTM-tagged variants.
  alternates: { canonical: '/pricing' },
};

// Pricing-specific objections — these belong here (not on the global
// FAQ) because they only matter to someone evaluating the price.
const pricingFaqs: Array<{ q: string; a: string }> = [
  {
    q: 'What if no businesses pick up?',
    a: "If we can't reach anyone in your area or every call goes to voicemail, we automatically refund the $9.99 to the card you paid with. The refund happens before the report email goes out — same trigger, no inbox-back-and-forth required.",
  },
  {
    q: 'Is there a subscription?',
    a: "No. The $9.99 is a one-time charge per request. You pay only when you decide to start a request. No autorenewal, no monthly minimum, no plan to cancel.",
  },
  {
    q: 'What about taxes?',
    a: "Stripe calculates and adds applicable sales tax based on your location at checkout. The line shows up before you pay so there's no surprise. Most US customers pay $9.99 flat; some states add a small tax line.",
  },
  {
    q: 'What if the quotes are too expensive?',
    a: "The $9.99 covers the calling work, not a guarantee of cheap prices. If every quote is over your budget, you still get the report — at minimum you now know the local market without spending a week on hold. We don't refund based on price disappointment, only on inability to deliver quotes.",
  },
  {
    q: 'Can I get more than 5 quotes?',
    a: "We dial up to 5 businesses per request. If you want a wider net, place a second request — the marginal $9.99 is usually still cheaper than any one professional broker fee, and you'll have 10 data points to compare.",
  },
  {
    q: 'Do you charge the businesses?',
    a: "No. The pros we call don't pay for our calls or for the leads. They get a verbal request from an AI, decide whether to quote, and that's it. We're paid only by you.",
  },
  {
    q: 'How do refunds work?',
    a: "Refunds go back to the original card via Stripe and typically land within 5-10 business days, depending on your bank. We don't email a separate refund confirmation — the report email itself includes a line confirming the refund is on the way.",
  },
  {
    q: 'What if my card is declined?',
    a: "Stripe handles declines at checkout — you'd see the error before the request is created, so nothing happens on our side. Try a different card or contact your bank. The most common cause is travel-bank-flag on a sub-$10 transaction.",
  },
];

// Product + Offer JSON-LD. Tells Google "this page describes a product
// available for $9.99 USD." Eligible for the Product/Offer rich-result
// treatment in SERP — depending on Google's discretion the listing can
// show price + availability inline below the title, which lifts CTR
// vs an unannotated organic listing. The price node is what powers
// "from $9.99" in some snippets.
//
// Schema docs: https://schema.org/Product, https://schema.org/Offer
// Google rich-result reference:
//   https://developers.google.com/search/docs/appearance/structured-data/product
const pricingProductSchema = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'EvenQuote Quote Collection',
  description:
    'We dial up to 5 local pros for you and email a clean comparison report — price, availability, and scope from each — within 60-90 minutes. One flat fee per request.',
  brand: { '@type': 'Brand', name: 'EvenQuote' },
  // Product image — reuse the OG image so the rich-result thumbnail
  // is on-brand without a separate asset.
  image: 'https://evenquote.com/og-image.png',
  offers: {
    '@type': 'Offer',
    price: '9.99',
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    url: 'https://evenquote.com/get-quotes',
    // Honest seller — mirrors the Organization schema in layout.tsx.
    seller: {
      '@type': 'Organization',
      name: 'EvenQuote',
      url: 'https://evenquote.com',
    },
  },
};

export default function PricingPage() {
  return (
    <>
      <JsonLd data={pricingProductSchema} />
      <SiteNavbar />
      <main>
        {/* Hero — restate the price up top so the URL pays off
            immediately. No imagery; the giant numerals in the Pricing
            card below carry the visual weight. */}
        <section className="container py-20 sm:py-28">
          <p className="label-eyebrow mb-4">Pricing</p>
          <h1 className="font-display text-5xl font-bold tracking-tight sm:text-6xl">
            $9.99 flat. <em className="not-italic text-lime-deep">One report.</em>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl">
            One charge per quote request. We dial up to 5 local pros, pull
            structured prices and availability, and email you a clean
            comparison report — usually within 60-90 minutes.
          </p>
        </section>

        {/* Single source of truth for the price card. Reusing the
            homepage component so a price change ($9.99 → $X) lands
            in one place. */}
        <Pricing />

        {/* Why-the-price section — frames $9.99 against the alternatives
            so it reads as a deal, not a cost. Two columns on desktop,
            stack on mobile. Concrete numbers (not "save hours!" hand-
            waving) because customers comparing $9.99 to "free phone
            calls" need to see the actual time + opportunity cost. */}
        <section className="container py-20 sm:py-28">
          <div className="mx-auto max-w-4xl">
            <p className="label-eyebrow mb-4">How it stacks up</p>
            <h2 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Cheaper than your time.
            </h2>
            <p className="mt-4 max-w-2xl text-muted-foreground">
              Same job — calling local pros, comparing prices — costs you
              hours of phone tag and dropped follow-ups. Here&rsquo;s the math:
            </p>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <ComparisonCard
                title="DIY phone calls"
                price="Free"
                priceTone="muted"
                items={[
                  { good: false, text: '4-7 hours of calling, voicemails, callbacks' },
                  { good: false, text: 'Half the businesses never call back' },
                  { good: false, text: 'Notes scattered across napkins and texts' },
                  { good: false, text: 'No call recording to verify what they said' },
                ]}
              />
              <ComparisonCard
                title="Hire a broker"
                price="$50–250"
                priceTone="muted"
                items={[
                  { good: true, text: 'Someone else does the calling' },
                  { good: false, text: 'Markup baked into every quote' },
                  { good: false, text: 'You only see businesses they partner with' },
                  { good: false, text: 'Slow — usually a few business days' },
                ]}
              />
              <ComparisonCard
                title="EvenQuote"
                price="$9.99"
                priceTone="highlight"
                items={[
                  { good: true, text: 'AI dials 5 pros in parallel within minutes' },
                  { good: true, text: 'Structured price + availability + scope' },
                  { good: true, text: 'Full call recordings in your dashboard' },
                  { good: true, text: 'Refund if we can\'t reach anyone in your area' },
                ]}
              />
            </div>
          </div>
        </section>

        {/* Refund guarantee — promoted to its own block because this
            is the #1 "is it safe to pay?" objection from paid traffic
            and burying it inside the FAQ accordion costs conversion. */}
        <section className="bg-foreground/[0.03] py-20 sm:py-28">
          <div className="container max-w-4xl">
            <p className="label-eyebrow mb-4">Refund guarantee</p>
            <h2 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
              No quotes? <em className="not-italic text-lime-deep">No charge.</em>
            </h2>
            <div className="mt-8 grid gap-6 md:grid-cols-2">
              <div>
                <p className="text-base leading-relaxed text-muted-foreground">
                  If we can&rsquo;t find any businesses to call in your area, or
                  every call we place goes to voicemail and nobody returns
                  it, we automatically refund the $9.99 to your original
                  card. No support ticket. No back-and-forth. The refund
                  fires before the report email leaves our server.
                </p>
              </div>
              <div>
                <p className="text-base leading-relaxed text-muted-foreground">
                  What we <strong>don&rsquo;t</strong> refund: quotes you don&rsquo;t like
                  the look of, prices outside your budget, or pros whose
                  availability doesn&rsquo;t match your timeline. The $9.99
                  buys the calling work, not a guarantee of a price you&rsquo;ll
                  love. You&rsquo;ll always know what the local market is
                  charging.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing-specific FAQ. Lighter weight than the homepage FAQ
            (no character illustration, denser layout) — assumes the
            reader is here on purpose to compare prices. */}
        <section className="container py-20 sm:py-28">
          <div className="mx-auto max-w-4xl">
            <p className="label-eyebrow mb-4">Pricing FAQ</p>
            <h2 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Questions about the $9.99.
            </h2>
            <Accordion type="single" collapsible className="mt-10 w-full">
              {pricingFaqs.map((faq, i) => (
                <AccordionItem key={faq.q} value={`pricing-faq-${i}`}>
                  <AccordionTrigger>{faq.q}</AccordionTrigger>
                  <AccordionContent>{faq.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        {/* Final CTA — same destination as every other "Get quotes"
            button on the site so the analytics funnel doesn't fork. */}
        <section className="bg-ink py-20 text-cream sm:py-28">
          <div className="container max-w-3xl text-center">
            <h2 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Ready to skip the phone tag?
            </h2>
            <p className="mt-4 text-lg text-cream/80">
              Tell us about your job. We&rsquo;ll handle the calling.
            </p>
            <Button asChild variant="lime" size="xl" className="mt-10">
              <Link href="/get-quotes">Start a request — $9.99</Link>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function ComparisonCard({
  title,
  price,
  priceTone,
  items,
}: {
  title: string;
  price: string;
  priceTone: 'muted' | 'highlight';
  items: Array<{ good: boolean; text: string }>;
}) {
  return (
    <div
      className={
        'rounded-lg border-2 p-6 ' +
        (priceTone === 'highlight'
          ? 'border-foreground bg-lime/30'
          : 'border-foreground/30 bg-background')
      }
    >
      <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      <p
        className={
          'mt-2 font-display text-3xl font-bold tracking-tight ' +
          (priceTone === 'highlight' ? 'text-foreground' : 'text-muted-foreground')
        }
      >
        {price}
      </p>
      <ul className="mt-5 space-y-3">
        {items.map((item) => (
          <li key={item.text} className="flex items-start gap-2 text-sm leading-snug">
            {item.good ? (
              <Check className="mt-0.5 size-4 shrink-0 text-lime-deep" strokeWidth={3} aria-hidden />
            ) : (
              <X className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" strokeWidth={3} aria-hidden />
            )}
            <span className={item.good ? 'text-foreground' : 'text-muted-foreground'}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
