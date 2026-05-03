// Tests for email templates.
//
// These templates are pure functions but they generate strings that end
// up in customer inboxes — a regression (wrong subject, broken CTA, PII
// leak, HTML injection) ships silently. Tests guard the subject-line
// branches, refund copy branches, and HTML escaping.

import { describe, it, expect } from 'vitest';
import {
  renderQuoteReport,
  renderContactRelease,
  renderCallsScheduled,
  renderNewPaymentAlert,
  renderWinBack,
  type QuoteReportInput,
  type ContactReleaseInput,
  type CallsScheduledInput,
  type NewPaymentAlertInput,
  type WinBackInput,
} from './templates';

function baseQuoteInput(
  overrides: Partial<QuoteReportInput> = {}
): QuoteReportInput {
  return {
    recipientName: 'Jamie',
    categoryName: 'Moving',
    city: 'Austin',
    state: 'TX',
    coverageSummary: 'We reached 3 of 5 pros.',
    dashboardUrl: 'https://evenquote.com/dashboard/requests/abc-123',
    refundOutcome: 'not_applicable',
    quotes: [
      {
        businessName: 'BestMove LLC',
        priceMin: 800,
        priceMax: 1200,
        priceDescription: 'flat rate',
        availability: 'Saturday',
        includes: ['2 movers', 'truck'],
        excludes: ['stairs fee'],
        notes: 'Very friendly',
        requiresOnsiteEstimate: false,
      },
    ],
    ...overrides,
  };
}

