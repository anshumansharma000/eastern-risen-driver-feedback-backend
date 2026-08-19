import { Type } from 'typebox';
import { driverSourceSchema } from '../drivers/driver.schemas.js';
import {
  questionCategorySchema,
  questionTypeSchema,
} from '../questionnaires/questionnaire.schemas.js';

export const feedbackReviewStateSchema = Type.Union([
  Type.Literal('NORMAL'),
  Type.Literal('FLAGGED'),
  Type.Literal('ARCHIVED'),
]);

export const feedbackSubmissionModeSchema = Type.Union([
  Type.Literal('ONLINE'),
  Type.Literal('OFFLINE_SYNC'),
]);

export const feedbackReviewActionSchema = Type.Union([
  Type.Literal('FLAG'),
  Type.Literal('UNFLAG'),
  Type.Literal('ARCHIVE'),
]);

export const monthSchema = Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$' });

export const adminFeedbackListQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  month: Type.Optional(monthSchema),
  driverId: Type.Optional(Type.String({ format: 'uuid' })),
  driverSource: Type.Optional(driverSourceSchema),
  vendorId: Type.Optional(Type.String({ format: 'uuid' })),
  reviewState: Type.Optional(feedbackReviewStateSchema),
  submissionMode: Type.Optional(feedbackSubmissionModeSchema),
  category: Type.Optional(questionCategorySchema),
  minimumScore: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
  maximumScore: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
  negativeOnly: Type.Optional(Type.Boolean()),
});

export const adminFeedbackSummarySchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  tripId: Type.String({ format: 'uuid' }),
  bookingReference: Type.String(),
  respondentName: Type.String(),
  driver: Type.Object({
    id: Type.String({ format: 'uuid' }),
    displayName: Type.String(),
    sourceType: driverSourceSchema,
    vendorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    vendorName: Type.Union([Type.String(), Type.Null()]),
  }),
  submittedAt: Type.String({ format: 'date-time' }),
  receivedAt: Type.String({ format: 'date-time' }),
  submissionMode: feedbackSubmissionModeSchema,
  reviewState: feedbackReviewStateSchema,
  overallScore: Type.Union([Type.Number(), Type.Null()]),
});

export const feedbackReviewEventSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  action: feedbackReviewActionSchema,
  reason: Type.Union([Type.String(), Type.Null()]),
  performedBy: Type.Object({
    accountId: Type.String({ format: 'uuid' }),
    displayName: Type.String(),
  }),
  createdAt: Type.String({ format: 'date-time' }),
});

export const adminFeedbackAnswerSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  questionId: Type.String({ format: 'uuid' }),
  stableKey: Type.String(),
  prompt: Type.String(),
  questionType: questionTypeSchema,
  category: questionCategorySchema,
  displayOrder: Type.Integer(),
  value: Type.Unknown(),
  numericScore: Type.Union([Type.Number(), Type.Null()]),
});

export const adminFeedbackDetailSchema = Type.Intersect([
  adminFeedbackSummarySchema,
  Type.Object({
    respondent: Type.Object({
      name: Type.String(),
      phone: Type.String(),
      email: Type.String({ format: 'email' }),
      bookingReference: Type.String(),
    }),
    trip: Type.Object({
      pickupLocation: Type.String(),
      destination: Type.String(),
      scheduledAt: Type.String({ format: 'date-time' }),
      scheduledEndAt: Type.String({ format: 'date-time' }),
      vehicle: Type.Object({
        registrationNumber: Type.String(),
        displayName: Type.String(),
      }),
    }),
    consentVersionId: Type.String({ format: 'uuid' }),
    consentedAt: Type.String({ format: 'date-time' }),
    questionnaireVersionId: Type.String({ format: 'uuid' }),
    photo: Type.Union([
      Type.Object({
        id: Type.String({ format: 'uuid' }),
        contentType: Type.String(),
        byteSize: Type.Integer(),
        attachedAt: Type.String({ format: 'date-time' }),
      }),
      Type.Null(),
    ]),
    answers: Type.Array(adminFeedbackAnswerSchema),
    reviewHistory: Type.Array(feedbackReviewEventSchema),
  }),
]);

export const adminFeedbackPhotoAccessSchema = Type.Object({
  data: Type.Object({
    id: Type.String({ format: 'uuid' }),
    url: Type.String({ format: 'uri' }),
    expiresAt: Type.String({ format: 'date-time' }),
    contentType: Type.String(),
    byteSize: Type.Integer(),
  }),
});

export const updateFeedbackReviewBodySchema = Type.Object(
  {
    state: feedbackReviewStateSchema,
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  },
  { additionalProperties: false },
);
