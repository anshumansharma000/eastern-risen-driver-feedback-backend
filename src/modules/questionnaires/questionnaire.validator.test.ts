import { describe, expect, it } from 'vitest';
import { validateQuestionnaireQuestions, type QuestionInput } from './questionnaire.validator.js';

const starQuestion: QuestionInput = {
  stableKey: 'overall',
  prompt: 'Overall rating',
  questionType: 'STAR_RATING',
  category: 'OVERALL_EXPERIENCE',
  isRequired: true,
  contributesToScore: true,
  scoreMin: 1,
  scoreMax: 5,
  options: [],
};

describe('questionnaire validation', () => {
  it('accepts a valid publishable questionnaire', () => {
    expect(() => validateQuestionnaireQuestions([starQuestion], true)).not.toThrow();
  });

  it('requires an active question before publication', () => {
    expect(() =>
      validateQuestionnaireQuestions([{ ...starQuestion, status: 'ARCHIVED' }], true),
    ).toThrow('A published questionnaire requires an active question');
  });

  it('rejects duplicate keys and invalid score bounds', () => {
    expect(() => validateQuestionnaireQuestions([starQuestion, starQuestion], false)).toThrow(
      'Question stable keys must be unique',
    );
    expect(() =>
      validateQuestionnaireQuestions([{ ...starQuestion, scoreMin: 5, scoreMax: 1 }], true),
    ).toThrow('overall requires valid score bounds');
  });

  it('requires valid, scored options for scored choice questions', () => {
    const choice: QuestionInput = {
      ...starQuestion,
      stableKey: 'recommend',
      questionType: 'YES_NO',
      scoreMin: null,
      scoreMax: null,
      options: [
        { valueKey: 'yes', label: 'Yes', scoreValue: 5 },
        { valueKey: 'no', label: 'No' },
      ],
    };
    expect(() => validateQuestionnaireQuestions([choice], true)).toThrow(
      'recommend requires a score for every option',
    );
  });

  it('allows incomplete option configuration while editing a draft', () => {
    const choice: QuestionInput = {
      ...starQuestion,
      stableKey: 'highlights',
      questionType: 'MULTIPLE_CHOICE',
      scoreMin: null,
      scoreMax: null,
      options: [{ valueKey: 'safe', label: 'Safe' }],
    };

    expect(() => validateQuestionnaireQuestions([choice], false)).not.toThrow();
    expect(() =>
      validateQuestionnaireQuestions(
        [
          {
            stableKey: 'highlights_without_options',
            prompt: choice.prompt,
            questionType: choice.questionType,
            category: choice.category,
            isRequired: choice.isRequired,
            contributesToScore: choice.contributesToScore,
            scoreMin: null,
            scoreMax: null,
          },
        ],
        false,
      ),
    ).not.toThrow();
    expect(() => validateQuestionnaireQuestions([choice], true)).toThrow(
      'highlights requires at least two options',
    );
  });

  it('accepts optional scores when a choice question does not contribute to scoring', () => {
    const choice: QuestionInput = {
      ...starQuestion,
      stableKey: 'ride_highlight',
      questionType: 'SINGLE_CHOICE',
      contributesToScore: false,
      scoreMin: null,
      scoreMax: null,
      options: [
        { valueKey: 'safety', label: 'Safety', scoreValue: 5 },
        { valueKey: 'comfort', label: 'Comfort' },
      ],
    };

    expect(() => validateQuestionnaireQuestions([choice], true)).not.toThrow();
  });

  it('defers incomplete score configuration until publication', () => {
    const choice: QuestionInput = {
      ...starQuestion,
      stableKey: 'service_quality',
      questionType: 'SINGLE_CHOICE',
      scoreMin: null,
      scoreMax: null,
      options: [
        { valueKey: 'great', label: 'Great', scoreValue: 5 },
        { valueKey: 'poor', label: 'Poor' },
      ],
    };

    expect(() => validateQuestionnaireQuestions([choice], false)).not.toThrow();
    expect(() => validateQuestionnaireQuestions([choice], true)).toThrow(
      'service_quality requires a score for every option',
    );
  });
});
