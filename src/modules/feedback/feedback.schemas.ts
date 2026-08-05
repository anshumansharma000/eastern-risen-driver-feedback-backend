import { Type } from 'typebox';
import {
  consentSchema,
  questionCategorySchema,
  questionTypeSchema,
} from '../questionnaires/questionnaire.schemas.js';
import { tripSchema } from '../trips/trip.schemas.js';

const passengerOptionSchema = Type.Object({
  valueKey: Type.String(),
  label: Type.String(),
  scoreValue: Type.Union([Type.Number(), Type.Null()]),
  displayOrder: Type.Integer(),
});

const passengerQuestionSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  stableKey: Type.String(),
  prompt: Type.String(),
  questionType: questionTypeSchema,
  category: questionCategorySchema,
  isRequired: Type.Boolean(),
  displayOrder: Type.Integer(),
  contributesToScore: Type.Boolean(),
  scoreMin: Type.Union([Type.Number(), Type.Null()]),
  scoreMax: Type.Union([Type.Number(), Type.Null()]),
  options: Type.Array(passengerOptionSchema),
});

export const passengerContextSchema = Type.Object({
  trip: Type.Object({
    id: Type.String({ format: 'uuid' }),
    bookingReference: Type.String(),
    pickupLocation: Type.String(),
    destination: Type.String(),
    scheduledAt: Type.String({ format: 'date-time' }),
    vehicle: Type.Object({ registrationNumber: Type.String(), displayName: Type.String() }),
    driver: Type.Object({ displayName: Type.String() }),
  }),
  questionnaire: Type.Object({
    questionnaireId: Type.String({ format: 'uuid' }),
    questionnaireVersionId: Type.String({ format: 'uuid' }),
    versionNumber: Type.Integer(),
    questions: Type.Array(passengerQuestionSchema),
  }),
  consent: consentSchema,
  completion: Type.Object({
    agencyName: Type.String(),
    timezone: Type.String(),
    thankYouMessage: Type.String(),
  }),
});

export const passengerContextResponseSchema = Type.Object({ data: passengerContextSchema });

export const startFeedbackResponseSchema = Type.Object({
  data: Type.Object({
    tripId: Type.String({ format: 'uuid' }),
    status: Type.Literal('FEEDBACK_STARTED'),
    startedFeedbackAt: Type.String({ format: 'date-time' }),
  }),
});

export const handoffResponseSchema = Type.Object({
  data: Type.Intersect([
    tripSchema,
    Type.Object({
      feedbackAccessToken: Type.String(),
      feedbackAccessTokenExpiresAt: Type.String({ format: 'date-time' }),
      feedbackLink: Type.String({ format: 'uri' }),
    }),
  ]),
});

export const feedbackLinkResponseSchema = Type.Object({
  data: Type.Object({
    tripId: Type.String({ format: 'uuid' }),
    feedbackLink: Type.String({ format: 'uri' }),
    feedbackAccessTokenExpiresAt: Type.String({ format: 'date-time' }),
  }),
});

// The question type determines the value shape; domain validation occurs against
// the immutable questionnaire snapshot to avoid JSON-schema union coercion.
const answerValueSchema = Type.Unknown();

export const submitFeedbackBodySchema = Type.Object(
  {
    clientSubmissionId: Type.String({ format: 'uuid' }),
    questionnaireVersionId: Type.String({ format: 'uuid' }),
    questionnaireSnapshot: Type.Unknown(),
    respondent: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 200 }),
        phone: Type.String({ minLength: 1, maxLength: 32 }),
        email: Type.String({ format: 'email', maxLength: 320 }),
        bookingReference: Type.String({ minLength: 1, maxLength: 100 }),
        consentAccepted: Type.Literal(true),
        consentedAt: Type.String({ format: 'date-time' }),
      },
      { additionalProperties: false },
    ),
    answers: Type.Array(
      Type.Object(
        {
          questionId: Type.String({ format: 'uuid' }),
          value: answerValueSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    submittedAt: Type.String({ format: 'date-time' }),
    submissionMode: Type.Union([Type.Literal('ONLINE'), Type.Literal('OFFLINE_SYNC')]),
  },
  { additionalProperties: false },
);

export const submissionReceiptSchema = Type.Object({
  data: Type.Object({
    id: Type.String({ format: 'uuid' }),
    clientSubmissionId: Type.String({ format: 'uuid' }),
    tripId: Type.String({ format: 'uuid' }),
    receivedAt: Type.String({ format: 'date-time' }),
    submissionMode: Type.Union([Type.Literal('ONLINE'), Type.Literal('OFFLINE_SYNC')]),
    replayed: Type.Boolean(),
    rewardEligible: Type.Boolean(),
  }),
});
