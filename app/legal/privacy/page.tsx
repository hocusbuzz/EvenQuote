// Privacy Policy.
//
// Draft — NOT LEGAL ADVICE. Antonio, please have this reviewed by counsel
// before linking it from the footer or submitting it to Stripe.
//
// Copy tone: plain-English, specific about the data we collect and why,
// in line with the EvenQuote voice (matter-of-fact, no corporate mush).

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How EvenQuote handles your data — what we collect, why, and what you can do about it.',
  // Defense-in-depth: this page is a draft pending counsel review and is
  // intentionally not linked from the footer. Keep it out of search until
  // the legal review lands. Flip to { index: true } at publish time.
  robots: { index: false, follow: false },
};

// TODO(antonio): replace with the date you publish, and confirm jurisdiction.
const LAST_UPDATED = 'April 22, 2026';

export default function PrivacyPage() {
  return (
    <>
      <p className="label-eyebrow text-muted-foreground">Legal</p>
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>

      <p>
        This policy covers EvenQuote's handling of personal information. It's
        written to be read, not to be filed. If something here is unclear,
        email us at{' '}
        <a href="mailto:privacy@evenquote.com">privacy@evenquote.com</a> and we'll
        answer.
      </p>

      <h2>What we collect</h2>
      <p>When you request quotes through EvenQuote, we collect:</p>
      <ul>
        <li>
          <strong>Contact details</strong> you provide — name, email, phone, and
          the address or ZIP relevant to the job.
        </li>
        <li>
          <strong>Job details</strong> you provide — the specifics of what you
          want priced (move size, cleaning frequency, etc.).
        </li>
        <li>
          <strong>Payment metadata</strong> — we don't see your card number;
          Stripe handles it. We keep a transaction ID, amount, and status.
        </li>
        <li>
          <strong>Call recordings and transcripts</strong> of the outbound calls
          we make to service providers on your behalf, plus any structured
          quote data extracted from them.
        </li>
        <li>
          <strong>Technical telemetry</strong> — IP address, browser type, and
          request timestamps, for security and debugging.
        </li>
      </ul>

      <h2>Why we collect it</h2>
      <p>
        The contact and job details are what the service providers we call on
        your behalf need in order to quote accurately. Without them, we can't
        do the thing you paid us to do.
      </p>
      <p>
        Payment metadata is retained for accounting and refund handling. Call
        recordings let us re-extract quotes if our first pass misses something,
        and they help us catch abuse on the provider side.
      </p>

      <h2>Who we share it with</h2>
      <ul>
        <li>
          <strong>The service providers we call on your behalf.</strong> They
          hear your name, job details, and the destination address or ZIP —
          because that's what a quote needs. They do not see your email
          address, phone number, or payment details unless you choose to
          release your contact via the dashboard.
        </li>
        <li>
          <strong>Stripe</strong> for payment processing.
        </li>
        <li>
          <strong>Vapi</strong> (our telephony partner) for placing calls and
          returning transcripts.
        </li>
        <li>
          <strong>Supabase</strong> for hosting the database.
        </li>
        <li>
          <strong>Resend</strong> for sending transactional email.
        </li>
        <li>
          <strong>Anthropic</strong> for processing call transcripts into
          structured quotes. Transcripts are sent via API and are not used to
          train models.
        </li>
      </ul>
      <p>
        We don't sell your personal information and we don't share it with
        advertisers.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Quote requests and associated data: retained for 24 months.</li>
        <li>Call recordings: 90 days, then deleted.</li>
        <li>Payment records: 7 years, as required by U.S. tax law.</li>
      </ul>

      <h2>Your rights</h2>
      <p>You can email <a href="mailto:privacy@evenquote.com">privacy@evenquote.com</a> to:</p>
      <ul>
        <li>Get a copy of the data we have about you.</li>
        <li>Ask us to correct something that's wrong.</li>
        <li>Ask us to delete your data (subject to legal retention limits).</li>
        <li>Opt out of any non-essential processing.</li>
      </ul>
      <p>
        We'll respond within 30 days. If you're in the EU or UK, you also have
        rights under GDPR including the right to lodge a complaint with your
        local data protection authority.
      </p>

      <h2>Cookies and tracking</h2>
      <p>
        We use a small set of first-party cookies for authentication and
        session management. We don't run third-party tracking pixels or ad
        networks.
      </p>

      <h2>Security</h2>
      <p>
        All traffic uses HTTPS. Our database enforces row-level security and
        we never expose administrative credentials to the browser. If we learn
        of a data incident affecting your information, we'll notify you within
        72 hours as required by law.
      </p>

      <h2>Children</h2>
      <p>
        EvenQuote is not intended for children under 13 and we do not knowingly
        collect information from them. If you believe we have, please email us
        and we'll delete it.
      </p>

      <h2>Changes</h2>
      <p>
        We'll update the "Last updated" date above when we change this policy
        and, for material changes, email existing customers.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href="mailto:privacy@evenquote.com">privacy@evenquote.com</a>.
      </p>
    </>
  );
}
