export interface FeedbackQuestionOption {
  readonly valueKey: string;
  readonly label: string;
  readonly scoreValue: number | null;
  readonly displayOrder: number;
}

export interface FeedbackQuestion {
  readonly id: string;
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
  readonly status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  readonly isRequired: boolean;
  readonly displayOrder: number;
  readonly contributesToScore: boolean;
  readonly scoreMin: number | null;
  readonly scoreMax: number | null;
  readonly options: readonly FeedbackQuestionOption[];
}

export interface FeedbackQuestionnaireVersion {
  readonly id: string;
  readonly questionnaireId: string;
  readonly versionNumber: number;
  readonly questions: readonly FeedbackQuestion[];
}

export function buildQuestionnaireSnapshot(version: FeedbackQuestionnaireVersion) {
  return {
    questionnaireId: version.questionnaireId,
    questionnaireVersionId: version.id,
    versionNumber: version.versionNumber,
    questions: version.questions
      .filter((question) => question.status === 'ACTIVE')
      .map((question) => ({
        id: question.id,
        stableKey: question.stableKey,
        prompt: question.prompt,
        questionType: question.questionType,
        category: question.category,
        isRequired: question.isRequired,
        displayOrder: question.displayOrder,
        contributesToScore: question.contributesToScore,
        scoreMin: question.scoreMin,
        scoreMax: question.scoreMax,
        options: question.options.map((option) => ({
          valueKey: option.valueKey,
          label: option.label,
          scoreValue: option.scoreValue,
          displayOrder: option.displayOrder,
        })),
      })),
  };
}
