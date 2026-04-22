// Transactional email templates.
//
// Design rules:
//   • Plain HTML strings — no React renderer. Keeps the email module
//     server-only with zero extra deps.
//   • Inline styles only. Gmail/Outlook strip <style> blocks.
//   • System fonts. Custom fonts don't survive most clients.
//   • A plain-text alternative for every template — accessibility +
//     inbox-placement signal.
//   • One clear CTA. Buttons are tables so Outlook renders them.
//
// Templates are pure functions → (data) → { subject, html, text }. The
// caller is responsible for passing them to lib/email/resend.ts.

export type Rendered = {
  subject: string;
  html: string;
  text: string;
};

// ─── Shared chrome ──────────────────────────────────────────────────

function htmlShell(innerHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background-color:#F5F1E8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#0A0A0A;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F1E8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; width:100%; background-color:#ffffff; border:2px solid #0A0A0A; border-radius:12px; overflow:hidden;">
            <tr>
              <td style="padding:28px 32px; border-bottom:1px solid #e5e5e5;">
                <span style="font-family: Georgia, 'Times New Roman', serif; font-size:22px; font-weight:800; letter-spacing:-0.02em;">EvenQuote</span>
                <span style="display:inline-block; margin-left:8px; padding:2px 8px; font-size:10px; letter-spacing:0.15em; text-transform:uppercase; background-color:#CEFF00; border:1px solid #0A0A0A; border-radius:4px;">Quotes</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">${innerHtml}</td>
            </tr>
            <tr>
              <td style="padding:20px 32px; border-top:1px solid #e5e5e5; font-size:12px; color:#6b7280;">
                Questions? Reply to this email — it reaches a real person.<br/>
                EvenQuote · evenquote.com
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr>
      <td style="background-color:#CEFF00; border:2px solid #0A0A0A; border-radius:8px; box-shadow: 4px 4px 0 0 #0A0A0A;">
        <a href="${escapeHtml(href)}" style="display:inline-block; padding:14px 24px; font-weight:700; text-decoration:none; color:#0A0A0A;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatPriceRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'On-site estimate';
  if (min != null && max != null && min !== max) {
    return `$${formatUsd(min)}–$${formatUsd(max)}`;
  }
  const single = min ?? max!;
  return `$${formatUsd(single)}`;
}

