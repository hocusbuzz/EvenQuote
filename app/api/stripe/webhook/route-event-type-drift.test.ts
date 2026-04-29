// R41(c) — Stripe webhook event.type allow-list drift audit.
//
// The webhook receives every Stripe event type the account is subscribed
// to. We HANDLE exactly one (`checkout.session.completed`) and ACK-ONLY
// a tight list of six others. Every other well-formed event falls through
// to a 200 + log path so Stripe stops retrying.
//
// Why lock this lexically:
//   1. A future refactor that silently drops `checkout.session.completed`
//      from the switch (e.g. a merge conflict, a "cleanup") would break
//      post-payment magic-link emails AND call enqueueing. Users who
//      paid would see no calls placed — the exact failure mode that
//      destroys trust. No runtime test catches a MISSING case — the
//      default branch just 200s.
//   2. A PR that adds `invoice.*` or `customer.subscription.*` without
//      thinking would silently ACK events this product does not support.
//      Forces the author to make a decision instead of letting defaults
//      paper over a change.
//   3. `payment_intent.succeeded` MUST stay in the ignore list. Stripe
//      Checkout fires both `checkout.session.completed` AND
//      `payment_intent.succeeded` — if we handle the latter we'd
//      double-send magic links and double-enqueue calls. (See the inline
//      comment at line ~82 of the route.)
//
// Scope — this audit is lexical only; does NOT verify behavior.
//   • R32/R36 already lock the webhook response envelope.
//   • This audit locks the set of event-type literals that appear in
//     the switch + the handler dispatch shape (default case must
//     200+log, not 400).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTE_PATH = path.join(
  process.cwd(),
  'app/api/stripe/webhook/route.ts',
);

const EXPECTED_HANDLED = new Set<string>([
  'checkout.session.completed',
]);

// ACK-only events — 200 + note, no side effects. Each one is here for
// a specific reason; keep this list narrow and well-commented.
const EXPECTED_ACK_ONLY = new Set<string>([
  // Checkout Sessions emit both checkout.session.completed AND
  // payment_intent.succeeded. We only handle the former; acking the
  // latter prevents Stripe from retrying.
  'payment_intent.succeeded',
  // PaymentIntent lifecycle — created/failed emitted for every session;
  // ack so Stripe doesn't retry. Failed payments surface through the
  // customer's browser already.
  'payment_intent.created',
  'payment_intent.payment_failed',
  // Session abandoned / timed out. No user-facing action needed.
  'checkout.session.expired',
  // Charge lifecycle — emitted on successful payment; ack so Stripe
  // doesn't retry. All customer-facing work happens on the session event.
  'charge.succeeded',
  'charge.updated',
]);

