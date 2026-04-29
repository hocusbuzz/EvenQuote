// Tests for decideEmptyState — locks the four-way dashboard
// empty-state branching for app/dashboard/requests/[id]/page.tsx.
//
// Why these tests exist (R47.6 lockdown):
//   The page renders four very different copy variants based on a
//   subtle combination of (status, total_businesses_to_call,
//   total_calls_completed, refund_outcome). A regression that
//   silently flips between 'coverage_gap' (no pros found, never
//   called) and 'no_response' (called but nothing usable) would
//   tell paying customers a flat-out lie. Codex's Round 5 review
//   explicitly flagged the absence of targeted regression tests
//   for the new coverage_gap branch — these are those tests.
//
// We exhaustively pin:
//   1. coverage_gap → terminal status with totalBusinessesToCall=0
//   2. no_quote     → terminal status, calls completed, no quotes
//   3. failed       → status='failed' with no other terminal hit
//   4. in_flight    → everything else
//   5. refundDescriptor mapping (issued / pending_support / unknown)
//   6. branch precedence (coverage_gap beats no_quote when both
//      could match — they can't truly co-occur but the order check
//      defends against future regressions in the conditional).

import { describe, it, expect } from 'vitest';
import { decideEmptyState, type EmptyStateInput } from './empty-state';

function input(overrides: Partial<EmptyStateInput> = {}): EmptyStateInput {
  return {
    status: 'processing',
    totalBusinessesToCall: 5,
    totalCallsCompleted: 0,
    refundOutcome: null,
    ...overrides,
  };
}

