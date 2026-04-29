// Defense-in-depth tests for the legal pages.
//
// R47.5: counsel review parked as a launch-day prerequisite (see
// docs/RUNBOOKS/soft-launch.md), and the operator-supplied draft is
// acceptable for soft launch. Both pages are now indexable and
// linked from the site footer + checkout consent line. The metadata
// lock here flips from "must be noindex" to "must be indexable" so
// a regression that sneaks a `noindex` back in fails loudly.

import { describe, expect, it } from 'vitest';

import { metadata as privacyMetadata } from './privacy/page';
import { metadata as termsMetadata } from './terms/page';

describe('legal page metadata', () => {
  describe('privacy', () => {
    it('is indexable (R47.5)', () => {
      expect(privacyMetadata.robots).toEqual({ index: true, follow: true });
    });

    it('still has a title and description (so the page renders cleanly)', () => {
      expect(privacyMetadata.title).toBeTruthy();
      expect(privacyMetadata.description).toBeTruthy();
    });
  });

  describe('terms', () => {
    it('is indexable (R47.5)', () => {
      expect(termsMetadata.robots).toEqual({ index: true, follow: true });
    });

    it('still has a title and description (so the page renders cleanly)', () => {
      expect(termsMetadata.title).toBeTruthy();
      expect(termsMetadata.description).toBeTruthy();
    });
  });
});
