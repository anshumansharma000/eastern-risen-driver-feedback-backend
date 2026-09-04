import { Type } from 'typebox';
import { driverSourceSchema } from '../drivers/driver.schemas.js';
import {
  feedbackPurposesSchema,
  questionnairePurposeSchema,
  tripSchema,
} from '../trips/trip.schemas.js';

export const engagementStatusSchema = Type.Union([
  Type.Literal('READY'),
  Type.Literal('FEEDBACK_STARTED'),
  Type.Literal('SUBMITTED'),
  Type.Literal('ARCHIVED'),
]);

export const engagementListQuerySchema = Type.Object({
  bookingId: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(engagementStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

export const driverEngagementListQuerySchema = Type.Object({
  status: Type.Optional(engagementStatusSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

export const updateEngagementFeedbackSectionsBodySchema = Type.Object(
  {
    feedbackPurposes: Type.Array(questionnairePurposeSchema, {
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

export const engagementSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  booking: Type.Object({
    id: Type.String({ format: 'uuid' }),
    bookingReference: Type.String(),
    passengerName: Type.String(),
  }),
  sequenceNumber: Type.Integer({ minimum: 1 }),
  driver: Type.Object({
    id: Type.String({ format: 'uuid' }),
    displayName: Type.String(),
    driverCode: Type.String(),
    sourceType: driverSourceSchema,
    vendorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    vendorName: Type.Union([Type.String(), Type.Null()]),
  }),
  feedbackPurposes: feedbackPurposesSchema,
  status: engagementStatusSchema,
  startedFeedbackAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  trips: Type.Array(tripSchema, { minItems: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const engagementResponseSchema = Type.Object({ data: engagementSchema });
export const engagementListResponseSchema = Type.Object({
  data: Type.Array(engagementSchema),
  pagination: Type.Object({
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  }),
});
