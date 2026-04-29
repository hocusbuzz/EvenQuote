// Pure helper for the customer dashboard's empty-state branching
// (used by app/dashboard/requests/[id]/page.tsx).
//
// Extracted as a separate module per R47.6 so the four-way branch
// can be locked by a unit test — the page itself is a server
// component and rendering it from a vitest test would require a
// Supabase admin stub + auth shim that aren't worth the bytes.
// Decision logic lives here; the page just maps the kind to JSX.
//
// Branch order (most specific first):
//   1. 'coverage_gap'  — terminal status with total_businesses_to_call=0.
//                         Webhook's advanced:false path produced this.
//   2. 'no_quote'      — terminal status, calls completed, but quotes=0.
//                         Pros were reached, none gave a usable price.
//   3. 'failed'        — status='failed' that didn't hit either above.
//                         Mid-batch error; ops follow up.
//   4. 'in_flight'     — anything else; report still being built.

export type EmptyStateInput = {
  status: string;
  totalBusinessesToCall: number | null;
  totalCallsCompleted: number | null;
  refundOutcome: string | null;
};

export type EmptyStateKind =
  | 'coverage_gap'
  | 'no_quote'
  | 'failed'
  | 'in_flight';

export type RefundDescriptor = 'issued' | 'pending_support' | 'unknown';

export type EmptyStateDecision = {
  kind: EmptyStateKind;
  /** Only populated for terminal kinds where a refund is relevant. */
  refundDescriptor?: RefundDescriptor;
};

/**
 * Decide which empty-state branch to render for a request that has
 * zero quotes attached. Caller is the page; test target is this fn.
 */
export function decideEmptyState(input: EmptyStateInput): EmptyStateDecision {
  const isTerminal =
    input.status === 'completed' || input.status === 'processing';
  const totalToCall = input.totalBusinessesToCall ?? 0;
  const callsDone =
    totalToCall > 0 && (input.totalCallsCompleted ?? 0) >= totalToCall;

  const refundDescriptor: RefundDescriptor =
    input.refundOutcome === 'issued'
      ? 'issued'
      : input.refundOutcome === 'pending_support'
        ? 'pending_support'
        : 'unknown';

  if (isTerminal && totalToCall === 0) {
    return { kind: 'coverage_gap', refundDescriptor };
  }
  if (callsDone && isTerminal) {
    return { kind: 'no_quote', refundDescriptor };
  }
  if (input.status === 'failed') {
    return { kind: 'failed' };
  }
  return { kind: 'in_flight' };
}
