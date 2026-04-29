#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * CSP violation analysis — run before flipping from Report-Only to
 * Enforce.
 *
 * Usage
 * -----
 *   SUPABASE_SERVICE_ROLE_KEY=<key> \
 *   NEXT_PUBLIC_SUPABASE_URL=<url>  \
 *     npx tsx scripts/analyze-csp-reports.ts [--days=14] [--limit=50]
 *
 * What it does
 * ------------
 * 1. Pulls csp_violations rows from the last N days (default 14).
 * 2. Aggregates by (effective_directive, blocked_uri_host).
 * 3. Sorts by count desc — the most-frequent violations are the
 *    highest-risk "will break production on flip" items.
 * 4. Prints:
 *      • TOP N groups (default 50)
 *      • A directive-level summary (which directives to widen)
 *      • Distinct document_uri paths per top group (where the
 *        violation actually fires — helps tell "legitimate 3rd-party
 *        asset" from "XSS attempt on /login")
 *
 * The output is plain text, NOT JSON — this script is meant to be
 * read by a human before making a policy call.
 *
 * What to do with the output
 * --------------------------
 *   • Top group is `img-src → https://cdn.example.com` with count
 *     1234 across /get-quote and /pay → add that host to the
 *     allow-list for img-src.
 *   • Top group is `script-src → inline` with count 5 across
 *     /admin → investigate; probably an unrendered debug block
 *     you forgot to delete.
 *   • Any group whose blocked_uri looks like an attacker-controlled
 *     domain → Enforce mode is the correct call; the block is
 *     working as intended.
 *
 * Not-goals
 * ---------
 * This script does NOT mutate the CSP policy — it's a read-only
 * analytics tool. Policy changes still land in `next.config.mjs`
 * (minimalCsp) or the nonce-middleware scaffold, and in a human code
 * review.
 */

import { createClient } from '@supabase/supabase-js';

type Row = {
  effective_directive: string | null;
  violated_directive: string | null;
  blocked_uri: string | null;
  document_uri: string | null;
  received_at: string;
};

function argv(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  const v = Number(hit.slice(prefix.length));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function hostOf(uri: string | null): string {
  if (!uri) return '<null>';
  if (!uri.includes('://')) return uri; // 'inline', 'eval', bare keyword
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri.slice(0, 80);
  }
}

function directiveOf(r: Row): string {
  return r.effective_directive ?? r.violated_directive ?? 'unknown';
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
        'This script talks to Postgres as the service-role and cannot run with anon creds.'
    );
    process.exit(1);
  }

  const days = argv('days', 14);
  const limit = argv('limit', 50);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supa = createClient(url, key);

  // Pull ALL rows in the window — csp_violations is narrow (one insert
  // per violation) and a 14-day window at launch-scale traffic is
  // well under 100k rows. Aggregate client-side so we get the full
  // distinct-document-uri breakdown without N+1 queries.
  const { data, error } = await supa
    .from('csp_violations')
    .select('effective_directive, violated_directive, blocked_uri, document_uri, received_at')
    .gte('received_at', since)
    .order('received_at', { ascending: false })
    .limit(100_000);

  if (error) {
    console.error('query failed:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as Row[];
  if (rows.length === 0) {
    console.log(`No CSP violations in the last ${days} days.`);
    console.log(
      'Likely causes: the Report-Only policy is already tight, ' +
        'CSP_VIOLATIONS_PERSIST is false, or no traffic has hit the site yet.'
    );
    return;
  }

  console.log(`CSP violations — last ${days} days (${rows.length} rows)\n`);

  // ── group by directive + host ────────────────────────────────────
  type Group = {
    directive: string;
    blockedHost: string;
    count: number;
    docs: Set<string>;
  };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const directive = directiveOf(r);
    const blockedHost = hostOf(r.blocked_uri);
    const k = `${directive}|${blockedHost}`;
    const g = groups.get(k) ?? {
      directive,
      blockedHost,
      count: 0,
      docs: new Set<string>(),
    };
    g.count += 1;
    if (r.document_uri) g.docs.add(hostOf(r.document_uri));
    groups.set(k, g);
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);

  console.log('TOP GROUPS — directive → blocked_host');
  console.log('─'.repeat(72));
  for (const g of sorted) {
    const docList = [...g.docs].slice(0, 5).join(', ');
    const more = g.docs.size > 5 ? ` (+${g.docs.size - 5} more)` : '';
    console.log(
      `${String(g.count).padStart(6)}  ${g.directive.padEnd(24)}  ${g.blockedHost}`
    );
    if (docList) console.log(`        docs: ${docList}${more}`);
  }

  // ── directive-level rollup ───────────────────────────────────────
  const byDirective = new Map<string, number>();
  for (const g of groups.values()) {
    byDirective.set(g.directive, (byDirective.get(g.directive) ?? 0) + g.count);
  }
  const dirSorted = [...byDirective.entries()].sort((a, b) => b[1] - a[1]);

  console.log('\nDIRECTIVE TOTALS');
  console.log('─'.repeat(72));
  for (const [d, c] of dirSorted) {
    console.log(`${String(c).padStart(6)}  ${d}`);
  }

  // ── advisory — flip readiness heuristic ──────────────────────────
  const topGroup = sorted[0];
  const unknownHosts = sorted.filter((g) => g.blockedHost === 'unknown' || g.blockedHost === '').length;
  console.log('\nFLIP READINESS (heuristic, not binding)');
  console.log('─'.repeat(72));
  console.log(`• Top group count: ${topGroup?.count ?? 0}`);
  console.log(`• Unknown/empty blocked-host groups: ${unknownHosts}`);
  console.log(
    `• Recommendation: review the TOP GROUPS list above. Any group with ` +
      `count > 10 across multiple document hosts is a candidate for ` +
      `allow-list inclusion before Enforce flip. Groups with count < 10 ` +
      `are likely malformed reports or bot traffic — safe to leave blocked.`
  );
}

main().catch((err) => {
  console.error('analyze failed:', err);
  process.exit(1);
});