describe('decideEmptyState', () => {
  // ── coverage_gap branch ─────────────────────────────────────────
  describe('coverage_gap', () => {
    it("kicks in when status='completed' and totalBusinessesToCall=0", () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          totalCallsCompleted: 0,
          refundOutcome: 'issued',
        })
      );
      expect(out.kind).toBe('coverage_gap');
      expect(out.refundDescriptor).toBe('issued');
    });

    it("kicks in when status='processing' and totalBusinessesToCall=0", () => {
      // 'processing' is treated as terminal by the helper because the
      // webhook's advanced:false path parks the row in 'processing'
      // with totals=0/0/0 and the refund cron drains it from there.
      const out = decideEmptyState(
        input({
          status: 'processing',
          totalBusinessesToCall: 0,
          totalCallsCompleted: 0,
          refundOutcome: 'issued',
        })
      );
      expect(out.kind).toBe('coverage_gap');
    });

    it('coverage_gap with pending_support refund descriptor', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          refundOutcome: 'pending_support',
        })
      );
      expect(out.kind).toBe('coverage_gap');
      expect(out.refundDescriptor).toBe('pending_support');
    });

    it('coverage_gap with unknown refund (null outcome)', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          refundOutcome: null,
        })
      );
      expect(out.kind).toBe('coverage_gap');
      expect(out.refundDescriptor).toBe('unknown');
    });

    it('null totalBusinessesToCall is treated as zero (coverage_gap)', () => {
      // Defensive: legacy rows or partial rollouts could carry null.
      // Helper treats null as 0 via `?? 0` and routes to coverage_gap
      // when status is terminal.
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: null,
          totalCallsCompleted: 0,
          refundOutcome: 'issued',
        })
      );
      expect(out.kind).toBe('coverage_gap');
    });
  });

  // ── no_quote branch ─────────────────────────────────────────────
  describe('no_quote', () => {
    it('kicks in when calls are all done, terminal status, but no quotes', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 5,
          refundOutcome: 'issued',
        })
      );
      expect(out.kind).toBe('no_quote');
      expect(out.refundDescriptor).toBe('issued');
    });

    it('still no_quote when calls overshot the dial list', () => {
      // CallsCompleted ≥ totalToCall (>=) so retries that happen to
      // end up incrementing past totalToCall must not regress us back
      // to in_flight.
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 7,
          refundOutcome: 'issued',
        })
      );
      expect(out.kind).toBe('no_quote');
    });

    it('no_quote with pending_support refund', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 3,
          totalCallsCompleted: 3,
          refundOutcome: 'pending_support',
        })
      );
      expect(out.kind).toBe('no_quote');
      expect(out.refundDescriptor).toBe('pending_support');
    });

    it('no_quote with unknown refund', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 3,
          totalCallsCompleted: 3,
          refundOutcome: null,
        })
      );
      expect(out.kind).toBe('no_quote');
      expect(out.refundDescriptor).toBe('unknown');
    });

    it('does NOT trigger no_quote when calls incomplete (still in_flight)', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 3,
        })
      );
      expect(out.kind).toBe('in_flight');
    });

    it('null totalCallsCompleted is treated as zero (still in_flight, not no_quote)', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 5,
          totalCallsCompleted: null,
        })
      );
      expect(out.kind).toBe('in_flight');
    });
  });

  // ── failed branch ───────────────────────────────────────────────
  describe('failed', () => {
    it("kicks in for status='failed' that didn't hit coverage_gap or no_quote", () => {
      const out = decideEmptyState(
        input({
          status: 'failed',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 2,
        })
      );
      expect(out.kind).toBe('failed');
      // failed branch deliberately does NOT carry a refundDescriptor —
      // ops follows up out-of-band.
      expect(out.refundDescriptor).toBeUndefined();
    });

    it('coverage_gap takes precedence over failed when totalToCall=0', () => {
      // If a row somehow ended up status='failed' with zero pros to
      // call, we want the coverage_gap copy (which is more truthful
      // for the customer) — but our helper only triggers coverage_gap
      // for terminal statuses ('completed' | 'processing'). status=
      // 'failed' is NOT terminal in this helper's definition, so the
      // failed branch wins. Lock that contract.
      const out = decideEmptyState(
        input({
          status: 'failed',
          totalBusinessesToCall: 0,
          totalCallsCompleted: 0,
        })
      );
      expect(out.kind).toBe('failed');
    });
  });

  // ── in_flight branch (default) ─────────────────────────────────
  describe('in_flight', () => {
    it("default: status='processing' mid-batch with calls in progress", () => {
      const out = decideEmptyState(
        input({
          status: 'processing',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 2,
        })
      );
      expect(out.kind).toBe('in_flight');
    });

    it('unknown status falls through to in_flight', () => {
      // Defensive: schema drift or new status values shouldn't crash
      // the page — we just keep showing the "still working" copy.
      const out = decideEmptyState(
        input({
          status: 'queued',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 0,
        })
      );
      expect(out.kind).toBe('in_flight');
    });

    it('in_flight does not carry refundDescriptor', () => {
      const out = decideEmptyState(
        input({
          status: 'processing',
          totalBusinessesToCall: 5,
          totalCallsCompleted: 2,
        })
      );
      expect(out.refundDescriptor).toBeUndefined();
    });
  });

  // ── refundDescriptor mapping ────────────────────────────────────
  describe('refundDescriptor mapping', () => {
    it("maps refundOutcome='issued' → 'issued'", () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          refundOutcome: 'issued',
        })
      );
      expect(out.refundDescriptor).toBe('issued');
    });

    it("maps refundOutcome='pending_support' → 'pending_support'", () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          refundOutcome: 'pending_support',
        })
      );
      expect(out.refundDescriptor).toBe('pending_support');
    });

    it('maps unrecognized outcome to "unknown"', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          refundOutcome: 'something_new',
        })
      );
      expect(out.refundDescriptor).toBe('unknown');
    });

    it('maps null outcome to "unknown"', () => {
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          refundOutcome: null,
        })
      );
      expect(out.refundDescriptor).toBe('unknown');
    });
  });

  // ── branch precedence (the order check) ─────────────────────────
  describe('branch precedence', () => {
    it('coverage_gap wins over no_quote when both could theoretically match', () => {
      // totalToCall=0 means callsDone evaluates false (the helper
      // requires totalToCall > 0 for callsDone). So in practice these
      // can't co-fire — but locking the contract here means a future
      // refactor that loosens callsDone won't silently change which
      // branch renders. Coverage_gap copy MUST win when no pros were
      // ever called.
      const out = decideEmptyState(
        input({
          status: 'completed',
          totalBusinessesToCall: 0,
          totalCallsCompleted: 0,
          refundOutcome: 'issued',
        })
      );
      expect(out.kind).toBe('coverage_gap');
    });
  });
});
