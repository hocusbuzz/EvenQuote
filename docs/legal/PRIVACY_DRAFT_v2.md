# Privacy Policy — DRAFT v2

> **STATUS:** Draft for Antonio's review, R47.5. Not legal advice.
> Have counsel review before linking from the footer.
>
> **Source basis:** CCPA/CPRA (California) + GDPR (EU/UK) framework
> sections sourced from public-domain regulatory guidance, customized
> to EvenQuote's actual data flows. Equivalent in coverage to a paid
> Termly/TermsFeed template for a SaaS product that records calls
> and processes payments. Total reading time: ~6 minutes.

**Last updated:** [PUBLISH DATE]

This policy covers EvenQuote's handling of personal information. It's
written to be read, not filed. If something is unclear, email
**privacy@evenquote.com** and we'll answer.

## Who we are

EvenQuote is a service operated by [LEGAL ENTITY NAME], a
[Delaware C-Corp / California LLC / sole proprietorship — pick one]
with an office at [BUSINESS ADDRESS]. When this policy says "we" or
"us," that's the entity above.

For privacy questions, contact: **privacy@evenquote.com**.
For all other support: **support@evenquote.com**.

## What we do, in one paragraph

You tell us about a job (move, cleaning, handyman, lawn). We charge
you $9.99. Our AI assistant calls local pros on your behalf, asks
the questions you'd ask, records and transcribes those calls, and
emails you a side-by-side comparison report. We never share your
contact details with a business unless you click the "share my
contact" button on the report. We never sell your data, and we
don't run third-party ad pixels.

## What we collect

### From you, when you submit a quote request

- **Identity:** name, email, phone number.
- **Job details:** addresses (origin and destination for moving,
  service address for cleaning/handyman/lawn), home size, dates,
  flexibility, special items, and any free-text notes you add.
- **Authentication:** an email address used to sign you in via a
  magic-link. We do not collect or store passwords.

### From your interaction with the site

- **Technical:** IP address, browser type, referring page, and
  similar HTTP-level metadata. Used for abuse prevention and
  basic logs. Logs are retained for 30 days then rotated out.
- **Cookies:** a small set of first-party cookies for session
  authentication and CSRF protection. We do **not** run analytics
  pixels, ad networks, or third-party trackers.

### From third parties acting on your behalf

- **Payment metadata** from Stripe (last 4 digits of card, brand,
  country, and a Stripe customer/charge ID). We never receive or
  store your full card number.
- **Address suggestions** from Google Places (you typed; we
  proxied the request server-side so Google does not see your IP).

### Generated during the service

- **Call transcripts** — text transcriptions of the AI's calls to
  local pros, stored alongside each request.
- **Call recordings** — audio of the same calls, stored short-term
  for quality assurance and dispute resolution.
- **Structured quote data** — the AI extracts price ranges,
  availability, and notes from each transcript and stores them as
  fields on a quote record.

### What we do NOT collect

