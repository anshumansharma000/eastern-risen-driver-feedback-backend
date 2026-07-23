import { Type } from 'typebox';
import { idParamsSchema } from '../vendors/vendor.schemas.js';

export { idParamsSchema };

export const questionnaireVersionParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  versionId: Type.String({ format: 'uuid' }),
});

export const questionTypeSchema = Type.Union([
  Type.Literal('STAR_RATING'),
  Type.Literal('EMOJI_RATING'),
  Type.Literal('YES_NO'),
  Type.Literal('SINGLE_CHOICE'),
  Type.Literal('MULTIPLE_CHOICE'),
  Type.Literal('TEXT'),
]);

export const questionCategorySchema = Type.Union([
  Type.Literal('OVERALL_EXPERIENCE'),
  Type.Literal('DRIVING_SAFETY'),
  Type.Literal('PUNCTUALITY'),
  Type.Literal('CLEANLINESS'),
  Type.Literal('PROFESSIONALISM'),
  Type.Literal('VEHICLE_CONDITION'),
  Type.Literal('CUSTOM'),
]);

export const questionStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('INACTIVE'),
  Type.Literal('ARCHIVED'),
]);

const optionInputSchema = Type.Object(
  {
    valueKey: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9_-]+$' }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    scoreValue: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const questionInputSchema = Type.Object(
  {
    stableKey: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9_-]+$' }),
    prompt: Type.String({ minLength: 1, maxLength: 1000 }),
    questionType: questionTypeSchema,
    category: questionCategorySchema,
    status: Type.Optional(questionStatusSchema),
    isRequired: Type.Boolean(),
    contributesToScore: Type.Boolean(),
    scoreMin: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    scoreMax: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    options: Type.Array(optionInputSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const createQuestionnaireBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const updateQuestionnaireBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const replaceQuestionsBodySchema = Type.Object(
  {
    questions: Type.Array(questionInputSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const consentBodySchema = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: 20_000 }),
  },
  { additionalProperties: false },
);

export const questionnaireSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const optionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  valueKey: Type.String(),
  label: Type.String(),
  scoreValue: Type.Union([Type.Number(), Type.Null()]),
  displayOrder: Type.Integer(),
});

export const questionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  stableKey: Type.String(),
  prompt: Type.String(),
  questionType: questionTypeSchema,
  category: questionCategorySchema,
  status: questionStatusSchema,
  isRequired: Type.Boolean(),
  displayOrder: Type.Integer(),
  contributesToScore: Type.Boolean(),
  scoreMin: Type.Union([Type.Number(), Type.Null()]),
  scoreMax: Type.Union([Type.Number(), Type.Null()]),
  options: Type.Array(optionSchema),
});

export const questionnaireVersionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  questionnaireId: Type.String({ format: 'uuid' }),
  questionnaireName: Type.String(),
  versionNumber: Type.Integer(),
  status: Type.Union([
    Type.Literal('DRAFT'),
    Type.Literal('ACTIVE'),
    Type.Literal('RETIRED'),
    Type.Literal('ARCHIVED'),
  ]),
  publishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  questions: Type.Array(questionSchema),
});

export const consentSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  version: Type.Integer(),
  content: Type.String(),
  effectiveAt: Type.String({ format: 'date-time' }),
  retiredAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});
