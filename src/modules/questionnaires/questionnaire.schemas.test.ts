import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { createQuestionnaireBodySchema, questionInputSchema } from './questionnaire.schemas.js';

describe('questionnaire purpose contract', () => {
  it('requires a supported purpose when creating a questionnaire', () => {
    expect(
      Check(createQuestionnaireBodySchema, {
        name: 'Arrival feedback',
        purpose: 'ARRIVAL_EXPERIENCE',
      }),
    ).toBe(true);
    expect(Check(createQuestionnaireBodySchema, { name: 'Missing purpose' })).toBe(false);
    expect(Check(createQuestionnaireBodySchema, { name: 'Unknown', purpose: 'OTHER' })).toBe(false);
  });

  it('accepts arrival, tour experience, and coordination reporting categories', () => {
    for (const category of ['ARRIVAL_EXPERIENCE', 'TOUR_EXPERIENCE', 'TOUR_COORDINATION']) {
      expect(
        Check(questionInputSchema, {
          stableKey: `${category.toLowerCase()}_rating`,
          prompt: 'Rate this experience',
          questionType: 'STAR_RATING',
          category,
          isRequired: true,
          contributesToScore: true,
          scoreMin: 1,
          scoreMax: 5,
          options: [],
        }),
      ).toBe(true);
    }
  });
});
