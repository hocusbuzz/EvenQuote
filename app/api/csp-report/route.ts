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
//
// ── Observability contract (R32 audit) ────────────────────────────
// This route deliberately does NOT wire captureException on any
// path. Reasoning:
//   1. The route is itself part of the observability pipeline — a
//      downstream SINK consuming browser-reported violations. Wrapping
//      a telemetry sink in telemetry creates loops where a Sentry
//      hiccup silently doubles up as a CSP-report failure and vice
//      versa. Log.warn to the structured log stream is the single
//      primary signal.
//   2. `persistViolation()` failures fire only when
//      `CSP_VIOLATIONS_PERSIST=true` — i.e. inside an intentional
//      collection window. During that window operators are already
//      watching the log drain; adding per-violation captureException
//      would flood Sentry at browser-violation frequency (an ad-heavy
//      page can emit hundreds of reports per load).
//   3. `createAdminClient()` throws only on missing env — that's
//      deploy-time config state per the R29 pattern (would have
//      broken every other route first) and would be flooding Sentry
//      on every single request during misconfig.
//   4. The malformed-JSON, empty-body, and unknown-shape paths are
//      all browser garbage the route explicitly swallows to 204.
//      Capturing any of these would flood on legitimate browser
//      noise.
//
// Regression-guards in route.test.ts lock this no-capture contract —
// if a future maintainer wires captureException here, the tests fail.
// If you need to break the rule, update the test AND add a comment
// justifying the new capture site (e.g. "path C is genuinely silent
// and happens at bounded rate").

import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertRateLimit } from '@/lib/security/rate-limit-auth';

const log = createLogger('csp-report');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Rate-limit policy for the CSP report sink (R47(a)).
//
// CSP-report is a public POST endpoint browsers hit on every CSP
// violation. Without throttling, a single misconfigured page or a
// hostile actor pointing reports at us can flood the structured log
// drain and (when CSP_VIOLATIONS_PERSIST=true) hammer the
// `csp_violations` insert path with browser-frequency writes.
//
// Numbers: 200 calls / 60s / IP. A heavy page with many violations
// can legitimately fire 50+ reports on a single load; a real user
// reloading rapidly might cross 100. 200 keeps headroom for genuine
// browser bursts while cutting off log-flood attacks at one bucket.
//
// The 64 KB body cap below is an orthogonal defense — it limits the
// CPU each accepted request can cost, even if someone manages to
// stay under the rate limit. Both checks are run; rate limit goes
// first because it's the cheapest reject and applies to ALL POSTs,
// not just oversized ones.
const RATE_LIMIT = { limit: 200, windowMs: 60_000 } as const;

// Max accepted request body (bytes). A legitimate CSP violation report
// is <4 KB; even a coalesced report-to batch stays well under 32 KB.
// 64 KB is a generous ceiling that still rejects a rogue POST of a
// multi-megabyte "csp-report" body from wasting CPU parsing JSON we
// don't care about.
//
// Caller reports a positive content-length → we trust it and cut off
// early with 413. Missing or unparseable content-length → we still let
// req.json() run; Next's request body reader has its own internal
// limits. This check is an early rejection, not the only one.
const MAX_BODY_BYTES = 64 * 1024;

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

// Strip query strings from URLs before persistence. A guest-quote URL
// like `/q/claim?token=<uuid>` shouldn't be stored in csp_violations
// alongside an indexed directive — the path itself is useful for
// allow-list tuning, the query string isn't, and it's PII-adjacent.
// Unparseable / bare-keyword inputs pass through unchanged so we
// still capture `'inline'` / `'eval'` as-reported.
function stripQuery(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  if (!uri.includes('://')) return uri.slice(0, 2048);
  try {
    const u = new URL(uri);
    u.search = '';
    u.hash = '';
    return u.toString().slice(0, 2048);
  } catch {
    return uri.slice(0, 2048);
  }
}

/**
 * Persist one violation row. Env-gated (`CSP_VIOLATIONS_PERSIST=true`)
 * so this table only collects during a deliberate rollout window;
 * default off to keep PII-adjacent storage out of production on
 * normal days.
 *
 * Never throws — a failed insert must not turn into a 5xx on the CSP
 * report endpoint (browsers will just log it, but it still corrupts
 * our log drain with capture noise).
 */
async function persistViolation(report: Record<string, unknown>): Promise<void> {
  if ((process.env.CSP_VIOLATIONS_PERSIST ?? '').toLowerCase() !== 'true') return;
  try {
    const admin = createAdminClient();
    // NOTE: we do NOT persist the raw browser report. Browsers include
    // URLs with query strings and occasionally `script-sample` text
    // that can carry user input. The stripped per-column shape below
    // is deliberately the complete storage contract — the analyze
    // script (scripts/analyze-csp-reports.ts) uses only these columns.
    const { error } = await admin.from('csp_violations').insert({
      violated_directive:
        typeof report['violated-directive'] === 'string'
          ? (report['violated-directive'] as string)
          : null,
      effective_directive:
        typeof report['effective-directive'] === 'string'
          ? (report['effective-directive'] as string)
          : null,
      blocked_uri: stripQuery(report['blocked-uri']),
      document_uri: stripQuery(report['document-uri']),
      referrer: stripQuery(report['referrer']),
      original_policy:
        typeof report['original-policy'] === 'string'
          ? (report['original-policy'] as string).slice(0, 4096)
          : null,
    });
    if (error) {
      log.warn('csp persist failed', { message: error.message });
    }
  } catch (err) {
    // Admin client couldn't be constructed (missing env, etc.) — log
    // and move on. Collection windows should never block the route.
    log.warn('csp persist threw', { err });
  }
}

export async function POST(req: Request) {
  // Rate limit FIRST — same pattern as the Places proxies (R46(a)).
  // The check is in-memory and microseconds-fast; running it before
  // any other work prevents a flood from reaching the body parser /
  // admin client / log drain. Returns a 429 with Retry-After on deny.
  const deny = assertRateLimit(req, {
    prefix: 'csp-report',
    limit: RATE_LIMIT.limit,
    windowMs: RATE_LIMIT.windowMs,
  });
  if (deny) return deny;

  // Early size cap. A real CSP report is tiny; anything bigger is
  // either a bug in the browser or someone trying to use this
  // endpoint as a log-flood surface. 413 (Payload Too Large) is the
  // RFC-correct status, but we return the empty body pattern the rest
  // of this handler uses so the shape is consistent.
  const contentLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

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
    // Fire-and-forget: we don't await the persist so the browser gets
    // its 204 as fast as possible. Inserts go through the route's
    // runtime lifecycle anyway (Vercel holds the function alive until
    // all promises settle, so no-op in serverless).
    void persistViolation(r);
  }

  return new NextResponse(null, { status: 204 });
}