describe('renderQuoteReport', () => {
  it('picks the "your quotes" subject when quotes exist', () => {
    const out = renderQuoteReport(baseQuoteInput());
    expect(out.subject.toLowerCase()).toContain('moving quotes');
    expect(out.subject).toContain('Austin');
    expect(out.subject).toContain('TX');
  });

  it('picks the "no quotes yet" subject when the array is empty', () => {
    const out = renderQuoteReport(
      baseQuoteInput({ quotes: [], refundOutcome: 'issued' })
    );
    expect(out.subject.toLowerCase()).toContain('no moving quotes yet');
  });

  it('uses "Hi," when recipientName is null', () => {
    const out = renderQuoteReport(baseQuoteInput({ recipientName: null }));
    expect(out.html).toMatch(/>Hi,</);
    expect(out.text.startsWith('Hi,')).toBe(true);
  });

  it('refund-issued copy mentions refund back to card', () => {
    const out = renderQuoteReport(
      baseQuoteInput({ quotes: [], refundOutcome: 'issued' })
    );
    expect(out.html).toMatch(/refunded your \$9\.99/i);
  });

  it('refund-pending-support copy asks the user to reply for a manual refund', () => {
    const out = renderQuoteReport(
      baseQuoteInput({ quotes: [], refundOutcome: 'pending_support' })
    );
    expect(out.html).toMatch(/process your \$9\.99 refund manually/i);
  });

  it('zero-quote fallback never promises an auto-refund when outcome not_applicable', () => {
    const out = renderQuoteReport(
      baseQuoteInput({ quotes: [], refundOutcome: 'not_applicable' })
    );
    // Should NOT say "we've refunded" when we haven't.
    expect(out.html).not.toMatch(/refunded your \$9\.99/i);
    // Should offer human follow-up.
    expect(out.html).toMatch(/reply to this email/i);
  });

  // ── R47.6: noQuoteCause branching ────────────────────────────────
  //
  // Two distinct zero-quote pathways now produce different copy:
  //   • coverage_gap   — webhook advanced:false; no calls placed.
  //                       Saying "we called the local pros" here
  //                       would be a flat-out lie.
  //   • no_response    — calls were placed but didn't yield usable
  //                       quotes (the legacy zero-quote case).
  //
  // The cause × refundOutcome matrix produces six distinct copy
  // variants. We don't lock all six (snapshot tests would explode);
  // instead we pin the two distinguishing assertions: each cause's
  // explanation appears in its own branch and NOT in the other.
  describe('noQuoteCause branching (R47.6)', () => {
    it("coverage_gap: says 'couldn't find any to call' and never 'we called the local pros'", () => {
      const out = renderQuoteReport(
        baseQuoteInput({
          quotes: [],
          refundOutcome: 'issued',
          noQuoteCause: 'coverage_gap',
          city: 'Austin',
          state: 'TX',
        })
      );
      // Coverage-gap-specific phrasing.
      expect(out.html).toMatch(/couldn&#039;t find any to call/i);
      expect(out.html).toMatch(/Austin/);
      expect(out.html).toMatch(/TX/);
      // Must NOT use the no_response phrasing.
      expect(out.html).not.toMatch(/we called the local pros/i);
      // Refund-issued sub-branch composed in.
      expect(out.html).toMatch(/refunded your \$9\.99/i);
    });

    it("coverage_gap × pending_support: explanation + manual-refund phrasing", () => {
      const out = renderQuoteReport(
        baseQuoteInput({
          quotes: [],
          refundOutcome: 'pending_support',
          noQuoteCause: 'coverage_gap',
        })
      );
      expect(out.html).toMatch(/couldn&#039;t find any to call/i);
      expect(out.html).toMatch(/process your \$9\.99 refund manually/i);
    });

    it("no_response: keeps the 'we called the local pros' phrasing", () => {
      const out = renderQuoteReport(
        baseQuoteInput({
          quotes: [],
          refundOutcome: 'issued',
          noQuoteCause: 'no_response',
        })
      );
      expect(out.html).toMatch(/we called the local pros/i);
      // Must NOT use the coverage-gap phrasing.
      expect(out.html).not.toMatch(/couldn&#039;t find any to call/i);
    });

    it('undefined noQuoteCause defaults to no_response wording (legacy compat)', () => {
      // Pre-R47.6 callers don't pass noQuoteCause at all; the
      // template must keep working with the historic phrasing so
      // existing test fixtures and integration paths don't break.
      const out = renderQuoteReport(
        baseQuoteInput({ quotes: [], refundOutcome: 'issued' })
      );
      expect(out.html).toMatch(/we called the local pros/i);
      expect(out.html).not.toMatch(/couldn&#039;t find any to call/i);
    });
  });

  it('zero-quote fallback never promises an auto-refund when outcome not_applicable (legacy lock)', () => {
    // R47.6 retains the old "fallback never promises an auto-refund"
    // assertion shape but moved it down so the noQuoteCause block
    // groups together. Behavior unchanged.
    const out = renderQuoteReport(
      baseQuoteInput({ quotes: [], refundOutcome: 'not_applicable' })
    );
    expect(out.html).not.toMatch(/refunded your \$9\.99/i);
    expect(out.html).toMatch(/reply to this email/i);
  });

  it('HTML-escapes potentially malicious recipientName', () => {
    const out = renderQuoteReport(
      baseQuoteInput({ recipientName: '<script>alert(1)</script>' })
    );
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('HTML-escapes business name in quote cards', () => {
    const out = renderQuoteReport(
      baseQuoteInput({
        quotes: [
          {
            businessName: 'Evil & Co "</td>"',
            priceMin: 100,
            priceMax: 200,
            priceDescription: null,
            availability: null,
            includes: [],
            excludes: [],
            notes: null,
            requiresOnsiteEstimate: false,
          },
        ],
      })
    );
    // The raw string must NOT appear verbatim.
    expect(out.html).not.toContain('Evil & Co "</td>"');
    expect(out.html).toContain('&amp;');
    expect(out.html).toContain('&quot;');
  });

  it('formats single-value price range without dash', () => {
    const out = renderQuoteReport(
      baseQuoteInput({
        quotes: [
          {
            businessName: 'FlatCo',
            priceMin: 500,
            priceMax: 500,
            priceDescription: null,
            availability: null,
            includes: [],
            excludes: [],
            notes: null,
            requiresOnsiteEstimate: false,
          },
        ],
      })
    );
    expect(out.html).toContain('$500');
    // Shouldn't render `$500–$500`
    expect(out.html).not.toMatch(/\$500[–-]\$500/);
  });

  it('renders "On-site estimate" for null prices with onsite flag', () => {
    const out = renderQuoteReport(
      baseQuoteInput({
        quotes: [
          {
            businessName: 'OnSiteCo',
            priceMin: null,
            priceMax: null,
            priceDescription: null,
            availability: null,
            includes: [],
            excludes: [],
            notes: null,
            requiresOnsiteEstimate: true,
          },
        ],
      })
    );
    expect(out.html).toMatch(/On-site estimate/i);
  });

  it('plain-text version mirrors coverage summary and dashboard URL', () => {
    const out = renderQuoteReport(baseQuoteInput());
    expect(out.text).toContain('We reached 3 of 5 pros');
    expect(out.text).toContain('evenquote.com/dashboard/requests/abc-123');
  });

  // --- Snapshots ---
  //
  // Why snapshots here: the tests above assert targeted invariants
  // (escape, dash format, specific phrases). They won't catch a
  // *silent* refactor that changes the overall body copy or structure.
  // Inline snapshots act as shape guards — any change to the prose or
  // the rendered order fails the test, forcing an intentional update.
  //
  // Inputs are pinned to stable values — no dates, no randomness.

  it('plain-text snapshot — happy path with one quote', () => {
    const out = renderQuoteReport(baseQuoteInput());
    expect(out.text).toMatchInlineSnapshot(`
      "Hi Jamie,

      Here's what we heard from local moving pros in Austin, TX.
      We reached 3 of 5 pros.

      Heads up: these quotes were extracted by AI from recorded phone calls.
      They're a starting point for comparison, not a binding offer.
      Always confirm price + scope in writing with the pro before paying.

      1. BestMove LLC — $800–$1,200
         flat rate
         Available: Saturday
         Includes: 2 movers, truck
         Extras / fees: stairs fee
         Notes: Very friendly

      View the full report and release your contact to a specific pro:
      https://evenquote.com/dashboard/requests/abc-123"
    `);
  });

  it('subject snapshot — zero-quote refund-pending variant', () => {
    const out = renderQuoteReport(
      baseQuoteInput({ quotes: [], refundOutcome: 'pending_support' })
    );
    expect(out.subject).toMatchInlineSnapshot(
      `"We reached out — no moving quotes yet for Austin, TX"`
    );
  });

  it('subject snapshot — happy-path variant', () => {
    const out = renderQuoteReport(baseQuoteInput());
    expect(out.subject).toMatchInlineSnapshot(
      `"Your moving quotes for Austin, TX"`
    );
  });
});

describe('renderContactRelease', () => {
  function baseReleaseInput(
    overrides: Partial<ContactReleaseInput> = {}
  ): ContactReleaseInput {
    return {
      businessName: 'BestMove LLC',
      customerName: 'Jamie Smith',
      customerPhone: '+15551234567',
      customerEmail: 'jamie@example.com',
      categoryName: 'Moving',
      city: 'Austin',
      state: 'TX',
      jobSummary: ['2 bedrooms', 'Saturday'],
      quoteSummary: '$800 flat',
      ...overrides,
    };
  }

  it('subject names the customer and category', () => {
    const out = renderContactRelease(baseReleaseInput());
    expect(out.subject).toContain('Jamie Smith');
    expect(out.subject.toLowerCase()).toContain('moving');
  });

  it('includes customer phone and email in HTML and text', () => {
    const out = renderContactRelease(baseReleaseInput());
    expect(out.html).toContain('+15551234567');
    expect(out.html).toContain('jamie@example.com');
    expect(out.text).toContain('+15551234567');
    expect(out.text).toContain('jamie@example.com');
  });

  it('HTML-escapes customer name to block injection', () => {
    const out = renderContactRelease(
      baseReleaseInput({ customerName: '<b>nope</b>' })
    );
    expect(out.html).not.toContain('<b>nope</b>');
    expect(out.html).toContain('&lt;b&gt;nope&lt;/b&gt;');
  });

  it('renders job-summary bullets', () => {
    const out = renderContactRelease(
      baseReleaseInput({ jobSummary: ['4-bed house', 'Has stairs', 'Piano'] })
    );
    expect(out.html).toContain('4-bed house');
    expect(out.html).toContain('Piano');
    expect(out.text).toContain('• 4-bed house');
  });
});

// ─── renderCallsScheduled ──────────────────────────────────────────
//
// The deferred-dispatch confirmation email (#117 + 2026-05-01 incident).
// Subject + body must be unambiguous about WHEN the calls will happen
// — silence + a magic-link email read as "calls broken" in the real
// customer test that motivated this template.

describe('renderCallsScheduled', () => {
  function baseScheduledInput(
    overrides: Partial<CallsScheduledInput> = {},
  ): CallsScheduledInput {
    return {
      recipientName: 'Pat',
      city: 'San Marcos',
      state: 'CA',
      categoryName: 'Handyman',
      // Monday 9 AM Pacific = 16:00 UTC
      scheduledForIso: '2026-05-04T16:00:00Z',
      serviceAreaTz: 'America/Los_Angeles',
      dashboardUrl: 'https://evenquote.com/get-quotes/success?request=req-abc',
      ...overrides,
    };
  }

  it('subject explicitly states the scheduled time so it cannot be misread as "ready"', () => {
    const out = renderCallsScheduled(baseScheduledInput());
    // The May 2026 incident: customer read magic-link email as "your
    // quotes are ready". Subject must say "calls start <time>" so a
    // glance at the inbox is not ambiguous.
    expect(out.subject.toLowerCase()).toContain('calls start');
    expect(out.subject.toLowerCase()).toContain('queued');
    expect(out.subject.toLowerCase()).toContain('handyman');
  });

  it('renders the scheduled time in the SERVICE-AREA timezone, not UTC', () => {
    const out = renderCallsScheduled(baseScheduledInput());
    // 2026-05-04T16:00:00Z = Monday 9:00 AM PDT (Pacific is UTC-7 in May).
    expect(out.html).toContain('Monday');
    expect(out.html).toContain('9:00');
    expect(out.html.toUpperCase()).toContain('PDT');
    // Must NOT just dump the UTC ISO string at the customer.
    expect(out.html).not.toContain('2026-05-04T16:00:00Z');
  });

  it('mentions the $9.99 went through (acknowledge the payment)', () => {
    const out = renderCallsScheduled(baseScheduledInput());
    expect(out.html).toContain('$9.99');
    expect(out.text).toContain('$9.99');
  });

  it('explains WHY we are deferring (not just "we are deferring")', () => {
    const out = renderCallsScheduled(baseScheduledInput());
    // Customers should understand this is a quality/respect choice,
    // not a system limitation.
    expect(out.html.toLowerCase()).toContain('business hours');
  });

  it('includes the dashboard link in HTML and text', () => {
    const url = 'https://evenquote.com/get-quotes/success?request=req-xyz';
    const out = renderCallsScheduled(baseScheduledInput({ dashboardUrl: url }));
    expect(out.html).toContain(url);
    expect(out.text).toContain(url);
  });

  it('handles missing recipientName (guest checkout) without crashing', () => {
    const out = renderCallsScheduled(
      baseScheduledInput({ recipientName: null }),
    );
    expect(out.html).toContain('Hi,');
    expect(out.text.startsWith('Hi,')).toBe(true);
  });

  it('HTML-escapes city/state to block injection through intake_data', () => {
    const out = renderCallsScheduled(
      baseScheduledInput({ city: '<script>x</script>' }),
    );
    expect(out.html).not.toContain('<script>x</script>');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('renders a different timezone correctly when state is in the eastern zone', () => {
    // Same UTC instant in NYC = 12:00 PM EDT (UTC-4 in May).
    const out = renderCallsScheduled(
      baseScheduledInput({
        state: 'NY',
        city: 'Brooklyn',
        serviceAreaTz: 'America/New_York',
      }),
    );
    expect(out.html).toContain('12:00');
    expect(out.html.toUpperCase()).toContain('EDT');
  });
});

// ─── renderNewPaymentAlert ──────────────────────────────────────────

function baseAlertInput(overrides: Partial<NewPaymentAlertInput> = {}): NewPaymentAlertInput {
  return {
    requestId: 'cbfe6980-6252-4854-a889-1d3231e53df5',
    amountUsd: 9.99,
    categoryName: 'Handyman',
    location: 'San Marcos, CA 92078',
    contactName: 'Antonio',
    contactEmail: 'antonio@example.com',
    adminUrl: 'https://evenquote.com/admin/requests/cbfe6980-6252-4854-a889-1d3231e53df5',
    ...overrides,
  };
}

describe('renderNewPaymentAlert', () => {
  it('subject includes amount, category, and location', () => {
    const out = renderNewPaymentAlert(baseAlertInput());
    expect(out.subject).toContain('$9.99');
    expect(out.subject).toContain('Handyman');
    expect(out.subject).toContain('San Marcos, CA 92078');
  });

  it('subject leads with the money emoji so it reads at a glance in inbox', () => {
    // The leading emoji is a deliberate UX choice — at a glance in
    // a list of subject lines, this row jumps out as "good news,
    // not a stuck-request alert." Locking the prefix.
    const out = renderNewPaymentAlert(baseAlertInput());
    expect(out.subject.startsWith('💰')).toBe(true);
  });

  it('falls back to "Service" when categoryName is null', () => {
    const out = renderNewPaymentAlert(baseAlertInput({ categoryName: null }));
    expect(out.subject).toContain('Service');
    expect(out.html).toContain('service');
  });

  it('renders the request id (first 8 chars) as a clickable admin link when adminUrl is set', () => {
    const out = renderNewPaymentAlert(baseAlertInput());
    expect(out.html).toContain('href="https://evenquote.com/admin/requests/cbfe6980-6252-4854-a889-1d3231e53df5"');
    expect(out.html).toContain('cbfe6980'); // first 8 chars only
    // Don't leak the full UUID into the rendered HTML beyond the href.
    expect(out.html.match(/cbfe6980-6252-4854-a889-1d3231e53df5/g)?.length).toBe(1);
  });

  it('renders the request id as plain code when adminUrl is empty (NEXT_PUBLIC_APP_URL unset)', () => {
    const out = renderNewPaymentAlert(baseAlertInput({ adminUrl: '' }));
    expect(out.html).not.toContain('<a href');
    expect(out.html).toContain('cbfe6980');
  });

  it('includes contact name + email in the customer block when both present', () => {
    const out = renderNewPaymentAlert(baseAlertInput());
    expect(out.html).toContain('Antonio');
    // Email is rendered inside &lt;...&gt; (HTML-escaped angle brackets).
    expect(out.html).toContain('antonio@example.com');
  });

  it('omits the customer block entirely when both name and email are null (no PII placeholder)', () => {
    const out = renderNewPaymentAlert(
      baseAlertInput({ contactName: null, contactEmail: null }),
    );
    expect(out.html).not.toContain('Customer:');
  });

  it('falls back gracefully when only the email is present', () => {
    const out = renderNewPaymentAlert(
      baseAlertInput({ contactName: null }),
    );
    expect(out.html).toContain('antonio@example.com');
    expect(out.html).toContain('(no name)');
  });

  it('mentions the EVENQUOTE_NEW_PAYMENT_ALERTS opt-out so the recipient knows how to mute', () => {
    // Self-documenting unsubscribe instructions — the founder shouldn't
    // need to grep the codebase to find the env var when these get noisy.
    const out = renderNewPaymentAlert(baseAlertInput());
    expect(out.html).toContain('EVENQUOTE_NEW_PAYMENT_ALERTS=false');
    expect(out.text).toContain('EVENQUOTE_NEW_PAYMENT_ALERTS=false');
  });

  it('escapes HTML in customer-supplied fields (XSS guard)', () => {
    // contactName + contactEmail come from intake_data which is
    // user-controlled. A malicious customer could put script tags
    // there expecting to land in the founder's email client. We
    // assert the dangerous CHARS (raw <, ", ') don't survive — the
    // resulting string may still contain the substring 'alert(1)'
    // as plain text, which is fine: it can't execute without the
    // surrounding tag context.
    const out = renderNewPaymentAlert(
      baseAlertInput({
        contactName: '<script>alert(1)</script>',
        contactEmail: '"><img src=x onerror=alert(1)>',
      }),
    );
    // The literal opening-tag forms must not survive escaping.
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<img ');
    // And the escaped forms must be present, proving the escape ran.
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&lt;img');
  });

  it('text version contains the request id and admin URL', () => {
    const out = renderNewPaymentAlert(baseAlertInput());
    expect(out.text).toContain('cbfe6980-6252-4854-a889-1d3231e53df5');
    expect(out.text).toContain('https://evenquote.com/admin/requests/');
  });
});

// ─── renderWinBack ──────────────────────────────────────────────────

function baseWinBackInput(overrides: Partial<WinBackInput> = {}): WinBackInput {
  return {
    recipientName: 'Antonio',
    categoryName: 'Handyman',
    categorySlug: 'handyman',
    location: 'San Marcos, CA',
    daysSincePriorRequest: 14,
    ctaUrl: 'https://evenquote.com/get-quotes/handyman?utm_source=evenquote&utm_medium=email&utm_campaign=winback',
    ...overrides,
  };
}

describe('renderWinBack', () => {
  it('subject is short, lowercase-vertical, ends with question mark', () => {
    // Locked: short subject reads better in inbox, lowercase vertical
    // matches body voice ("a handyman job", not "a Handyman job"), and
    // the question mark is the tonal anchor that distinguishes this
    // from a transactional notification.
    const out = renderWinBack(baseWinBackInput());
    expect(out.subject).toBe('Another handyman job to quote?');
  });

  it('greets by name when present, falls back to "Hi," otherwise', () => {
    const named = renderWinBack(baseWinBackInput());
    expect(named.html).toContain('Hi Antonio,');
    const anon = renderWinBack(baseWinBackInput({ recipientName: null }));
    expect(anon.html).toContain('Hi,');
    expect(anon.html).not.toMatch(/Hi null/);
  });

  it('mentions the prior vertical + city + days-ago in the body so it doesn\'t read as generic blast', () => {
    const out = renderWinBack(baseWinBackInput());
    expect(out.html).toMatch(/14 days ago/);
    expect(out.html).toMatch(/handyman job/);
    expect(out.html).toContain('San Marcos, CA');
  });

  it('CTA links to the per-vertical intake URL passed in (utm tags survive escaping)', () => {
    const out = renderWinBack(baseWinBackInput());
    // escapeHtml turns & into &amp; — so the asserted form is the
    // post-escape URL Google's analytics will receive.
    expect(out.html).toContain('href="https://evenquote.com/get-quotes/handyman?utm_source=evenquote&amp;utm_medium=email&amp;utm_campaign=winback"');
    expect(out.html).toContain('Start another handyman request');
  });

  it('body includes the opt-out instruction so the recipient knows how to silence', () => {
    // Self-documenting opt-out — without this we have to handle
    // "stop emailing me" support tickets manually.
    const out = renderWinBack(baseWinBackInput());
    expect(out.html).toMatch(/no thanks/);
    expect(out.text).toMatch(/no thanks/);
  });

  it('reuses the same htmlShell chrome as other branded emails (consistency lock)', () => {
    // If a future "win-back redesign" forks the chrome, this test
    // catches it. Same surface every customer email uses.
    const out = renderWinBack(baseWinBackInput());
    expect(out.html).toContain('<!doctype html>');
    expect(out.html).toContain('background-color:#F5F1E8');
  });

  it('escapes HTML in customer-supplied fields (XSS guard via recipientName, categoryName, location)', () => {
    const out = renderWinBack(
      baseWinBackInput({
        recipientName: '<script>alert(1)</script>',
        categoryName: 'Handy<img src=x>man',
        location: 'San Marcos"><b>',
      }),
    );
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).not.toContain('<img src=x>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&lt;img');
    expect(out.html).toContain('&quot;');
  });

  it('text version is plain and includes the CTA URL un-escaped', () => {
    // text/plain alternative is what spam filters parse + what
    // Apple Mail's preview pane shows — don't HTML-escape it.
    const out = renderWinBack(baseWinBackInput());
    expect(out.text).toContain('Hi Antonio,');
    expect(out.text).toContain('https://evenquote.com/get-quotes/handyman?utm_source=evenquote&utm_medium=email&utm_campaign=winback');
    expect(out.text).not.toContain('<');
  });
});
