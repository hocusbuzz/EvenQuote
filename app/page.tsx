// Landing page.
//
// Composed from section components in components/site/*.
// All sections are server components — no client JS on first paint
// except the Accordion in FAQ (which is a client component for its
// internal state).

import type { Metadata } from 'next';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';
import { Hero } from '@/components/site/hero';
import { HowItWorks } from '@/components/site/how-it-works';
import { Pricing } from '@/components/site/pricing';
import { FAQ } from '@/components/site/faq';
import { FinalCTA } from '@/components/site/final-cta';

// Canonical = the apex. Paid traffic lands here with UTM params
// (?utm_source=google&utm_campaign=…) — without an explicit canonical,
// Google sees those parameterized URLs as separate pages and splits
// link equity across them. Resolves against metadataBase from
// app/layout.tsx (https://evenquote.com).
export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

export default function HomePage() {
  return (
    <>
      <SiteNavbar />
      <main>
        <Hero />
        <HowItWorks />
        <Pricing />
        <FAQ />
        <FinalCTA />
      </main>
      <SiteFooter />
    </>
  );
}
