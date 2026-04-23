// POST /api/csp-report
//
// Receives Content Security Policy violation reports from the browser
// during the Report-Only rollout window (see docs/CSP_PLAN.md).
//
// Browsers POST one report per violation with a JSON body shaped as:
//   { "csp-report": {
//       "document-uri", "violated-directive", "blocked-uri",
//       "source-file", "line-number", "column-number", ... } }
//
// Two body shapes exist in the wild:
//   • "report-uri" style: { "csp-report": {...} } (older, what most
//     browsers still use for report-uri).
//   • "report-to" style: array of objects with "type":"csp-violation"
//     and a "body" field.
// We accept and normalise both.
//
// Output: 204 No Content. The browser doesn't read the body. We never
// throw — even an unparseable POST returns 204 to keep our error logs
// noise-free.
//
// Privacy: violations may include the full URL of the page that
// triggered them. URLs in EvenQuote sometimes carry guest UUIDs in
// the path (/get-quotes/claim?token=…). The logger.ts redactor strips
// emails / phones from log payloads, but not URLs. We therefore log a
// SUMMARY (directive + blocked uri host) rather than the full report,
// and stash the full payload only when LOG_FULL_CSP=true is set —
// useful when you need to debug a specific violation, but off by
// default to avoid leaking referer-style data into the log stream.

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';

const log = createLogger('csp-report');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CspReportBody = {
  'csp-report'?: Record<string, unknown>;
};

type ReportToBody = Array<{
  type?: string;
  body?: Record<string, unknown>;
}>;

function hostOf(uri: unknown): string {
  if (typeof uri !== 'string' || uri.length === 0) return 'unknown';
  // Bare keywords like 'inline' / 'eval' are not URLs.
  if (!uri.includes('://')) return uri;
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri.slice(0, 80);
  }
}

function summarize(report: Record<string, unknown>) {
  return {
    directive: report['violated-directive'] ?? report['effective-directive'] ?? 'unknown',
    blocked: hostOf(report['blocked-uri']),
    document: hostOf(report['document-uri']),
    source: hostOf(report['source-file']),
    line: report['line-number'] ?? null,
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Malformed JSON. Browsers occasionally send blank bodies. 204 and move on.
    return new NextResponse(null, { status: 204 });
  }

  const reports: Record<string, unknown>[] = [];

  if (Array.isArray(body)) {
    // report-to style
    for (const entry of body as ReportToBody) {
      if (entry?.type === 'csp-violation' && entry.body && typeof entry.body === 'object') {
        reports.push(entry.body as Record<string, unknown>);
      }
    }
  } else if (body && typeof body === 'object') {
    // report-uri style
    const r = (body as CspReportBody)['csp-report'];
    if (r && typeof r === 'object') reports.push(r as Record<string, unknown>);
  }

  if (reports.length === 0) {
    return new NextResponse(null, { status: 204 });
  }

  const includeFull = (process.env.LOG_FULL_CSP ?? '').toLowerCase() === 'true';

  for (const r of reports) {
    log.warn('csp violation', {
      ...summarize(r),
      ...(includeFull ? { full: r } : {}),
    });
  }

  return new NextResponse(null, { status: 204 });
}
