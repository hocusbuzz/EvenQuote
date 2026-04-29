// Privacy Policy.
//
// R47.5: ported from docs/legal/PRIVACY_DRAFT_v2.md after Antonio's
// review. Operator-supplied values (entity, address, publish date,
// contact email) are inlined as constants below — change them here
// when the entity moves or the email changes, then bump LAST_UPDATED.
//
// The page is now indexable and linked from the site footer. If a
// material change later requires hiding it again (e.g. a counsel
// re-review pulls something), flip robots back to noindex AND
// remove the footer link in components/site/footer.tsx.

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    "How EvenQuote handles your data — what we collect, why, and what you can do about it.",
  robots: { index: true, follow: true },
};

// ── Operator-supplied values ──────────────────────────────────────
// One source of truth so the entity name + address + contact emails
// update from a single edit. Mirrors the values in app/legal/terms.
const LEGAL_ENTITY = 'Hocusbuzz LLC';
const ENTITY_TYPE = 'limited liability company';
const BUSINESS_ADDRESS = '845 Applewilde Dr, San Marcos, CA 92078';
const PRIMARY_CONTACT_EMAIL = 'info@hocusbuzz.com';
const LAST_UPDATED = 'May 6, 2026';

export default function PrivacyPage() {
  return (
    <>
      <p className="label-eyebrow text-muted-foreground">Legal</p>
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">
        Last updated: {LAST_UPDATED}
      </p>

      <p>
        This policy covers EvenQuote&rsquo;s handling of personal information.
        It&rsquo;s written to be read, not filed. If something is unclear,
        email{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>{PRIMARY_CONTACT_EMAIL}</a>{' '}
        and we&rsquo;ll answer.
      </p>

      <h2>Who we are</h2>
      <p>
        EvenQuote is a service operated by {LEGAL_ENTITY}, a California{' '}
        {ENTITY_TYPE} with an office at {BUSINESS_ADDRESS}. When this policy
        says &ldquo;we&rdquo; or &ldquo;us,&rdquo; that&rsquo;s the entity
        above.
      </p>
      <p>
        For privacy questions, support, or any of the rights described below,
        contact:{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>{PRIMARY_CONTACT_EMAIL}</a>.
      </p>

      <h2>What we do, in one paragraph</h2>
      <p>
        You tell us about a job (move, cleaning, handyman, lawn). We charge
        you $9.99. Our AI assistant calls local pros on your behalf, asks
        the questions you&rsquo;d ask, records and transcribes those calls,
        and emails you a side-by-side comparison report. We never share your
        contact details with a business unless you click the &ldquo;share my
        contact&rdquo; button on the report. We never sell your data, and we
        don&rsquo;t run third-party ad pixels.
      </p>

      <h2>What we collect</h2>

      <h3>From you, when you submit a quote request</h3>
      <ul>
        <li>
          <strong>Identity:</strong> name, email, phone number.
        </li>
        <li>
          <strong>Job details:</strong> addresses (origin and destination for
          moving, service address for cleaning/handyman/lawn), home size,
          dates, flexibility, special items, and any free-text notes you
          add.
        </li>
        <li>
          <strong>Authentication:</strong> an email address used to sign you
          in via a magic link. We do not collect or store passwords.
        </li>
      </ul>

      <h3>From your interaction with the site</h3>
      <ul>
        <li>
          <strong>Technical:</strong> IP address, browser type, referring
          page, and similar HTTP-level metadata. Used for abuse prevention
          and basic logs. Logs are retained for 30 days then rotated out.
        </li>
        <li>
          <strong>Cookies:</strong> a small set of first-party cookies for
          session authentication and CSRF protection. We do <em>not</em> run
          analytics pixels, ad networks, or third-party trackers.
        </li>
      </ul>

      <h3>From third parties acting on your behalf</h3>
      <ul>
        <li>
          <strong>Payment metadata</strong> from Stripe (last 4 digits of
          card, brand, country, and a Stripe customer/charge ID). We never
          receive or store your full card number.
        </li>
        <li>
          <strong>Address suggestions</strong> from Google Places (you typed;
          we proxied the request server-side so Google does not see your
          IP).
        </li>
      </ul>

      <h3>Generated during the service</h3>
      <ul>
        <li>
          <strong>Call transcripts</strong> &mdash; text transcriptions of
          the AI&rsquo;s calls to local pros, stored alongside each
          request.
        </li>
        <li>
          <strong>Call recordings</strong> &mdash; audio of the same calls,
          stored short-term for quality assurance and dispute resolution.
        </li>
        <li>
          <strong>Structured quote data</strong> &mdash; the AI extracts
          price ranges, availability, and notes from each transcript and
          stores them as fields on a quote record.
        </li>
      </ul>

      <h3>What we do NOT collect</h3>
      <ul>
        <li>Government IDs (SSN, passport, driver&rsquo;s license).</li>
        <li>Health or medical data.</li>
        <li>
          Race, ethnicity, religion, sexual orientation, political views,
          union membership, or biometric identifiers.
        </li>
        <li>Geolocation beyond the address you typed.</li>
        <li>The contents of your other emails, files, or accounts.</li>
      </ul>

      <h2>Why we collect it</h2>
      <p>Each piece of data has a specific purpose:</p>
      <ul>
        <li>
          <strong>Identity + job details:</strong> to run the service you
          paid for. (EU/UK legal basis: performance of contract.)
        </li>
        <li>
          <strong>Payment metadata:</strong> to process and refund the
          $9.99. (Performance of contract.)
        </li>
        <li>
          <strong>Call recordings + transcripts:</strong> for quality
          assurance, dispute resolution, and generating the report you
          receive. (Performance of contract; legitimate interest in QA.)
        </li>
        <li>
          <strong>IP / browser metadata:</strong> abuse prevention and
          debugging. (Legitimate interest.)
        </li>
        <li>
          <strong>Email address:</strong> authentication and report
          delivery. (Performance of contract.)
        </li>
      </ul>
      <p>
        We do not use any of this data for behavioral advertising or
        profiling, and we do not transfer your data to third parties for
        their own marketing purposes.
      </p>

      <h2>Call recording disclosure</h2>
      <p>
        The AI assistant <strong>announces that it is an AI at the start of
        every call</strong> (&ldquo;Hi, I&rsquo;m calling on behalf of a real
        customer in [city] &mdash; quick heads-up, by law I have to
        disclose I&rsquo;m an AI assistant.&rdquo;). This satisfies
        California&rsquo;s BOT disclosure law (SB 1001). The business on
        the other end can choose to continue or hang up.
      </p>
      <p>
        By submitting a quote request, you authorize us to identify you (by
        city/state &mdash; never your full address or contact details) to
        the businesses we call, and to record and transcribe those calls
        for the purposes listed above.
      </p>

      <h2>Who we share it with</h2>
      <p>
        We share data only with these specific service providers, only for
        the purposes they need:
      </p>
      <ul>
        <li>
          <strong>Supabase</strong> (database, auth) &mdash; all stored
          data; bound by their data-processing agreement.
        </li>
        <li>
          <strong>Vercel</strong> (hosting) &mdash; HTTP traffic in
          transit; application hosting only.
        </li>
        <li>
          <strong>Stripe</strong> (payments) &mdash; payment + email; for
          processing the $9.99.
        </li>
        <li>
          <strong>Resend</strong> (email) &mdash; recipient email + email
          body; for sending the magic link and your report.
        </li>
        <li>
          <strong>Vapi</strong> (voice AI) &mdash; transcript + recording +
          business phone; for running the calls.
        </li>
        <li>
          <strong>Twilio</strong> (telephony, via Vapi) &mdash; phone
          number connectivity; for placing the calls.
        </li>
        <li>
          <strong>Anthropic</strong> (LLM) &mdash; call transcripts (text
          only); for extracting structured quotes. Per Anthropic&rsquo;s
          enterprise terms, transcripts are NOT used to train models.
        </li>
        <li>
          <strong>Google Places</strong> &mdash; address strings you typed;
          for address autocomplete and business directory data.
        </li>
      </ul>
      <p>We do <strong>not</strong> share your data with:</p>
      <ul>
        <li>Advertising networks</li>
        <li>Data brokers</li>
        <li>Marketing or analytics companies</li>
        <li>Other quote-shopping or referral services</li>
      </ul>
      <p>
        We share your <strong>contact information</strong> with a specific
        business <strong>only when you click &ldquo;Share my contact&rdquo;
        on a quote in your dashboard</strong>. Until you do, that business
        knows only your city and the job parameters.
      </p>

      <h2>Sale or sharing of personal information (CCPA/CPRA)</h2>
      <p>
        We do not &ldquo;sell&rdquo; your personal information as defined
        by the CCPA, and we do not &ldquo;share&rdquo; it for cross-context
        behavioral advertising. California residents have the right to opt
        out of any future sale or sharing &mdash; but there is nothing to
        opt out of today. If we ever change that, we will give 30
        days&rsquo; notice and an opt-out link.
      </p>

      <h2>How long we keep it</h2>
      <p>
        We retain personal information only as long as we need it to
        provide the service, comply with legal obligations, resolve
        disputes, and enforce our agreements. Specifically:
      </p>
      <ul>
        <li>
          <strong>Quote requests, transcripts, and associated data:</strong>{' '}
          kept while your account is active and for a reasonable period
          after, in case you want to reference a past report. You can
          request deletion at any time.
        </li>
        <li>
          <strong>Call recordings:</strong> kept short-term for quality
          assurance and dispute resolution, then deleted.
        </li>
        <li>
          <strong>Payment records:</strong> retained for at least 7 years
          to comply with U.S. tax and accounting law.
        </li>
      </ul>
      <p className="text-sm text-muted-foreground">
        We&rsquo;re still refining the specific retention windows for each
        category based on real launch usage and will publish concrete
        day-counts in the next revision of this policy. In the meantime, if
        you want your data deleted sooner, email{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>{PRIMARY_CONTACT_EMAIL}</a>{' '}
        and we&rsquo;ll handle it within 30 days.
      </p>

      <h2>Your rights</h2>
      <p>
        Email{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>{PRIMARY_CONTACT_EMAIL}</a>{' '}
        to:
      </p>
      <ul>
        <li>Get a copy of the data we have about you.</li>
        <li>Correct something we have wrong.</li>
        <li>
          Delete your data (subject to the 7-year payment-record exception
          required by tax law).
        </li>
        <li>Receive your data in a portable format (JSON).</li>
        <li>
          Opt out of any non-essential processing (today there is none).
        </li>
        <li>
          Withdraw consent for call recording, which stops future calls on
          your behalf.
        </li>
      </ul>
      <p>
        We respond within 30 days. If you&rsquo;re in the EU, UK, or
        California, you also have the right to lodge a complaint with your
        local data protection authority (CNIL, ICO, the California Attorney
        General).
      </p>

      <h2>Security</h2>
      <ul>
        <li>All traffic is HTTPS-only.</li>
        <li>
          Database access enforces row-level security; administrative
          credentials never reach the browser.
        </li>
        <li>
          Payment card data never touches our servers &mdash; Stripe
          handles it end-to-end and we receive only metadata.
        </li>
        <li>
          We use industry-standard hashing for any sensitive lookups.
        </li>
        <li>
          If we learn of a data incident affecting your information, we
          notify you within 72 hours where required by law (GDPR; many
          U.S. state laws).
        </li>
      </ul>
      <p>
        No security is perfect. If you spot something concerning, email{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>{PRIMARY_CONTACT_EMAIL}</a>{' '}
        with &ldquo;security&rdquo; in the subject.
      </p>

      <h2>International transfers</h2>
      <p>
        Our hosting (Vercel, Supabase, Stripe, Resend, Vapi, Anthropic) is
        primarily in the United States. If you submit a request from the
        EU, UK, or anywhere outside the U.S., your data is transferred to
        and processed in the U.S. We rely on Standard Contractual Clauses
        and the EU-U.S. Data Privacy Framework where applicable.
      </p>

      <h2>Children</h2>
      <p>
        EvenQuote is not intended for children under 13 and we do not
        knowingly collect information from them. If you believe we have,
        please email us and we&rsquo;ll delete it.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        We update the &ldquo;Last updated&rdquo; date when we change this
        policy. For material changes (anything affecting your rights or
        what we collect beyond the existing list), we email everyone with
        an active account at least 14 days before the change takes effect.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions, security disclosures, support &mdash; one
        address:{' '}
        <a href={`mailto:${PRIMARY_CONTACT_EMAIL}`}>{PRIMARY_CONTACT_EMAIL}</a>.
      </p>
      <p>
        Mailing address: {LEGAL_ENTITY}, {BUSINESS_ADDRESS}.
      </p>
    </>
  );
}
