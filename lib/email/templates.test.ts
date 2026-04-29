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
  type QuoteReportInput,
  type ContactReleaseInput,
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