- Government IDs (SSN, passport, driver's license).
- Health or medical data.
- Race, ethnicity, religion, sexual orientation, political views,
  union membership, or biometric identifiers.
- Geolocation beyond the address you typed.
- The contents of your other emails, files, or accounts.

## Why we collect it

Each piece of data has a specific purpose:

| Data | Purpose | Legal basis (EU/UK) |
|---|---|---|
| Identity + job details | Run the service you paid for | Performance of contract |
| Payment metadata | Process and refund the $9.99 | Performance of contract |
| Call recordings + transcripts | Quality assurance, dispute resolution, generating the report you receive | Performance of contract; legitimate interest in QA |
| IP / browser metadata | Abuse prevention, debugging | Legitimate interest |
| Email address | Authentication, report delivery | Performance of contract |

We do not use any of this data for behavioral advertising or
profiling, and we do not transfer your data to third parties for
their own marketing purposes.

## Call recording disclosure

The AI assistant **announces that it is an AI at the start of every
call** ("Hi, I'm calling on behalf of a real customer in [city] —
quick heads-up, by law I have to disclose I'm an AI assistant.").
This satisfies California's BOT disclosure law (SB 1001). The
business on the other end can choose to continue or hang up.

By submitting a quote request, you authorize us to identify you (by
city/state — never your full address or contact details) to the
businesses we call, and to record and transcribe those calls for the
purposes listed above.

## Who we share it with

We share data only with these specific service providers, only for
the purposes they need:

| Service | What they get | Why |
|---|---|---|
| **Supabase** (database, auth) | All stored data | Database hosting; bound by their DPA |
| **Vercel** (hosting) | All HTTP traffic in transit | Application hosting |
| **Stripe** (payments) | Payment + email | Processing the $9.99 |
| **Resend** (email) | Recipient email + email body | Sending magic-link + report |
| **Vapi** (voice AI) | Transcript + recording + business phone | Running the calls |
| **Twilio** (telephony, via Vapi) | Phone number connectivity | Placing the calls |
| **Anthropic** (LLM) | Call transcripts (text only) | Extracting structured quotes. Per Anthropic's enterprise terms, transcripts are NOT used to train models. |
| **Google Places** | Address strings you typed | Address autocomplete + business directory data |

We do **not** share your data with:
- Advertising networks
- Data brokers
- Marketing or analytics companies
- Other quote-shopping or referral services

We share your **contact information** with a specific business only
when **you click "Share my contact" on a quote in your dashboard**.
Until you do, that business knows only your city and the job
parameters.

## Sale or sharing of personal information (CCPA/CPRA)

We do not "sell" your personal information as defined by the CCPA,
and we do not "share" it for cross-context behavioral advertising.
California residents have the right to opt out of any future sale
or sharing — but there is nothing to opt out of today. If we ever
change that, we will give 30 days' notice and an opt-out link.

## How long we keep it

We retain personal information only as long as we need it to provide
the service, comply with legal obligations, resolve disputes, and
enforce our agreements. Specifically:

- **Quote requests, transcripts, and associated data:** kept while
  your account is active and for a reasonable period after, in case
  you want to reference a past report. You can request deletion at
  any time.
- **Call recordings:** kept short-term for quality assurance and
  dispute resolution, then deleted.
- **Payment records:** retained for at least 7 years to comply
  with U.S. tax and accounting law.

We are still refining the specific retention windows for each
category based on real launch usage and will publish concrete
day-counts in the next revision of this policy.

## Your rights

Email **privacy@evenquote.com** to:

- Get a copy of the data we have about you.
- Correct something we have wrong.
- Delete your data (subject to the 7-year payment-record exception
  required by tax law).
- Receive your data in a portable format (JSON).
- Opt out of any non-essential processing (today there is none).
- Withdraw consent for call recording, which stops future calls
  on your behalf.

We respond within 30 days. If you're in the EU, UK, or California,
you also have the right to lodge a complaint with your local data
protection authority (CNIL, ICO, the California Attorney General).

## Security

- All traffic is HTTPS-only.
- Database access enforces row-level security; administrative
  credentials never reach the browser.
- Payment card data never touches our servers — Stripe handles it
  end-to-end and we receive only metadata.
- We use industry-standard hashing for any sensitive lookups.
- If we learn of a data incident affecting your information, we
  notify you within 72 hours where required by law (GDPR; many U.S.
  state laws).

No security is perfect. If you spot something concerning, email
**security@evenquote.com**.

## International transfers

Our hosting (Vercel, Supabase, Stripe, Resend, Vapi, Anthropic) is
primarily in the United States. If you submit a request from the
EU, UK, or anywhere outside the U.S., your data is transferred to
and processed in the U.S. We rely on Standard Contractual Clauses
and the EU-U.S. Data Privacy Framework where applicable.

## Children

EvenQuote is not intended for children under 13 and we do not
knowingly collect information from them. If you believe we have,
please email us and we'll delete it.

## Changes to this policy

We update the "Last updated" date when we change this policy. For
material changes (anything affecting your rights or what we collect
beyond the existing list), we email everyone with an active
account at least 14 days before the change takes effect.

## Contact

- **Privacy questions / requests:** privacy@evenquote.com
- **Security disclosures:** security@evenquote.com
- **General support:** support@evenquote.com
- **Mailing address:** [BUSINESS ADDRESS]

---

## What I need from you to finalize

I marked five spots that need your real values before publish:

1. `[LEGAL ENTITY NAME]` — the legal name of the company. If you
   haven't formed an entity yet, that's a launch blocker; either
   form one (Stripe Atlas does this in a week) or operate as
   "Antonio [last name] DBA EvenQuote" with appropriate disclosure.
2. `[Delaware C-Corp / California LLC / sole proprietorship]` —
   what kind of entity it is.
3. `[BUSINESS ADDRESS]` — a real mailing address (PO box is fine
   for most purposes; some states require a physical address).
4. `[PUBLISH DATE]` — the actual date you publish this.
5. Confirm the email aliases (`privacy@`, `security@`, `support@`)
   exist on your domain — if they don't, swap them for one address
   you actually monitor.

When you've reviewed and given me values for those five, I'll port
this to `app/legal/privacy/page.tsx`, flip the `noindex` flag, and
add the footer link.