function formatUsd(n: number): string {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ─── 1. Quote report (customer) ─────────────────────────────────────
//
// Sent when a quote_request flips status → 'completed'. Lists each
// quote side-by-side with a CTA back to the dashboard detail view,
// where the customer can click through to release their contact.

export type QuoteForReport = {
  businessName: string;
  priceMin: number | null;
  priceMax: number | null;
  priceDescription: string | null;
  availability: string | null;
  includes: string[] | null;
  excludes: string[] | null;
  notes: string | null;
  requiresOnsiteEstimate: boolean;
};

/**
 * What happened with the customer's refund when the zero-quote path was
 * hit. Drives the email copy — we don't want to promise "refund coming"
 * if the Stripe call failed, and we don't want to say nothing when one
 * was actually issued.
 *
 *   'issued'           — Stripe refund created successfully. User gets
 *                         money back in 5-10 business days.
 *   'pending_support'  — We tried to refund but Stripe returned an error.
 *                         Copy asks the user to reply to the email and
 *                         support will process it manually.
 *   'not_applicable'   — Quotes were collected; no refund relevant.
 */
export type RefundOutcome = 'issued' | 'pending_support' | 'not_applicable';

export type QuoteReportInput = {
  recipientName: string | null;
  categoryName: string;
  city: string;
  state: string;
  quotes: QuoteForReport[];
  dashboardUrl: string;
  /** e.g. "3 of 5 pros reached" — gives context on no-answers. */
  coverageSummary: string;
  /** Only consulted when quotes.length === 0. */
  refundOutcome?: RefundOutcome;
};

export function renderQuoteReport(input: QuoteReportInput): Rendered {
  const greeting = input.recipientName ? `Hi ${escapeHtml(input.recipientName)},` : 'Hi,';
  const subject =
    input.quotes.length > 0
      ? `Your ${input.categoryName.toLowerCase()} quotes for ${input.city}, ${input.state}`
      : `We reached out — no ${input.categoryName.toLowerCase()} quotes yet for ${input.city}, ${input.state}`;

  const quoteCards = input.quotes
    .map((q, i) => {
      const price = formatPriceRange(q.priceMin, q.priceMax);
      const availability = q.availability
        ? `<div style="margin-top:6px; font-size:13px; color:#6b7280;">Available: ${escapeHtml(q.availability)}</div>`
        : '';
      const includes = (q.includes ?? []).length
        ? `<div style="margin-top:10px; font-size:13px;"><strong>Included:</strong> ${escapeHtml((q.includes ?? []).join(', '))}</div>`
        : '';
      const excludes = (q.excludes ?? []).length
        ? `<div style="margin-top:6px; font-size:13px;"><strong>Not included:</strong> ${escapeHtml((q.excludes ?? []).join(', '))}</div>`
        : '';
      const notes = q.notes
        ? `<div style="margin-top:10px; font-size:13px; color:#374151; font-style:italic;">"${escapeHtml(q.notes)}"</div>`
        : '';
      const onsite = q.requiresOnsiteEstimate
        ? `<div style="margin-top:8px; font-size:12px; color:#92400e; background-color:#FEF3C7; display:inline-block; padding:2px 8px; border-radius:4px;">On-site estimate requested</div>`
        : '';

      return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:${i === 0 ? 0 : 16}px; border:1px solid #e5e5e5; border-radius:8px;">
          <tr>
            <td style="padding:18px 20px;">
              <div style="display:flex; justify-content:space-between; align-items:baseline;">
                <div style="font-weight:700; font-size:16px;">${escapeHtml(q.businessName)}</div>
                <div style="font-family: Georgia, serif; font-size:20px; font-weight:800;">${escapeHtml(price)}</div>
              </div>
              ${q.priceDescription ? `<div style="margin-top:4px; font-size:12px; color:#6b7280;">${escapeHtml(q.priceDescription)}</div>` : ''}
              ${availability}
              ${includes}
              ${excludes}
              ${notes}
              ${onsite}
            </td>
          </tr>
        </table>
      `;
    })
    .join('\n');

  // Refund copy varies based on what actually happened upstream. Never
  // promise something that didn't occur — "we're refunding your request"
  // in the template originally ran whether or not a refund was issued,
  // which was a truthfulness bug. The send-reports cron now passes a
  // real outcome in refundOutcome.
  const refundCopy = (() => {
    if (input.quotes.length > 0) return '';
    switch (input.refundOutcome) {
      case 'issued':
        return `We called the local pros but couldn&#039;t get a firm quote on this round. This usually
          means they didn&#039;t pick up, or they needed to see the job in person before
          pricing. We&#039;ve refunded your $9.99 back to the original card — it typically shows up
          within 5–10 business days.`;
      case 'pending_support':
        return `We called the local pros but couldn&#039;t get a firm quote on this round. This usually
          means they didn&#039;t pick up, or they needed to see the job in person before
          pricing. Reply to this email and we&#039;ll process your $9.99 refund manually within
          one business day — sorry for the extra step.`;
      default:
        // No refundOutcome passed (legacy call site) or 'not_applicable'
        // on zero quotes. Safe fallback: promise human follow-up instead
        // of an automatic refund we didn't actually issue.
        return `We called the local pros but couldn&#039;t get a firm quote on this round. This usually
          means they didn&#039;t pick up, or they needed to see the job in person before
          pricing. Reply to this email and we&#039;ll make it right.`;
    }
  })();

  const emptyState = refundCopy
    ? `<p style="font-size:14px; color:#374151;">${refundCopy}</p>`
    : '';

  const inner = `
    <p style="font-size:16px; margin:0 0 12px 0;">${greeting}</p>
    <p style="font-size:15px; margin:0 0 16px 0; color:#374151;">
      Here's what we heard from local ${escapeHtml(input.categoryName.toLowerCase())} pros in
      ${escapeHtml(input.city)}, ${escapeHtml(input.state)}.
    </p>
    <p style="font-size:13px; margin:0 0 24px 0; color:#6b7280;">${escapeHtml(input.coverageSummary)}</p>
    ${emptyState}
    ${quoteCards}
    ${input.quotes.length > 0
      ? `<p style="margin-top:24px; font-size:14px; color:#374151;">
           Ready to move on one? Open the dashboard to release your phone and email
           to the pro you want — we don't share your contact unless you say so.
         </p>
         ${button('View quotes & share contact', input.dashboardUrl)}`
      : button('Open dashboard', input.dashboardUrl)
    }
  `;

  const text = [
    `${greeting}`,
    ``,
    `Here's what we heard from local ${input.categoryName.toLowerCase()} pros in ${input.city}, ${input.state}.`,
    `${input.coverageSummary}`,
    ``,
    ...input.quotes.map((q, i) =>
      [
        `${i + 1}. ${q.businessName} — ${formatPriceRange(q.priceMin, q.priceMax)}`,
        q.priceDescription ? `   ${q.priceDescription}` : '',
        q.availability ? `   Available: ${q.availability}` : '',
        (q.includes ?? []).length ? `   Includes: ${(q.includes ?? []).join(', ')}` : '',
        (q.excludes ?? []).length ? `   Excludes: ${(q.excludes ?? []).join(', ')}` : '',
        q.notes ? `   Notes: ${q.notes}` : '',
        q.requiresOnsiteEstimate ? `   (On-site estimate requested)` : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    ``,
    `View the full report and release your contact to a specific pro:`,
    `${input.dashboardUrl}`,
  ].join('\n');

  return {
    subject,
    html: htmlShell(inner),
    text,
  };
}

// ─── 2. Contact release → business ──────────────────────────────────
//
// Sent when a customer opts into sharing their contact info with a
// specific business. This is the only moment the customer's phone /
// email ever reach a business.

export type ContactReleaseInput = {
  businessName: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  categoryName: string;
  city: string;
  state: string;
  /** Bullet summary of the job, safe to share (no PII beyond city). */
  jobSummary: string[];
  /** What the quote was so both parties are on the same page. */
  quoteSummary: string;
};

export function renderContactRelease(input: ContactReleaseInput): Rendered {
  const subject = `${escapeHtml(input.customerName)} wants to follow up on your ${input.categoryName.toLowerCase()} quote`;

  const bullets = input.jobSummary
    .map((b) => `<li style="margin-bottom:4px;">${escapeHtml(b)}</li>`)
    .join('\n');

  const inner = `
    <p style="font-size:16px; margin:0 0 12px 0;">Hi ${escapeHtml(input.businessName)},</p>
    <p style="font-size:15px; margin:0 0 16px 0; color:#374151;">
      ${escapeHtml(input.customerName)} just asked us to connect you directly about the
      ${escapeHtml(input.categoryName.toLowerCase())} quote you gave us for
      ${escapeHtml(input.city)}, ${escapeHtml(input.state)}.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e5e5; border-radius:8px; margin:20px 0;">
      <tr>
        <td style="padding:18px 20px;">
          <div style="font-weight:700; margin-bottom:10px;">Their contact</div>
          <div style="font-size:14px; margin-bottom:6px;"><strong>Name:</strong> ${escapeHtml(input.customerName)}</div>
          <div style="font-size:14px; margin-bottom:6px;"><strong>Phone:</strong> <a href="tel:${escapeHtml(input.customerPhone)}">${escapeHtml(input.customerPhone)}</a></div>
          <div style="font-size:14px;"><strong>Email:</strong> <a href="mailto:${escapeHtml(input.customerEmail)}">${escapeHtml(input.customerEmail)}</a></div>
        </td>
      </tr>
    </table>
    <div style="font-weight:700; margin-top:8px;">Job details</div>
    <ul style="font-size:14px; color:#374151; margin:8px 0 16px 20px;">${bullets}</ul>
    <div style="font-size:14px;"><strong>The quote you gave:</strong> ${escapeHtml(input.quoteSummary)}</div>
    <p style="font-size:13px; color:#6b7280; margin-top:24px;">
      We don't charge for connected leads. Follow up however you normally would.
    </p>
  `;

  const text = [
    `Hi ${input.businessName},`,
    ``,
    `${input.customerName} just asked us to connect you directly about the ${input.categoryName.toLowerCase()} quote you gave us for ${input.city}, ${input.state}.`,
    ``,
    `Their contact:`,
    `  Name:  ${input.customerName}`,
    `  Phone: ${input.customerPhone}`,
    `  Email: ${input.customerEmail}`,
    ``,
    `Job details:`,
    ...input.jobSummary.map((b) => `  • ${b}`),
    ``,
    `The quote you gave: ${input.quoteSummary}`,
    ``,
    `We don't charge for connected leads. Follow up however you normally would.`,
  ].join('\n');

  return {
    subject,
    html: htmlShell(inner),
    text,
  };
}
