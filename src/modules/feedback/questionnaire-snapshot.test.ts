import { describe, expect, it } from 'vitest';
import {
  buildCompositeQuestionnaireSnapshot,
  flattenCompositeQuestions,
  type FeedbackQuestionnaireSection,
} from './questionnaire-snapshot.js';

function section(
  purpose: FeedbackQuestionnaireSection['purpose'],
  displayOrder: number,
): FeedbackQuestionnaireSection {
  return {
    purpose,
    displayOrder,
    version: {
      id: `${purpose}-version`,
      questionnaireId: `${purpose}-questionnaire`,
      versionNumber: 1,
      questions: [
        {
          id: `${purpose}-question`,
          stableKey: `${purpose.toLowerCase()}_rating`,
          prompt: 'Rate this section',
          questionType: 'STAR_RATING',
          category:
            purpose === 'ARRIVAL_EXPERIENCE'
              ? 'ARRIVAL_EXPERIENCE'
              : purpose === 'TOUR_EXPERIENCE'
                ? 'TOUR_EXPERIENCE'
                : 'OVERALL_EXPERIENCE',
          status: 'ACTIVE',
          isRequired: true,
          displayOrder: 0,
          contributesToScore: true,
          scoreMin: 1,
          scoreMax: 5,
          options: [],
        },
      ],
    },
  };
}

describe('composite questionnaire snapshots', () => {
  it('uses fixed section ordering and passenger-facing titles', () => {
    const snapshot = buildCompositeQuestionnaireSnapshot([
      section('TOUR_EXPERIENCE', 2),
      section('ARRIVAL_EXPERIENCE', 0),
      section('DRIVER_FEEDBACK', 1),
    ]);

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.sections.map(({ purpose, title }) => ({ purpose, title }))).toEqual([
      { purpose: 'ARRIVAL_EXPERIENCE', title: 'Arrival and booking experience' },
      { purpose: 'DRIVER_FEEDBACK', title: 'Driver feedback' },
      { purpose: 'TOUR_EXPERIENCE', title: 'Tour coordination and experience' },
    ]);
  });

  it('attaches section purposes when flattening questions for validation', () => {
    const snapshot = buildCompositeQuestionnaireSnapshot([
      section('DRIVER_FEEDBACK', 0),
      section('TOUR_EXPERIENCE', 1),
    ]);

    expect(
      flattenCompositeQuestions(snapshot).map((question) => question.questionnairePurpose),
    ).toEqual(['DRIVER_FEEDBACK', 'TOUR_EXPERIENCE']);
  });
});