// FORBIDDEN — any of these in the switch would be an active bug.
// Each entry below carries a one-line reason. Keep this list growing
// as Stripe ships new event families that fall outside our product
// scope; adding a forbidden type here is cheap, removing one later
// (when we ship that capability) is a deliberate decision.
//
// Categories:
//   • invoice.*                  — subscription billing, not sold.
//   • customer.subscription.*    — subscription lifecycle, not sold.
//   • refund.* / charge.refund*  — no refunds flow built (R39 retro:
//                                  the "false refund promise" bug).
//   • tax.*                      — Stripe Tax (rates, registrations);
//                                  not used.
//   • treasury.*                 — Stripe Treasury (financial accounts,
//                                  outbound transfers); not used.
//   • terminal.*                 — in-person Terminal hardware events;
//                                  not used.
//   • issuing.*                  — card issuing (cardholders, cards,
//                                  authorizations); not used.
//   • capital.*                  — Stripe Capital (loans); not used.
//   • climate.*                  — Stripe Climate (carbon removal); not used.
//   • identity.*                 — Stripe Identity (KYC verification);
//                                  not used.
//   • billing_portal.*           — Customer Portal (subscriptions); not used.
//   • subscription_schedule.*    — subscription schedules; not used.
//   • mandate.*                  — Direct-debit mandates (SEPA, BECS);
//                                  not used.
//   • setup_intent.*             — saved payment methods for off-session
//                                  charges; we charge once at checkout.
const FORBIDDEN_EVENT_TYPES = new Set<string>([
  // ── invoice.* ────────────────────────────────────────────────────
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.created',
  'invoice.finalized',
  'invoice.voided',
  'invoice.upcoming',
  // ── invoiceitem.* ────────────────────────────────────────────────
  // (subscription line-item lifecycle; not used)
  'invoiceitem.created',
  'invoiceitem.updated',
  'invoiceitem.deleted',
  // ── customer.subscription.* ──────────────────────────────────────
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  // ── refund.* / charge.refund* ────────────────────────────────────
  'charge.refunded',
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
  // ── tax.* ────────────────────────────────────────────────────────
  'tax.settings.updated',
  'tax_rate.created',
  'tax_rate.updated',
  // ── treasury.* ───────────────────────────────────────────────────
  'treasury.financial_account.created',
  'treasury.financial_account.features_status_updated',
  'treasury.outbound_transfer.created',
  'treasury.outbound_transfer.posted',
  'treasury.outbound_payment.created',
  'treasury.received_credit.created',
  'treasury.received_debit.created',
  // ── terminal.* ───────────────────────────────────────────────────
  'terminal.reader.action_succeeded',
  'terminal.reader.action_failed',
  // ── issuing.* ────────────────────────────────────────────────────
  'issuing_authorization.created',
  'issuing_authorization.updated',
  'issuing_card.created',
  'issuing_card.updated',
  'issuing_cardholder.created',
  'issuing_cardholder.updated',
  'issuing_dispute.created',
  'issuing_transaction.created',
  // ── capital.* ────────────────────────────────────────────────────
  'capital.financing_offer.created',
  'capital.financing_offer.accepted',
  'capital.financing_transaction.created',
  // ── climate.* ────────────────────────────────────────────────────
  'climate.order.created',
  'climate.order.delivered',
  'climate.order.canceled',
  // ── identity.* ───────────────────────────────────────────────────
  'identity.verification_session.created',
  'identity.verification_session.processing',
  'identity.verification_session.verified',
  'identity.verification_session.requires_input',
  // ── billing_portal.* ─────────────────────────────────────────────
  'billing_portal.configuration.created',
  'billing_portal.configuration.updated',
  'billing_portal.session.created',
  // ── subscription_schedule.* ──────────────────────────────────────
  'subscription_schedule.created',
  'subscription_schedule.updated',
  'subscription_schedule.released',
  'subscription_schedule.canceled',
  // ── mandate.* ────────────────────────────────────────────────────
  'mandate.updated',
  // ── setup_intent.* ───────────────────────────────────────────────
  'setup_intent.created',
  'setup_intent.succeeded',
  'setup_intent.canceled',
  'setup_intent.setup_failed',
]);

// Forbidden event-type FAMILIES — any switch case whose literal
// matches `<family>.*` is treated as forbidden even if the specific
// event type isn't in FORBIDDEN_EVENT_TYPES. Catches new Stripe events
// added to a category Stripe expanded after this audit was written.
//
// Entries are family prefixes (with trailing dot). A literal qualifies
// if it `startsWith(prefix)`. The forbidden-individual list is a
// superset for posterity / specific reasoning; the family list is the
// catch-all backstop.
const FORBIDDEN_EVENT_FAMILIES: readonly string[] = [
  'invoice.',
  'invoiceitem.',
  'customer.subscription.',
  'subscription_schedule.',
  'refund.',
  'tax.',
  'tax_rate.',
  'treasury.',
  'terminal.',
  'issuing_',
  'capital.',
  'climate.',
  'identity.',
  'billing_portal.',
  'mandate.',
  'setup_intent.',
];

