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
      validateQuestionnaireQuestions([{ ...starQuestion, scoreMin: 5, scoreMax: 1 }], false),
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
    expect(() => validateQuestionnaireQuestions([choice], false)).toThrow(
      'recommend requires a score for every option',
    );
  });
});
