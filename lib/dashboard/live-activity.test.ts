// Tests for the pure helpers behind /dashboard/requests/[id]'s live
// activity panel. Subscription wiring isn't tested here — that lives
// in the React component and is exercised manually + via integration.

import { describe, it, expect } from 'vitest';
import { shouldShowLiveActivity, callStatusDisplay } from './live-activity';

describe('shouldShowLiveActivity', () => {
  // Note: 'paid' explicitly included — that's the highest-anxiety
  // window for a customer just after checkout. The Realtime INSERT
  // event for the first call has nothing to render against without it.
  it.each([['paid'], ['calling'], ['processing']])(
    'returns true for in-motion status %s',
    (status) => {
      expect(shouldShowLiveActivity(status)).toBe(true);
    },
  );

  it.each([
    ['completed'],
    ['failed'],
    ['refunded'],
    ['pending_payment'],
    ['cancelled'],
  ])('returns false for terminal status %s', (status) => {
    expect(shouldShowLiveActivity(status)).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(shouldShowLiveActivity(null)).toBe(false);
    expect(shouldShowLiveActivity(undefined)).toBe(false);
  });
});

describe('callStatusDisplay', () => {
  // Locks the customer-facing copy. The `label` strings ship to a
  // paying user during the most-anxious wait window — small wording
  // changes here have outsized UX impact, so a regression here should
  // surface as a test diff in the PR.
  it('maps queued to neutral "Queued"', () => {
    expect(callStatusDisplay('queued')).toEqual({
      label: 'Queued',
      tone: 'neutral',
    });
  });

  it('maps in_progress to neutral "Calling…"', () => {
    expect(callStatusDisplay('in_progress')).toEqual({
      label: 'Calling…',
      tone: 'neutral',
    });
  });

  it('maps completed to positive "Spoke with pro"', () => {
    expect(callStatusDisplay('completed')).toEqual({
      label: 'Spoke with pro',
      tone: 'positive',
    });
  });

  it('maps no_answer to neutral (not negative — a voicemail isn\'t a failure)', () => {
    // This is a deliberate copy choice. Voicemails are common and
    // we'll often try the next pro instead — calling that "negative"
    // would over-alarm the customer.
    expect(callStatusDisplay('no_answer').tone).toBe('neutral');
  });

  it('maps refused to negative "Pro declined"', () => {
    expect(callStatusDisplay('refused')).toEqual({
      label: 'Pro declined',
      tone: 'negative',
    });
  });

  it('maps failed to negative "Call failed"', () => {
    expect(callStatusDisplay('failed')).toEqual({
      label: 'Call failed',
      tone: 'negative',
    });
  });

  it('falls back to the raw status with neutral tone for unknown enums', () => {
    expect(callStatusDisplay('some_future_state')).toEqual({
      label: 'some_future_state',
      tone: 'neutral',
    });
  });
});
