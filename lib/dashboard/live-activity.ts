// Helpers for the live-activity panel on /dashboard/requests/[id].
// Pure logic — no React, no Supabase — so the visibility rules + label
// mapping are unit-testable without a DOM or a websocket harness.

/**
 * Quote-request statuses that mean "still in motion" — the live panel
 * is useful to show during these. Once the request is terminal
 * (completed / failed / refunded / cancelled / etc.), the panel hides
 * and the static quotes list is authoritative.
 *
 * Note: 'paid' is included even when no calls have started yet — that's
 * the most anxious window for the customer ("I just paid $9.99 and
 * nothing's happening"), and it's exactly when an INSERT event from
 * Realtime should pop the first row in.
 */
const IN_MOTION = new Set(['paid', 'calling', 'processing']);

export function shouldShowLiveActivity(status: string | null | undefined): boolean {
  if (!status) return false;
  return IN_MOTION.has(status);
}

/**
 * Map a calls.status enum value to display copy + a tone hint for
 * styling. Tones are abstract (positive/neutral/negative) so the
 * component can pick its own colors without leaking color logic here.
 */
export type CallStatusDisplay = {
  label: string;
  tone: 'positive' | 'neutral' | 'negative';
};

export function callStatusDisplay(status: string): CallStatusDisplay {
  switch (status) {
    case 'queued':
      return { label: 'Queued', tone: 'neutral' };
    case 'in_progress':
      return { label: 'Calling…', tone: 'neutral' };
    case 'completed':
      return { label: 'Spoke with pro', tone: 'positive' };
    case 'no_answer':
      return { label: 'No answer / voicemail', tone: 'neutral' };
    case 'refused':
      return { label: 'Pro declined', tone: 'negative' };
    case 'failed':
      return { label: 'Call failed', tone: 'negative' };
    default:
      return { label: status, tone: 'neutral' };
  }
}
