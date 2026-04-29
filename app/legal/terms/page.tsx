// Terms of Service.
//
// R47.5: ported from docs/legal/TERMS_DRAFT_v2.md after Antonio's
// review. Operator-supplied values (entity, address, governing law,
// venue, refund window, contact email) are inlined as constants
// below — change them here when needed, then bump LAST_UPDATED.
//
// The page is now indexable and linked from the site footer. If a
// material change later requires hiding it again, flip robots back
// to noindex AND remove the footer link in components/site/footer.tsx.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern your use of EvenQuote.',
  robots: { index: true, follow: true },
};

// ── Operator-supplied values ──────────────────────────────────────
const LEGAL_ENTITY = 'Hocusbuzz LLC';
const ENTITY_TYPE = 'limited liability company';
const BUSINESS_ADDRESS = '845 Applewilde Dr, San Marcos, CA 92078';
const PRIMARY_CONTACT_EMAIL = 'info@hocusbuzz.com';
const GOVERNING_LAW = 'the State of California';
const ARBITRATION_VENUE = 'San Diego County, California';
const REFUND_WINDOW_DAYS = 7;
const LAST_UPDATED = 'May 6, 2026';

export default function TermsPage() {
  return (
    <>
      <p className="label-eyebrow text-muted-foreground">Legal</p>
      <h1>Terms of Service</h1>
      <p className="text-sm text-muted-foreground">
        Last updated: {LAST_UPDATED}
      </p>

      <p>
        These are the terms you agree to when you use EvenQuote.
        We&rsquo;re not going to pretend you&rsquo;ll read every word
        &mdash; most of this is what you already expect. The points worth
        knowing are bolded.
      </p>

      <h2>1. Who you&rsquo;re agreeing with</h2>
      <p>
        EvenQuote is operated by {LEGAL_ENTITY}, a California {ENTITY_TYPE}{' '}
        with an office at {BUSINESS_ADDRESS}. When this document says
        &ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;EvenQuote,&rdquo;
        that&rsquo;s the entity above.
      </p>
      <p>
        By using the site or paying for a quote request,{' '}
        <strong>you agree to these terms and to our Privacy Policy.</strong>{' '}
        If you don&rsquo;t agree, don&rsquo;t use the service.
      </p>
      <p>
        You must be <strong>18 or older</strong> to use EvenQuote. By
        submitting a quote request you&rsquo;re confirming that you are.
      </p>

      <h2>2. What EvenQuote is</h2>
      <p>
        EvenQuote is a service that places phone calls to local pros
        (movers, cleaners, handymen, lawn care) on your behalf using an AI
        assistant, gathers ballpark quotes, and emails you a side-by-side
        report.
      </p>
      <p>
        <strong>EvenQuote is NOT:</strong>
      </p>
      <ul>
        <li>
          A licensed broker, real estate agent, mover, cleaner, or
          contractor of any kind.
        </li>
        <li>
          A guarantor of the prices or services any pro provides.
        </li>
        <li>An employer or agent of the pros it calls.</li>
        <li>
          A substitute for verifying licensing, insurance, or references
          before hiring.
        </li>
      </ul>
      <p>
        The quotes we collect are <strong>non-binding ballparks</strong>.
        The actual price, scope, and terms are between you and whichever
        pro you hire.
      </p>

      <h2>3. Pricing and refunds</h2>
      <ul>
        <li>
          The fee for a quote request is <strong>$9.99 per request</strong>,
          charged at checkout via Stripe.
        </li>
        <li>
          This is a <strong>one-time charge per request</strong>. There is
          no subscription. We never bill you again for the same request.
        </li>
        <li>
          <strong>Automatic refund:</strong> if our AI fails to collect any
          usable quotes from the businesses we reach, we automatically
          refund the $9.99 to your original payment method. The refund is
          initiated within 24 hours of the report being generated and
          typically appears within 5&ndash;10 business days.
        </li>
        <li>
          <strong>Manual refund:</strong> if you&rsquo;re unhappy with the
          report for any other reason, email{' '}
          <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>
            {PRIMARY_CONTACT_EMAIL}
          </a>{' '}
          within {REFUND_WINDOW_DAYS} days of the report being generated
          and we&rsquo;ll review case-by-case. We don&rsquo;t promise a
          refund in every case, but we read every email.
        </li>
        <li>
          Refunds are processed in the original payment currency. We
          cannot refund through a different method (e.g. cash, check, or
          alternate card).
        </li>
      </ul>

      <h2>4. What you can and can&rsquo;t do</h2>
      <p>You agree to:</p>
      <ul>
        <li>Provide accurate information when requesting quotes.</li>
        <li>
          Use the service only to gather quotes for{' '}
          <strong>your own</strong> real service needs.
        </li>
        <li>
          Not abuse rate limits, attempt to overwhelm the service, or
          scrape data.
        </li>
        <li>
          Not request quotes for businesses that have asked us not to call
          them (we maintain an internal do-not-call list).
        </li>
      </ul>
      <p>You agree NOT to:</p>
      <ul>
        <li>
          Use EvenQuote to harass, threaten, or send false requests to
          businesses.
        </li>
        <li>
          Reverse-engineer, scrape, or republish our data, transcripts, or
          AI outputs except your own report.
        </li>
        <li>
          Use any output of EvenQuote for any unlawful purpose or to
          defraud any party.
        </li>
        <li>Resell or sublicense access to EvenQuote.</li>
      </ul>
      <p>
        If you violate these rules, we may terminate your access without
        notice or refund.
      </p>

      <h2>5. Recording and AI-disclosure consent</h2>
      <p>By submitting a quote request, you authorize us to:</p>
      <ul>
        <li>
          Place phone calls <strong>on your behalf</strong> to local pros,
          identifying the calling party as &ldquo;an AI assistant calling
          on behalf of a customer in [your city].&rdquo;
        </li>
        <li>
          <strong>Record and transcribe those calls</strong> for the
          purposes of generating your report and for quality assurance.
        </li>
        <li>
          Process those transcripts using our service providers (see the
          Privacy Policy).
        </li>
      </ul>
      <p>
        Our AI announces that it is an AI at the start of every call,
        satisfying California&rsquo;s BOT disclosure law (SB 1001). Where
        state or country law requires two-party consent for call
        recording, the business on the other end is informed they&rsquo;re
        being recorded as part of the AI disclosure.
      </p>

      <h2>6. Sharing your contact with a pro</h2>
      <p>
        By default,{' '}
        <strong>
          the businesses we call do NOT receive your contact details.
        </strong>{' '}
        They know only your city and the job parameters (home size, dates,
        etc.).
      </p>
      <p>
        Your dashboard shows each quote next to a &ldquo;Share my
        contact&rdquo; button.{' '}
        <strong>Only when you click that button</strong> do we forward
        your name, email, and phone number to that specific business.
        Once shared, that business may contact you directly outside of
        EvenQuote &mdash; and how they handle your data is governed by
        their own policies, not ours.
      </p>

      <h2>7. Quote accuracy</h2>
      <p>
        Quotes are extracted by AI from phone-call transcripts. We do our
        best to capture them accurately, but:
      </p>
      <ul>
        <li>The AI may misunderstand a price or condition.</li>
        <li>
          The pro may have stated a different number than they later
          honor.
        </li>
        <li>
          Prices may change between when we called and when you book.
        </li>
      </ul>
      <p>
        Treat every quote as a{' '}
        <strong>starting point for a conversation</strong>, not a binding
        offer.{' '}
        <strong>
          Always confirm the price, scope, and terms in writing with the
          pro before you pay them anything.
        </strong>
      </p>

      <h2>8. Your content and ours</h2>
      <ul>
        <li>
          <strong>Your inputs</strong> (the form fields, addresses, notes
          you submit) belong to you. By submitting them you grant us a
          limited license to process them as described in the Privacy
          Policy.
        </li>
        <li>
          <strong>Our outputs</strong> (the report, summaries, structured
          quotes) are for your personal use. You may not republish, resell,
          or use them as training data for any third-party AI service.
        </li>
        <li>
          <strong>The EvenQuote name, logo, design, and software</strong>{' '}
          are our property. These terms don&rsquo;t grant you rights to
          any of that beyond using the service.
        </li>
      </ul>

      <h2>9. Disclaimers</h2>
      <p>
        <strong>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
          AVAILABLE.&rdquo;
        </strong>{' '}
        We make no warranty that:
      </p>
      <ul>
        <li>A specific business will answer or respond.</li>
        <li>
          Quotes collected will reflect the price you&rsquo;re ultimately
          charged.
        </li>
        <li>
          The service will be uninterrupted, error-free, or secure beyond
          the standards described in our Privacy Policy.
        </li>
        <li>
          Any pro we call is licensed, insured, qualified, available, or
          trustworthy. <strong>Verify before you hire.</strong>
        </li>
      </ul>
      <p>
        To the maximum extent permitted by law, we disclaim all
        warranties, express or implied, including merchantability, fitness
        for a particular purpose, and non-infringement.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>To the maximum extent permitted by law:</p>
      <ul>
        <li>
          <strong>
            Our total liability to you for anything related to EvenQuote
            is capped at the greater of $100 or the amount you paid us in
            the 12 months before the claim.
          </strong>{' '}
          For most users that means $9.99.
        </li>
        <li>
          We are not liable for indirect, incidental, special,
          consequential, or punitive damages &mdash; including lost
          profits, lost data, or damages from a bad experience with a pro
          you found through the service.
        </li>
        <li>
          We are not liable for the acts or omissions of any pro, whether
          or not we called them on your behalf.
        </li>
      </ul>
      <p>
        Some jurisdictions don&rsquo;t allow these limits. To the extent
        you live in one, the limits apply to the maximum extent allowed.
      </p>

      <h2>11. Indemnification</h2>
      <p>
        If a third party brings a claim against us because of how YOU used
        the service &mdash; for example, you submitted false information,
        harassed a pro, or violated these terms &mdash; you agree to
        indemnify and hold us harmless from that claim, including
        reasonable legal fees.
      </p>

      <h2>12. Termination</h2>
      <p>
        You can stop using EvenQuote at any time and request deletion of
        your data per the Privacy Policy.
      </p>
      <p>
        We may suspend or terminate your access if you violate these
        terms, abuse the service, or attempt to harm other users or pros.
        For paid quote requests in flight at the time of termination, we
        either refund the request or complete it, at our discretion.
      </p>

      <h2>13. Governing law and disputes</h2>
      <p>
        These terms are governed by the laws of {GOVERNING_LAW}, without
        regard to conflict-of-law rules.
      </p>
      <p>
        <strong>Disputes &mdash; first try to resolve directly.</strong>{' '}
        Email{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>
          {PRIMARY_CONTACT_EMAIL}
        </a>{' '}
        with the issue. We commit to responding within 14 days.
      </p>
      <p>
        If we can&rsquo;t resolve it directly,{' '}
        <strong>
          disputes will be settled by binding arbitration
        </strong>{' '}
        under the rules of the American Arbitration Association in{' '}
        {ARBITRATION_VENUE},{' '}
        <strong>
          except that either party may bring small-claims actions in their
          home jurisdiction.
        </strong>{' '}
        You waive the right to a jury trial and to participate in a class
        action.
      </p>
      <p>
        You may opt out of this arbitration clause within 30 days of first
        using EvenQuote by emailing{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>
          {PRIMARY_CONTACT_EMAIL}
        </a>{' '}
        with &ldquo;arbitration opt-out&rdquo; in the subject line.
      </p>

      <h2>14. Changes to these terms</h2>
      <p>
        We update the &ldquo;Last updated&rdquo; date when we change these
        terms. For material changes (anything affecting your fees, refund
        policy, or dispute resolution), we email everyone with an active
        account at least 14 days before the change takes effect.
      </p>
      <p>
        If you keep using EvenQuote after the change, that&rsquo;s
        acceptance. If you don&rsquo;t agree, stop using the service and
        request deletion.
      </p>

      <h2>15. Contact</h2>
      <p>
        General support, refunds, billing, legal questions &mdash; one
        address:{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>
          {PRIMARY_CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        Mailing address: {LEGAL_ENTITY}, {BUSINESS_ADDRESS}.
      </p>
    </>
  );
}
