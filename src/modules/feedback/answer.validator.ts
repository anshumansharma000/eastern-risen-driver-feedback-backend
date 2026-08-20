import { AppError } from '../../shared/errors/app-error.js';
import type { FeedbackQuestion } from './questionnaire-snapshot.js';
import type { QuestionnairePurpose } from './questionnaire-snapshot.js';

type ScopedFeedbackQuestion = FeedbackQuestion & {
  readonly questionnairePurpose?: QuestionnairePurpose;
};

export interface FeedbackAnswerInput {
  readonly questionId: string;
  readonly value: unknown;
}

export function validateFeedbackAnswers(
  questions: readonly ScopedFeedbackQuestion[],
  inputs: readonly FeedbackAnswerInput[],
) {
  const activeQuestions = questions.filter((question) => question.status === 'ACTIVE');
  const questionsById = new Map(activeQuestions.map((question) => [question.id, question]));

  if (new Set(inputs.map((answer) => answer.questionId)).size !== inputs.length) {
    invalid('A question cannot be answered more than once');
  }

  const answers = inputs.map((input) => {
    const question = questionsById.get(input.questionId);
    if (!question) invalid('An answer references an unavailable question');
    const normalized = normalizeAnswer(question, input.value);
    return {
      versionQuestionId: question.id,
      questionStableKey: question.stableKey,
      questionPromptSnapshot: question.prompt,
      questionTypeSnapshot: question.questionType,
      categorySnapshot: question.category,
      questionnairePurposeSnapshot: question.questionnairePurpose ?? 'DRIVER_FEEDBACK',
      displayOrderSnapshot: question.displayOrder,
      answerPayload: normalized.payload,
      numericScore: normalized.score,
    };
  });

  const answeredQuestionIds = new Set(inputs.map((answer) => answer.questionId));
  const missing = activeQuestions.filter(
    (question) => question.isRequired && !answeredQuestionIds.has(question.id),
  );
  if (missing.length) {
    invalid(
      `Required questions are missing: ${missing.map((question) => question.stableKey).join(', ')}`,
    );
  }
  return answers;
}

function normalizeAnswer(question: FeedbackQuestion, value: unknown) {
  if (question.questionType === 'STAR_RATING') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      question.scoreMin == null ||
      question.scoreMax == null ||
      value < question.scoreMin ||
      value > question.scoreMax
    ) {
      invalid(`Invalid rating for ${question.stableKey}`);
    }
    return { payload: { value }, score: question.contributesToScore ? value : null };
  }

  if (question.questionType === 'TEXT') {
    if (typeof value !== 'string' || !value.trim()) {
      invalid(`Invalid text answer for ${question.stableKey}`);
    }
    return { payload: { value: value.trim() }, score: null };
  }

  if (question.questionType === 'YES_NO') {
    if (typeof value !== 'boolean') invalid(`Invalid yes/no answer for ${question.stableKey}`);
    const option = question.options.find(
      (candidate) => candidate.valueKey === (value ? 'yes' : 'no'),
    );
    if (!option) invalid(`${question.stableKey} must define yes and no options`);
    return {
      payload: { value, optionKey: option.valueKey, label: option.label },
      score: question.contributesToScore ? option.scoreValue : null,
    };
  }

  if (question.questionType === 'MULTIPLE_CHOICE') {
    if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
      invalid(`Invalid multiple-choice answer for ${question.stableKey}`);
    }
    const selected = value.map((key) => question.options.find((option) => option.valueKey === key));
    if (selected.some((option) => !option)) invalid(`Invalid option for ${question.stableKey}`);
    const selectedOptions = selected.filter((option) => option !== undefined);
    const scores = selectedOptions
      .map((option) => option.scoreValue)
      .filter((score): score is number => score !== null);
    return {
      payload: {
        options: selectedOptions.map((option) => ({
          optionKey: option.valueKey,
          label: option.label,
        })),
      },
      score:
        question.contributesToScore && scores.length === selectedOptions.length
          ? scores.reduce((sum, score) => sum + score, 0) / scores.length
          : null,
    };
  }

  if (typeof value !== 'string') invalid(`Invalid option for ${question.stableKey}`);
  const option = question.options.find((candidate) => candidate.valueKey === value);
  if (!option) invalid(`Invalid option for ${question.stableKey}`);
  return {
    payload: { optionKey: option.valueKey, label: option.label },
    score: question.contributesToScore ? option.scoreValue : null,
  };
}

function invalid(message: string): never {
  throw new AppError({ code: 'FEEDBACK_ANSWERS_INVALID', message, statusCode: 400 });
}