describe('stripe webhook event.type allow-list drift (R41)', () => {
  const src = fs.readFileSync(ROUTE_PATH, 'utf8');

  // Lexical helper: strip comments and string literals that aren't the
  // `case '<event.type>':` switch cases. Comments commonly MENTION event
  // types that aren't in the switch; we shouldn't count those as handlers.
  function stripCommentsForSwitch(source: string): string {
    return source
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
  }

  const strippedForSwitch = stripCommentsForSwitch(src);

  // Extract all `case '<literal>':` entries — these are exactly the
  // event types routed in the switch.
  function extractCaseLiterals(source: string): string[] {
    const re = /case\s+['"]([a-z_]+\.[a-z_.]+)['"]\s*:/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
    return out;
  }

  const caseLiterals = extractCaseLiterals(strippedForSwitch);
  const caseLiteralsSet = new Set(caseLiterals);

  it('extracts at least one case literal from the switch', () => {
    // Parser sanity — if this fails the regex drifted, not the source.
    expect(caseLiterals.length).toBeGreaterThanOrEqual(7);
  });

  it('no duplicate case literals — switch cases must be unique', () => {
    const dupes = caseLiterals.filter(
      (k, i) => caseLiterals.indexOf(k) !== i,
    );
    expect(dupes, `duplicate case literals: ${JSON.stringify(dupes)}`).toEqual(
      [],
    );
  });

  it('handled events: every EXPECTED_HANDLED appears in the switch', () => {
    const missing = [...EXPECTED_HANDLED].filter(
      (k) => !caseLiteralsSet.has(k),
    );
    expect(
      missing,
      `missing handled event types in switch: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it('ack-only events: every EXPECTED_ACK_ONLY appears in the switch', () => {
    const missing = [...EXPECTED_ACK_ONLY].filter(
      (k) => !caseLiteralsSet.has(k),
    );
    expect(
      missing,
      `missing ack-only event types in switch: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it('switch contains exactly the union of handled + ack-only (no drift)', () => {
    const expected = new Set<string>([
      ...EXPECTED_HANDLED,
      ...EXPECTED_ACK_ONLY,
    ]);
    const unexpected = [...caseLiteralsSet].filter((k) => !expected.has(k));
    expect(
      unexpected,
      `unexpected event types in switch — add to EXPECTED_HANDLED/EXPECTED_ACK_ONLY or remove from source: ${JSON.stringify(unexpected)}`,
    ).toEqual([]);
  });

  it('no forbidden event types appear in the switch', () => {
    const present = [...FORBIDDEN_EVENT_TYPES].filter((k) =>
      caseLiteralsSet.has(k),
    );
    expect(
      present,
      `FORBIDDEN event types present in switch: ${JSON.stringify(present)}. Subscription / refund flows are not supported — if this is new product scope, update the audit.`,
    ).toEqual([]);
  });

  it('R48(c) — no switch case matches a forbidden event-type family', () => {
    // Family-level catch-all. If Stripe ships a new event type in
    // any of these families and someone copy-pastes a handler into
    // the switch, this fires even though the specific event isn't
    // yet in FORBIDDEN_EVENT_TYPES.
    const violations: { literal: string; family: string }[] = [];
    for (const literal of caseLiterals) {
      for (const family of FORBIDDEN_EVENT_FAMILIES) {
        if (literal.startsWith(family)) {
          violations.push({ literal, family });
        }
      }
    }
    expect(
      violations,
      `forbidden event-type families in switch: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it('R48(c) — FORBIDDEN_EVENT_TYPES contains entries from each forbidden family (registry sanity)', () => {
    // Defensive: if a maintainer added a new family to
    // FORBIDDEN_EVENT_FAMILIES but forgot to seed at least one
    // representative event in FORBIDDEN_EVENT_TYPES, the per-event
    // list silently falls out of sync with the family list. Force at
    // least one example per family so the lists evolve together.
    const missing: string[] = [];
    for (const family of FORBIDDEN_EVENT_FAMILIES) {
      const has = [...FORBIDDEN_EVENT_TYPES].some((t) =>
        t.startsWith(family),
      );
      if (!has) missing.push(family);
    }
    expect(
      missing,
      `forbidden families with no representative event in FORBIDDEN_EVENT_TYPES: ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it('R48(c) — every FORBIDDEN_EVENT_TYPES entry is a syntactically valid Stripe event type', () => {
    // Stripe event types are dotted lowercase identifiers. A typo in
    // an entry would silently match nothing, weakening the audit.
    // Lock the shape: at least one '.', alphanumerics + underscore +
    // dots only, no leading/trailing dots.
    const SHAPE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
    const bad: string[] = [];
    for (const t of FORBIDDEN_EVENT_TYPES) {
      if (!SHAPE_RE.test(t)) bad.push(t);
    }
    expect(
      bad,
      `FORBIDDEN_EVENT_TYPES entries with invalid Stripe event-type shape: ${JSON.stringify(bad)}`,
    ).toEqual([]);
  });

  it('R48(c) — FORBIDDEN_EVENT_TYPES has no duplicates (Set is well-formed)', () => {
    // Set construction silently dedupes, so a duplicate literal in
    // the source would inflate review noise without a runtime
    // signal. Surface it explicitly.
    const arr = [...FORBIDDEN_EVENT_TYPES];
    const dupes = arr.filter((k, i) => arr.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it('R48(c) — EXPECTED_HANDLED and EXPECTED_ACK_ONLY are disjoint from FORBIDDEN_EVENT_TYPES', () => {
    // Sanity: a maintainer should not be able to add an event to
    // EXPECTED_HANDLED while it's also FORBIDDEN. If you genuinely
    // want to handle an event currently forbidden, remove it from
    // FORBIDDEN_EVENT_TYPES first as a separate change.
    const conflicts: string[] = [];
    for (const k of EXPECTED_HANDLED) {
      if (FORBIDDEN_EVENT_TYPES.has(k)) conflicts.push(k);
    }
    for (const k of EXPECTED_ACK_ONLY) {
      if (FORBIDDEN_EVENT_TYPES.has(k)) conflicts.push(k);
    }
    expect(
      conflicts,
      `expected events that are also FORBIDDEN: ${JSON.stringify(conflicts)}`,
    ).toEqual([]);
  });

  it('forbidden event types are also not mentioned in source comments (belt-and-suspenders)', () => {
    // Even commented-out cases should not exist — a future PR could
    // uncomment them without reviewing the audit. If you deliberately
    // need to document a forbidden event, do it in docs/, not in a
    // // case '<forbidden>': comment inside route.ts.
    const re = /case\s+['"]([a-z_]+\.[a-z_.]+)['"]\s*:/g;
    const commentedOut: string[] = [];
    let m: RegExpExecArray | null;
    // Scan source line-by-line for `//.*case 'invoice.*':` shapes.
    for (const line of src.split('\n')) {
      const commentIdx = line.indexOf('//');
      if (commentIdx === -1) continue;
      const commentBody = line.slice(commentIdx);
      const re2 = new RegExp(re.source, 'g');
      while ((m = re2.exec(commentBody)) !== null) {
        if (FORBIDDEN_EVENT_TYPES.has(m[1])) commentedOut.push(m[1]);
      }
    }
    expect(
      commentedOut,
      `forbidden event types appear in commented-out cases: ${JSON.stringify(commentedOut)}`,
    ).toEqual([]);
  });

  it('default case exists and does NOT 400 — Stripe must not retry unknown events', () => {
    // The switch must have a `default:` branch that returns 200, not
    // 4xx/5xx. A 4xx triggers Stripe retry storms for event types we
    // added to Stripe but haven't shipped handlers for.
    const stripped = strippedForSwitch;
    const defaultIdx = stripped.indexOf('default:');
    expect(defaultIdx, 'no default: case in switch').toBeGreaterThan(-1);
    // Scope: only the default case's body — from `default:` to the first
    // `return ...;` statement. Walking further would spill into the
    // `catch` block below (which LEGITIMATELY returns 500) and produce
    // false positives.
    const tail = stripped.slice(defaultIdx);
    const returnMatch = /\breturn\b[\s\S]*?;/.exec(tail);
    expect(returnMatch, 'no return in default branch').not.toBeNull();
    const defaultBody = returnMatch![0];
    expect(
      defaultBody,
      'default branch must return NextResponse.json',
    ).toMatch(/NextResponse\.json\(/);
    expect(
      defaultBody,
      'default branch must return received: true (200 shape)',
    ).toMatch(/received\s*:\s*true/);
    // Negative lock: no status: 400/500 inside the default's return expr.
    expect(
      defaultBody,
      'default branch must NOT return 4xx/5xx — would cause Stripe retry storms',
    ).not.toMatch(/status\s*:\s*[45]\d\d/);
  });

  it('checkout.session.completed dispatches to handleCheckoutCompleted', () => {
    // Lock the dispatch shape. A PR that renames the handler must update
    // this test too — which is the point.
    const stripped = strippedForSwitch;
    const caseIdx = stripped.indexOf(`case 'checkout.session.completed':`);
    expect(caseIdx, "no case for 'checkout.session.completed'").toBeGreaterThan(
      -1,
    );
    const caseBody = stripped.slice(caseIdx, caseIdx + 400);
    expect(
      caseBody,
      "checkout.session.completed case must call handleCheckoutCompleted",
    ).toMatch(/handleCheckoutCompleted\s*\(/);
  });

  it('ack-only cases fall through to a single NextResponse.json (not multiple handlers)', () => {
    // All six ack-only cases share one handler — `return NextResponse.json({
    // received: true, eventId, note: ... })`. If someone adds a body to
    // one of them, this spot check catches it.
    const stripped = strippedForSwitch;
    // Between the first ack-only case and the default branch there
    // should be exactly ONE NextResponse.json(...) call.
    const firstAckIdx = stripped.indexOf(`case 'payment_intent.succeeded':`);
    const defaultIdx = stripped.indexOf('default:');
    expect(firstAckIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(firstAckIdx);
    const ackBlock = stripped.slice(firstAckIdx, defaultIdx);
    const matches = ackBlock.match(/NextResponse\.json\(/g) ?? [];
    expect(
      matches.length,
      `ack-only block must have exactly 1 NextResponse.json (found ${matches.length}); adding a body to one case breaks the shared ignore-note pattern`,
    ).toBe(1);
  });

  // ── R47(c) — per-event handler return-shape extension ────────────
  //
  // R41(b) locked the SET of event types in the switch. R47(c)
  // extends the lock to cover the SHAPE each branch returns. Reason:
  // a future PR that adds a new event to EXPECTED_HANDLED with a
  // different envelope shape (e.g., `{ ok: true }` instead of
  // `{ received: true, eventId, note }`) would silently break Stripe
  // retry idempotency — Stripe's dashboard reads `received` to
  // confirm delivery. R38(b) locks the route-level shape; R47(c)
  // tightens it to per-case granularity.

  // Helper: extract a case body from the stripped source. Returns
  // the substring from the case label up to (but not including) the
  // next `case ` / `default:` boundary. Operates on `strippedForSwitch`
  // so string literals inside the case body remain visible (we need
  // them for the `received: true` lock) but comments are gone.
  function extractCaseBody(literal: string): string {
    const stripped = strippedForSwitch;
    const startToken = `case '${literal}':`;
    const start = stripped.indexOf(startToken);
    if (start === -1) return '';
    const after = start + startToken.length;
    const tail = stripped.slice(after);
    const idxs: number[] = [];
    const nextCase = tail.search(/\bcase\s+['"]/);
    if (nextCase !== -1) idxs.push(nextCase);
    const nextDefault = tail.indexOf('default:');
    if (nextDefault !== -1) idxs.push(nextDefault);
    const endIdx = idxs.length > 0 ? Math.min(...idxs) : tail.length;
    return tail.slice(0, endIdx);
  }

  // Extract the default-branch body. Walk to the closing `}` of the
  // switch, accounting for nested braces inside log calls etc.
  function extractDefaultBody(): string {
    const stripped = strippedForSwitch;
    const start = stripped.indexOf('default:');
    if (start === -1) return '';
    const after = start + 'default:'.length;
    const tail = stripped.slice(after);
    let depth = 0;
    for (let i = 0; i < tail.length; i++) {
      const ch = tail[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (depth === 0) return tail.slice(0, i);
        depth--;
      }
    }
    return tail;
  }

  it('every EXPECTED_HANDLED case returns NextResponse.json with the canonical envelope (R47(c))', () => {
    const violations: string[] = [];
    for (const eventType of EXPECTED_HANDLED) {
      const body = extractCaseBody(eventType);
      if (body.length === 0) {
        violations.push(`${eventType}: case body not found`);
        continue;
      }
      if (!/NextResponse\.json\s*\(/.test(body)) {
        violations.push(`${eventType}: no NextResponse.json call in case body`);
        continue;
      }
      if (!/received\s*:\s*true/.test(body)) {
        violations.push(`${eventType}: missing 'received: true' in response`);
        continue;
      }
      if (!/eventId\s*:/.test(body)) {
        violations.push(`${eventType}: missing 'eventId:' in response`);
        continue;
      }
      // No status field — every handled case is a 200.
      if (/status\s*:\s*[1-9]\d{2}/.test(body)) {
        violations.push(
          `${eventType}: handled case must return 200 (no explicit status field)`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('the shared ack-only branch carries the canonical envelope + ignore note (R47(c))', () => {
    // Ack-only is a single shared branch. Lock that the shared body
    // emits the canonical envelope AND a note literal indicating the
    // event was ignored. A future PR that demotes a HANDLED event to
    // ACK_ONLY by moving it must keep the shared envelope shape.
    const stripped = strippedForSwitch;
    const firstAckIdx = stripped.indexOf(`case 'payment_intent.succeeded':`);
    const defaultIdx = stripped.indexOf('default:');
    expect(firstAckIdx).toBeGreaterThan(-1);
    expect(defaultIdx).toBeGreaterThan(firstAckIdx);
    const ackBlock = stripped.slice(firstAckIdx, defaultIdx);
    expect(ackBlock).toMatch(/received\s*:\s*true/);
    expect(ackBlock).toMatch(/eventId\s*:/);
    expect(ackBlock).toMatch(/note\s*:/);
    // The note literal must declare ignore intent. Don't lock the
    // exact wording — locking 'Ignored event type' as a case-
    // insensitive substring is enough to catch a refactor that
    // drifts to 'OK' or empty.
    expect(
      ackBlock,
      'ack-only note must communicate the event was ignored',
    ).toMatch(/Ignored event type/i);
  });

  it('default case returns the canonical envelope (no shape drift) (R47(c))', () => {
    // Default is the unknown-event branch — we ack to prevent
    // Stripe retry storms. R41(b) already locks no-4xx/no-5xx; this
    // extension locks the SHAPE so a future "return something more
    // useful" PR can't silently break retry idempotency.
    const body = extractDefaultBody();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/NextResponse\.json\s*\(/);
    expect(body).toMatch(/received\s*:\s*true/);
    expect(body).toMatch(/eventId\s*:/);
    expect(body).toMatch(/note\s*:/);
  });

  it('no switch case returns a status outside the 200 family (R47(c))', () => {
    // Catches a creative refactor that adds `status: 202 / 204 /
    // 410` etc. to one branch. Stripe's retry logic only cares
    // about 200 vs not-200 — a non-200 ack triggers the retry
    // storm R41(b) already locks against on the default branch.
    const stripped = strippedForSwitch;
    const switchIdx = stripped.indexOf('switch (event.type)');
    expect(switchIdx).toBeGreaterThan(-1);
    // Walk to the matching closing brace of the switch.
    let depth = 0;
    let endIdx = -1;
    let started = false;
    for (let i = switchIdx; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    expect(endIdx).toBeGreaterThan(switchIdx);
    const switchBody = stripped.slice(switchIdx, endIdx);
    const statuses = Array.from(
      switchBody.matchAll(/status\s*:\s*(\d{3})/g),
    ).map((m) => Number(m[1]));
    const nonOk = statuses.filter((s) => s < 200 || s >= 300);
    expect(
      nonOk,
      `switch contains non-2xx statuses: ${nonOk.join(', ')}. Stripe retries on non-200; the switch must be 200-only.`,
    ).toEqual([]);
  });

  it('OkResponse type alias matches the locked envelope shape (R47(c))', () => {
    // The route file declares `type OkResponse = { received: true;
    // eventId: string; note?: string };`. Lock the alias so a
    // future refactor that loosens the type (e.g. `received: boolean`,
    // `eventId?: string`) can't slip through TypeScript's structural
    // checking. Whitespace-tolerant; semicolon-or-comma agnostic.
    expect(src).toMatch(
      /type\s+OkResponse\s*=\s*\{\s*received\s*:\s*true\s*[;,]\s*eventId\s*:\s*string\s*[;,]\s*note\?\s*:\s*string\s*[;,]?\s*\}/,
    );
  });
});
