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
    | 'ARRIVAL_EXPERIENCE'
    | 'TOUR_EXPERIENCE'
    | 'TOUR_COORDINATION'
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
  readonly questionnaireName?: string;
  readonly purpose?: QuestionnairePurpose;
  readonly versionNumber: number;
  readonly questions: readonly FeedbackQuestion[];
}

export type QuestionnairePurpose = 'ARRIVAL_EXPERIENCE' | 'DRIVER_FEEDBACK' | 'TOUR_EXPERIENCE';

export interface FeedbackQuestionnaireSection {
  readonly purpose: QuestionnairePurpose;
  readonly displayOrder: number;
  readonly version: FeedbackQuestionnaireVersion;
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

export function buildCompositeQuestionnaireSnapshot(
  sections: readonly FeedbackQuestionnaireSection[],
) {
  return {
    schemaVersion: 2 as const,
    sections: [...sections]
      .sort((left, right) => left.displayOrder - right.displayOrder)
      .map(({ purpose, version }) => ({
        purpose,
        title: sectionTitle(purpose),
        questionnaireId: version.questionnaireId,
        questionnaireVersionId: version.id,
        versionNumber: version.versionNumber,
        questions: buildQuestionnaireSnapshot(version).questions,
      })),
  };
}

export function flattenCompositeQuestions(
  snapshot: ReturnType<typeof buildCompositeQuestionnaireSnapshot>,
) {
  return snapshot.sections.flatMap((section) =>
    section.questions.map((question) => ({
      ...question,
      status: 'ACTIVE' as const,
      questionnairePurpose: section.purpose,
    })),
  );
}

function sectionTitle(purpose: QuestionnairePurpose) {
  if (purpose === 'ARRIVAL_EXPERIENCE') return 'Arrival and booking experience';
  if (purpose === 'TOUR_EXPERIENCE') return 'Tour coordination and experience';
  return 'Driver feedback';
}
