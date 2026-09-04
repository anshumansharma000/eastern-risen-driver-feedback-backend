import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { updateEngagementFeedbackSectionsBodySchema } from './engagement.schemas.js';

describe('engagement feedback section update contract', () => {
  it('accepts one to three unique supported sections', () => {
    expect(
      Check(updateEngagementFeedbackSectionsBodySchema, {
        feedbackPurposes: ['DRIVER_FEEDBACK'],
      }),
    ).toBe(true);
    expect(
      Check(updateEngagementFeedbackSectionsBodySchema, {
        feedbackPurposes: ['ARRIVAL_EXPERIENCE', 'DRIVER_FEEDBACK', 'TOUR_EXPERIENCE'],
      }),
    ).toBe(true);
  });

  it('rejects empty, duplicate, unsupported, and additional values', () => {
    expect(Check(updateEngagementFeedbackSectionsBodySchema, { feedbackPurposes: [] })).toBe(false);
    expect(
      Check(updateEngagementFeedbackSectionsBodySchema, {
        feedbackPurposes: ['DRIVER_FEEDBACK', 'DRIVER_FEEDBACK'],
      }),
    ).toBe(false);
    expect(
      Check(updateEngagementFeedbackSectionsBodySchema, {
        feedbackPurposes: ['UNKNOWN'],
      }),
    ).toBe(false);
    expect(
      Check(updateEngagementFeedbackSectionsBodySchema, {
        feedbackPurposes: ['DRIVER_FEEDBACK'],
        status: 'READY',
      }),
    ).toBe(false);
  });
});
