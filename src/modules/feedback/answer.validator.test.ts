import { describe, expect, it } from 'vitest';
import { validateFeedbackAnswers } from './answer.validator.js';
import type { FeedbackQuestion } from './questionnaire-snapshot.js';

const question = (overrides: Partial<FeedbackQuestion>): FeedbackQuestion => ({
  id: 'question-1',
  stableKey: 'overall',
  prompt: 'Overall rating',
  questionType: 'STAR_RATING',
  category: 'OVERALL_EXPERIENCE',
  status: 'ACTIVE',
  isRequired: true,
  displayOrder: 0,
  contributesToScore: true,
  scoreMin: 1,
  scoreMax: 5,
  options: [],
  ...overrides,
});

describe('feedback answer validation', () => {
  it('normalizes star and text answers', () => {
    const questions = [
      question({}),
      question({
        id: 'question-2',
        stableKey: 'comments',
        questionType: 'TEXT',
        category: 'CUSTOM',
        isRequired: false,
        displayOrder: 1,
        contributesToScore: false,
        scoreMin: null,
        scoreMax: null,
      }),
    ];
    const answers = validateFeedbackAnswers(questions, [
      { questionId: 'question-1', value: 5 },
      { questionId: 'question-2', value: '  Great trip  ' },
    ]);
    expect(answers).toMatchObject([
      {
        numericScore: 5,
        answerPayload: { value: 5 },
        questionnairePurposeSnapshot: 'DRIVER_FEEDBACK',
      },
      {
        numericScore: null,
        answerPayload: { value: 'Great trip' },
        questionnairePurposeSnapshot: 'DRIVER_FEEDBACK',
      },
    ]);
  });

  it('preserves the questionnaire purpose for reporting', () => {
    const [answer] = validateFeedbackAnswers(
      [{ ...question({}), questionnairePurpose: 'TOUR_EXPERIENCE' }],
      [{ questionId: 'question-1', value: 4 }],
    );
    expect(answer?.questionnairePurposeSnapshot).toBe('TOUR_EXPERIENCE');
  });

  it('normalizes yes/no and multiple-choice scores', () => {
    const yesNo = question({
      questionType: 'YES_NO',
      options: [
        { valueKey: 'yes', label: 'Yes', scoreValue: 5, displayOrder: 0 },
        { valueKey: 'no', label: 'No', scoreValue: 1, displayOrder: 1 },
      ],
      scoreMin: null,
      scoreMax: null,
    });
    const multiple = question({
      id: 'question-2',
      stableKey: 'qualities',
      questionType: 'MULTIPLE_CHOICE',
      isRequired: false,
      displayOrder: 1,
      options: [
        { valueKey: 'safe', label: 'Safe', scoreValue: 5, displayOrder: 0 },
        { valueKey: 'clean', label: 'Clean', scoreValue: 3, displayOrder: 1 },
      ],
      scoreMin: null,
      scoreMax: null,
    });
    const answers = validateFeedbackAnswers(
      [yesNo, multiple],
      [
        { questionId: 'question-1', value: true },
        { questionId: 'question-2', value: ['safe', 'clean'] },
      ],
    );
    expect(answers.map((answer) => answer.numericScore)).toEqual([5, 4]);
  });

  it('rejects missing, duplicate, and out-of-range answers', () => {
    expect(() => validateFeedbackAnswers([question({})], [])).toThrow(
      'Required questions are missing',
    );
    expect(() =>
      validateFeedbackAnswers(
        [question({})],
        [
          { questionId: 'question-1', value: 3 },
          { questionId: 'question-1', value: 4 },
        ],
      ),
    ).toThrow('A question cannot be answered more than once');
    expect(() =>
      validateFeedbackAnswers([question({})], [{ questionId: 'question-1', value: 6 }]),
    ).toThrow('Invalid rating for overall');
  });
});
