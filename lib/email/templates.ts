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

/**
 * Distinguishes WHY the report has zero quotes — drives the email
 * copy in the empty state. The `coverage_gap` value comes from the
 * webhook's advanced:false path, where no businesses were ever
 * contacted (vs `no_response` where calls happened but didn't yield
 * usable quotes). Saying "we called the local pros" in the
 * coverage-gap case would be a flat-out lie.
 *
 * Optional — undefined means we don't know the cause; the template
 * falls back to the "no_response" wording, which is accurate for
 * the legacy zero-quote-after-calls case (the most common shape
 * pre-R47.5).
 *
 * Named `NoQuoteCause` (not `*Reason`) deliberately — the lib/
 * Reason-type audit (R35) reserves the `*Reason` suffix for Sentry
 * capture-tag unions and would mis-classify this email content
 * enum as a Sentry tag.
 */
export type NoQuoteCause = 'coverage_gap' | 'no_response';

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
  /** Only consulted when quotes.length === 0. R47.6. */
  noQuoteCause?: NoQuoteCause;
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
        ? `<div style="margin-top:6px; font-size:13px;"><strong>Extras / fees:</strong> ${escapeHtml((q.excludes ?? []).join(', '))}</div>`
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

  // Refund copy is a 2-D matrix — refundOutcome × noQuoteReason.
  //
  // Why both axes:
  //   • refundOutcome tells the customer whether their money is on
  //     the way back automatically, manually, or unknown.
  //   • noQuoteReason tells the customer WHY there are no quotes.
  //     Saying "we called the local pros" when no calls were placed
  //     (the coverage-gap path) is a truthfulness bug. R47.6 added
  //     the second axis after Codex flagged the inaccuracy.
  //
  // We compose copy as: <reason explanation> + <refund status>.
  const refundCopy = (() => {
    if (input.quotes.length > 0) return '';

    const causeExplanation =
      input.noQuoteCause === 'coverage_gap'
        ? // No calls were placed. Distinct from "called and got
          // nothing useful" — this is "we couldn't find anyone to
          // call." More common in cold-start zips.
          `We searched for local ${escapeHtml(input.categoryName.toLowerCase())} pros near
          ${escapeHtml(input.city)}, ${escapeHtml(input.state)}, but couldn&#039;t find any to call
          for you. Nothing was billed against any pro&#039;s time.`
        : // Default + 'no_response': calls were placed but didn't yield
          // usable quotes. Pre-R47.6 this was the only branch.
          `We called the local pros but couldn&#039;t get a firm quote on this round. This usually
          means they didn&#039;t pick up, or they needed to see the job in person before
          pricing.`;

    const refundStatus = (() => {
      switch (input.refundOutcome) {
        case 'issued':
          return `We&#039;ve refunded your $9.99 back to the original card — it typically shows up
          within 5–10 business days.`;
        case 'pending_support':
          return `Reply to this email and we&#039;ll process your $9.99 refund manually within
          one business day — sorry for the extra step.`;
        default:
          // No refundOutcome (legacy call site) or 'not_applicable'.
          // Safe fallback: promise human follow-up rather than an
          // automatic refund we didn't actually issue.
          return `Reply to this email and we&#039;ll make it right.`;
      }
    })();

    return `${causeExplanation} ${refundStatus}`;
  })();

  const emptyState = refundCopy
    ? `<p style="font-size:14px; color:#374151;">${refundCopy}</p>`
    : '';

  // R47.5: provenance disclosure in the report email mirrors the
  // banner on the customer dashboard. The email is the more formal
  // surface so the language is slightly fuller — but the takeaway
  // is the same: AI-extracted, verify before paying.
  const provenanceCallout =
    input.quotes.length > 0
      ? `<p style="margin:0 0 20px 0; padding:12px 14px; font-size:13px; color:#92400e; background-color:#FEF3C7; border:1px solid #FCD34D; border-radius:6px;">
           <strong>Heads up:</strong> these quotes were extracted by AI from
           recorded phone calls. They&rsquo;re a starting point for comparison,
           not a binding offer. Always confirm price + scope in writing with
           the pro before paying anything.
         </p>`
      : '';

  const inner = `
    <p style="font-size:16px; margin:0 0 12px 0;">${greeting}</p>
    <p style="font-size:15px; margin:0 0 16px 0; color:#374151;">
      Here's what we heard from local ${escapeHtml(input.categoryName.toLowerCase())} pros in
      ${escapeHtml(input.city)}, ${escapeHtml(input.state)}.
    </p>
    <p style="font-size:13px; margin:0 0 16px 0; color:#6b7280;">${escapeHtml(input.coverageSummary)}</p>
    ${provenanceCallout}
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
    ...(input.quotes.length > 0
      ? [
          `Heads up: these quotes were extracted by AI from recorded phone calls.`,
          `They're a starting point for comparison, not a binding offer.`,
          `Always confirm price + scope in writing with the pro before paying.`,
          ``,
        ]
      : []),
    ...input.quotes.map((q, i) =>
      [
        `${i + 1}. ${q.businessName} — ${formatPriceRange(q.priceMin, q.priceMax)}`,
        q.priceDescription ? `   ${q.priceDescription}` : '',
        q.availability ? `   Available: ${q.availability}` : '',
        (q.includes ?? []).length ? `   Includes: ${(q.includes ?? []).join(', ')}` : '',
        (q.excludes ?? []).length ? `   Extras / fees: ${(q.excludes ?? []).join(', ')}` : '',
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

// ─── 1b. Stuck-request ops alert (R47.3) ───────────────────────────
//
// Sent by the check-stuck-requests cron when ≥1 quote_request has been
// parked past its SLA. Audience is "Antonio holding a phone" — copy
// is dense, no fluff, deep links to /admin so investigation starts
// in one click.
//
// Not customer-facing. Lives in the same templates module so the
// chrome (header, button, footer) stays uniform across every mail
// the product sends.

export type StuckRequestRow = {
  id: string;
  status: string;
  location: string;
  minutesStuck: number;
  /** Deep link straight into /admin/requests/<id>. Empty string when
   *  NEXT_PUBLIC_APP_URL is unset (don't render the link). */
  adminUrl: string;
};

export function renderStuckRequestsAlert(input: {
  rows: StuckRequestRow[];
}): Rendered {
  const n = input.rows.length;
  const subject =
    n === 1
      ? `[EvenQuote ops] 1 stuck request needs attention`
      : `[EvenQuote ops] ${n} stuck requests need attention`;

  const rowHtml = input.rows
    .map((r) => {
      const link = r.adminUrl
        ? `<a href="${escapeHtml(r.adminUrl)}" style="color:#0A0A0A; text-decoration:underline;">${escapeHtml(r.id.slice(0, 8))}</a>`
        : escapeHtml(r.id.slice(0, 8));
      return `
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px;">${link}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; font-size:13px;">${escapeHtml(r.status)}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; font-size:13px;">${escapeHtml(r.location)}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; font-size:13px; text-align:right; font-variant-numeric: tabular-nums;">${r.minutesStuck} min</td>
        </tr>`;
    })
    .join('');

  const inner = `
    <p style="font-size:15px; margin:0 0 12px 0;">
      ${n === 1 ? 'A quote request' : `${n} quote requests`} ${n === 1 ? 'has' : 'have'} been parked past
      ${n === 1 ? 'its' : 'their'} SLA threshold. This usually means a
      webhook drop, a Vapi hang, or send-reports isn't firing.
    </p>
    <p style="font-size:13px; margin:0 0 16px 0; color:#6b7280;">
      Thresholds: <code>paid</code> &gt; 15m, <code>calling</code> &gt; 25m, <code>processing</code> &gt; 60m.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e5e5; border-radius:8px;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:6px 8px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280;">ID</th>
          <th style="padding:6px 8px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280;">Status</th>
          <th style="padding:6px 8px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280;">Location</th>
          <th style="padding:6px 8px; text-align:right; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#6b7280;">Stuck for</th>
        </tr>
      </thead>
      <tbody>${rowHtml}</tbody>
    </table>
    <p style="font-size:12px; margin:18px 0 0 0; color:#6b7280;">
      Click any ID to open it in /admin. Common fixes:
      check Vapi server.url is alive, check Resend isn't bouncing,
      tail the cron run history.
    </p>
  `;

  const text = [
    `EvenQuote ops alert: ${n} stuck request${n === 1 ? '' : 's'}`,
    '',
    'Thresholds: paid >15m, calling >25m, processing >60m.',
    '',
    ...input.rows.map(
      (r) =>
        `  ${r.id.slice(0, 8)}  ${r.status.padEnd(11)}  ${r.location.padEnd(28)}  ${r.minutesStuck} min` +
        (r.adminUrl ? `\n    ${r.adminUrl}` : '')
    ),
    '',
    'Common fixes: check Vapi server.url, check Resend bounces, tail cron run history.',
  ].join('\n');

  return { subject, html: htmlShell(inner), text };
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

// ─── Calls scheduled (#117 deferral confirmation) ──────────────────
//
// Sent immediately after a paid request that landed OUTSIDE the
// service area's local business hours (Mon-Fri 9-4:30 PM). Without
// it, the customer pays $9.99, gets a Stripe receipt + a magic-link
// email, and then sits in silence for hours until the calls actually
// happen — easy to read as "this is broken." A real customer (San
// Marcos handyman, 2026-05-01) hit exactly this confusion.
//
// Copy goals:
//   • Acknowledge payment landed
//   • State the SPECIFIC dispatch time in service-area local time
//     (matches what the success page shows; consistent two surfaces)
//   • Set the expectation: ~60-90 min from dispatch to report email
//   • Direct link to the dashboard so they can come back and watch
// PII-friendly: no quotes data on this surface yet (there are none).

export type CallsScheduledInput = {
  recipientName?: string | null;
  city: string;
  state: string;            // 2-letter US state code
  categoryName: string;     // 'Handyman', 'Cleaning', etc.
  scheduledForIso: string;  // ISO timestamp, e.g. '2026-05-04T16:00:00Z'
  /**
   * IANA timezone for the service area, e.g. 'America/Los_Angeles'.
   * Resolved by the caller so this template stays free of the
   * state→tz lookup table (which lives in lib/scheduling/).
   */
  serviceAreaTz: string;
  /** Where the customer can come back to watch progress. */
  dashboardUrl: string;
};

export function renderCallsScheduled(input: CallsScheduledInput): Rendered {
  const greeting = input.recipientName ? `Hi ${escapeHtml(input.recipientName)},` : 'Hi,';
  const lowerCat = input.categoryName.toLowerCase();

  const when = new Date(input.scheduledForIso);
  // "Monday at 9:00 AM PDT" — service-area local time so it matches
  // the success page rendering, NOT the customer's browser tz (which
  // we don't know server-side anyway).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: input.serviceAreaTz,
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const whenPretty = fmt.format(when);

  const subject = `Your ${lowerCat} request is queued — calls start ${whenPretty}`;

  const inner = `
    <p style="font-size:16px; margin:0 0 12px 0;">${greeting}</p>
    <p style="font-size:15px; margin:0 0 16px 0; color:#374151;">
      Your $9.99 went through and your ${escapeHtml(lowerCat)} request for
      ${escapeHtml(input.city)}, ${escapeHtml(input.state)} is in the queue.
    </p>
    <p style="font-size:15px; margin:0 0 16px 0; color:#374151;">
      Right now it&rsquo;s outside local business hours where the work will
      happen, so calling pros now would either go to voicemail or annoy
      them — neither helps you. We&rsquo;ll start dialing on your behalf
      <strong>${escapeHtml(whenPretty)}</strong>.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e5e5e5; border-radius:8px; margin:20px 0;">
      <tr>
        <td style="padding:18px 20px;">
          <div style="font-weight:700; margin-bottom:10px;">What happens next</div>
          <ul style="font-size:14px; color:#374151; margin:0 0 0 20px; padding:0;">
            <li style="margin-bottom:6px;">We dial up to 5 local ${escapeHtml(lowerCat)} pros once the window opens.</li>
            <li style="margin-bottom:6px;">Most calls finish in 60-90 minutes.</li>
            <li>You get a clean comparison report in this inbox right after.</li>
          </ul>
        </td>
      </tr>
    </table>
    ${button('Watch progress', input.dashboardUrl)}
    <p style="font-size:13px; color:#6b7280; margin-top:24px;">
      Nothing for you to do — sit tight. If you don&rsquo;t hear from us by
      a few hours after the scheduled time, reply to this email.
    </p>
  `;

  const text = [
    greeting,
    ``,
    `Your $9.99 went through and your ${lowerCat} request for ${input.city}, ${input.state} is in the queue.`,
    ``,
    `Right now it's outside local business hours where the work will happen — calling now would mean voicemail or annoyed pros. We'll start dialing on your behalf ${whenPretty}.`,
    ``,
    `What happens next:`,
    `  • We dial up to 5 local ${lowerCat} pros once the window opens.`,
    `  • Most calls finish in 60-90 minutes.`,
    `  • You get a clean comparison report in this inbox right after.`,
    ``,
    `Watch progress: ${input.dashboardUrl}`,
    ``,
    `Nothing for you to do — sit tight. If you don't hear from us by a few hours after the scheduled time, reply to this email.`,
  ].join('\n');

  return {
    subject,
    html: htmlShell(inner),
    text,
  };
}

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
