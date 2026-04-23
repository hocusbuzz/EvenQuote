// Defense-in-depth tests for the legal pages.
//
// Both /legal/privacy and /legal/terms are drafts pending counsel review
// and intentionally not linked from the site footer. Per Antonio's
// preference to never publish unreviewed legal content, the metadata
// MUST set `robots: { index: false, follow: false }` until the review
// lands. If anyone removes that — by accident or because "we're shipping
// next week" — these tests fail loudly.
//
// At publish time: delete this file (or invert the assertion) along
// with the metadata change.

import { describe, expect, it } from 'vitest';

import { metadata as privacyMetadata } from './privacy/page';
import { metadata as termsMetadata } from './terms/page';

describe('legal page metadata', () => {
  describe('privacy', () => {
    it('explicitly opts out of indexing', () => {
      expect(privacyMetadata.robots).toEqual({ index: false, follow: false });
    });

    it('still has a title and description (so the page renders cleanly)', () => {
      expect(privacyMetadata.title).toBeTruthy();
      expect(privacyMetadata.description).toBeTruthy();
    });
  });

  describe('terms', () => {
    it('explicitly opts out of indexing', () => {
      expect(termsMetadata.robots).toEqual({ index: false, follow: false });
    });

    it('still has a title and description (so the page renders cleanly)', () => {
      expect(termsMetadata.title).toBeTruthy();
      expect(termsMetadata.description).toBeTruthy();
    });
  });
});
