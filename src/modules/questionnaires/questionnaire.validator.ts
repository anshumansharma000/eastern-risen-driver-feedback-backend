import { AppError } from '../../shared/errors/app-error.js';

export interface QuestionInput {
  readonly stableKey: string;
  readonly prompt: string;
  readonly questionType:
    'STAR_RATING' | 'EMOJI_RATING' | 'YES_NO' | 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT';
  readonly category:
    | 'OVERALL_EXPERIENCE'
    | 'DRIVING_SAFETY'
    | 'PUNCTUALITY'
    | 'CLEANLINESS'
    | 'PROFESSIONALISM'
    | 'VEHICLE_CONDITION'
    | 'CUSTOM';
  readonly status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  readonly isRequired: boolean;
  readonly contributesToScore: boolean;
  readonly scoreMin?: number | null;
  readonly scoreMax?: number | null;
  readonly options?: readonly {
    readonly valueKey: string;
    readonly label: string;
    readonly scoreValue?: number | null;
  }[];
}

const OPTION_TYPES = new Set(['EMOJI_RATING', 'YES_NO', 'SINGLE_CHOICE', 'MULTIPLE_CHOICE']);

export function validateQuestionnaireQuestions(
  questions: readonly QuestionInput[],
  publishing: boolean,
): void {
  const active = questions.filter((question) => (question.status ?? 'ACTIVE') === 'ACTIVE');
  if (publishing && active.length === 0) {
    invalid(
      'QUESTIONNAIRE_HAS_NO_ACTIVE_QUESTIONS',
      'A published questionnaire requires an active question',
    );
  }
  if (new Set(questions.map((question) => question.stableKey)).size !== questions.length) {
    invalid('DUPLICATE_QUESTION_KEY', 'Question stable keys must be unique');
  }

  for (const question of questions) {
    const options = question.options ?? [];
    const optionKeys = options.map((option) => option.valueKey);
    if (new Set(optionKeys).size !== optionKeys.length) {
      invalid('DUPLICATE_OPTION_KEY', `Option keys for ${question.stableKey} must be unique`);
    }
    const acceptsOptions = OPTION_TYPES.has(question.questionType);
    if (publishing && acceptsOptions && options.length < 2) {
      invalid('QUESTION_OPTIONS_REQUIRED', `${question.stableKey} requires at least two options`);
    }
    if (!acceptsOptions && options.length > 0) {
      invalid('QUESTION_OPTIONS_NOT_ALLOWED', `${question.stableKey} does not support options`);
    }
    if (
      publishing &&
      question.questionType === 'STAR_RATING' &&
      (question.scoreMin == null ||
        question.scoreMax == null ||
        question.scoreMin >= question.scoreMax)
    ) {
      invalid(
        'QUESTION_SCORE_BOUNDS_REQUIRED',
        `${question.stableKey} requires valid score bounds`,
      );
    }
    if (
      publishing &&
      question.contributesToScore &&
      acceptsOptions &&
      options.some((option) => option.scoreValue == null)
    ) {
      invalid(
        'QUESTION_OPTION_SCORES_REQUIRED',
        `${question.stableKey} requires a score for every option`,
      );
    }
  }
}

function invalid(code: string, message: string): never {
  throw new AppError({ code, message, statusCode: 400 });
}
