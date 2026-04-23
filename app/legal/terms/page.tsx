// Terms of Service.
//
// Draft — NOT LEGAL ADVICE. Antonio, please have this reviewed by counsel
// before linking from the footer or submitting to Stripe. In particular,
// the liability cap, arbitration clause, and governing-law choice should
// be confirmed for your jurisdiction.
//
// Copy tone: plain-English, honest about what we are and aren't, in line
// with the EvenQuote voice. No 80s-style all-caps blocks except where the
// law typically expects them (disclaimers, limitation of liability).

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern your use of EvenQuote.',
  // Defense-in-depth: this page is a draft pending counsel review and is
  // intentionally not linked from the footer. Keep it out of search until
  // the legal review lands. Flip to { index: true } at publish time.
  robots: { index: false, follow: false },
};

// TODO(antonio): set to the date you publish, and confirm governing-law state.
const LAST_UPDATED = 'April 22, 2026';
const GOVERNING_LAW = 'the State of [TBD]'; // TODO(antonio): pick jurisdiction

export default function TermsPage() {
  return (
    <>
      <p className="label-eyebrow text-muted-foreground">Legal</p>
      <h1>Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>

      <p>
        These terms govern your use of EvenQuote. By paying for a quote run or
        otherwise using the service, you agree to them. If you don't agree,
        don't use the service. If something here is unclear, email{' '}
        <a href="mailto:support@evenquote.com">support@evenquote.com</a>.
      </p>

      <h2>What EvenQuote does</h2>
      <p>
        EvenQuote calls service providers on your behalf, using an AI agent,
        and returns a list of the quotes those providers gave. We are not a
        moving company, cleaning company, or any other kind of service
        provider. We are a quoting service: we place calls, extract the
        numbers, and show them to you.
      </p>
      <p>
        Any agreement you enter with a service provider — to book, to pay, to
        schedule — is strictly between you and them. EvenQuote is not a party
        to that agreement and does not guarantee the provider's work, price,
        availability, licensing, insurance, or anything else about them.
      </p>

      <h2>Payment and refunds</h2>
      <p>
        A quote run costs $9.99, charged once per request via Stripe. This is
        a flat fee for the calling service, not a deposit toward any job.
      </p>
      <p>
        If we call every provider we select and return zero usable quotes, we
        automatically refund your $9.99 — you don't need to ask. Otherwise,
        the fee is non-refundable: you paid for calls to be made, and they
        were made. If you believe a charge was made in error (for example, a
        duplicate charge), email{' '}
        <a href="mailto:support@evenquote.com">support@evenquote.com</a> and
        we'll look into it within five business days.
      </p>

      <h2>Your account and submissions</h2>
      <p>
        You are responsible for the accuracy of the information you submit
        (your contact details, the job specifics). Submitting someone else's
        contact information, or fabricating a job to harass a provider, is a
        violation of these terms and will get you banned.
      </p>
      <p>
        You must be 18 or older to use EvenQuote.
      </p>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the service to harass, defraud, or spam any provider.</li>
        <li>
          Submit requests for illegal services, or for services in
          jurisdictions where we don't operate.
        </li>
        <li>
          Attempt to reverse-engineer, scrape, or overload any part of the
          service.
        </li>
        <li>
          Resell, sublicense, or white-label EvenQuote without a written
          agreement.
        </li>
      </ul>
      <p>
        We reserve the right to refuse service, refund the fee, and terminate
        accounts that violate these rules.
      </p>

      <h2>The providers we call</h2>
      <p>
        We pick providers from publicly available business listings and from
        our own vetted set. We don't pay providers to appear and we don't
        take commissions from them. The providers we call are not our
        employees or agents — they are independent businesses. We don't
        verify their licensing, insurance, quality of work, or anything
        beyond the phone number we dialed.
      </p>
      <p>
        Quote accuracy depends on the provider. If a provider misstates a
        price on the call, or changes their price later, that is between you
        and them.
      </p>

      <h2>Call recordings</h2>
      <p>
        All calls placed through EvenQuote are recorded and transcribed. Our
        AI agent identifies itself as an AI at the start of each call and
        discloses that the call is recorded, in compliance with U.S.
        two-party consent laws. Recordings are retained for 90 days (see the{' '}
        <a href="/legal/privacy">Privacy Policy</a>).
      </p>

      <h2>Our content and yours</h2>
      <p>
        The site, its code, its copy, and the EvenQuote name and branding are
        ours. You get a limited, non-transferable license to use them for the
        purpose of requesting quotes. The quote data we return to you is
        yours to use however you like.
      </p>

      <h2>Disclaimers</h2>
      <p>
        THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES
        OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
        NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
        UNINTERRUPTED, ERROR-FREE, OR THAT EVERY CALL WILL CONNECT OR PRODUCE
        A USABLE QUOTE.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, EVENQUOTE'S TOTAL LIABILITY
        TO YOU FOR ANY CLAIM ARISING OUT OF OR RELATED TO THE SERVICE IS
        LIMITED TO THE AMOUNT YOU PAID US FOR THE QUOTE RUN AT ISSUE
        (TYPICALLY $9.99). WE ARE NOT LIABLE FOR INDIRECT, INCIDENTAL,
        CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY ACT OR OMISSION OF A
        SERVICE PROVIDER YOU CONTRACT WITH.
      </p>

      <h2>Indemnification</h2>
      <p>
        You agree to indemnify EvenQuote against claims arising from your
        misuse of the service, your violation of these terms, or your
        contracts with service providers.
      </p>

      <h2>Governing law and disputes</h2>
      <p>
        These terms are governed by the laws of {GOVERNING_LAW}, without
        regard to conflict-of-laws rules. Any dispute will be resolved by
        binding arbitration on an individual basis — no class actions. You
        may opt out of arbitration within 30 days of first agreeing to these
        terms by emailing{' '}
        <a href="mailto:legal@evenquote.com">legal@evenquote.com</a>.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. When we do, we'll bump the "Last updated"
        date above. For material changes, we'll email existing customers and
        give at least 14 days' notice before the new terms take effect.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="mailto:support@evenquote.com">support@evenquote.com</a>.
        Legal notices:{' '}
        <a href="mailto:legal@evenquote.com">legal@evenquote.com</a>.
      </p>
    </>
  );
}
