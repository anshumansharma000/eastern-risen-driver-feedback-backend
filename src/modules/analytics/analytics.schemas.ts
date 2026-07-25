import { Type } from 'typebox';
import { driverSourceSchema } from '../drivers/driver.schemas.js';
import { monthSchema } from '../feedback/admin-feedback.schemas.js';
import { questionCategorySchema } from '../questionnaires/questionnaire.schemas.js';

const nullableAverageSchema = Type.Union([Type.Number(), Type.Null()]);

export const analyticsQuerySchema = Type.Object({
  month: Type.Optional(monthSchema),
  driverId: Type.Optional(Type.String({ format: 'uuid' })),
  driverSource: Type.Optional(driverSourceSchema),
  vendorId: Type.Optional(Type.String({ format: 'uuid' })),
  category: Type.Optional(questionCategorySchema),
});

export const driverPerformanceQuerySchema = Type.Object({
  month: Type.Optional(monthSchema),
});

export const scoreSummarySchema = Type.Object({
  averageScore: nullableAverageSchema,
  responseCount: Type.Integer({ minimum: 0 }),
  answerCount: Type.Integer({ minimum: 0 }),
});

export const categoryScoreSchema = Type.Intersect([
  Type.Object({ category: questionCategorySchema }),
  scoreSummarySchema,
]);

export const monthlyScoreSchema = Type.Intersect([
  Type.Object({ month: monthSchema }),
  scoreSummarySchema,
]);

export const driverScoreSchema = Type.Intersect([
  Type.Object({
    driver: Type.Object({
      id: Type.String({ format: 'uuid' }),
      displayName: Type.String(),
      sourceType: driverSourceSchema,
      vendorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
      vendorName: Type.Union([Type.String(), Type.Null()]),
    }),
  }),
  scoreSummarySchema,
]);

export const sourceScoreSchema = Type.Intersect([
  Type.Object({ sourceType: driverSourceSchema }),
  scoreSummarySchema,
]);

export const vendorScoreSchema = Type.Intersect([
  Type.Object({
    vendorId: Type.String({ format: 'uuid' }),
    vendorName: Type.String(),
  }),
  scoreSummarySchema,
]);

export const analyticsMetaSchema = Type.Object({
  timezone: Type.String(),
  dateBasis: Type.Literal('SUBMITTED_AT'),
  month: Type.Union([monthSchema, Type.Null()]),
});

export const driverPerformanceSchema = Type.Object({
  driverId: Type.String({ format: 'uuid' }),
  overall: scoreSummarySchema,
  categories: Type.Array(categoryScoreSchema),
  monthlyTrend: Type.Array(monthlyScoreSchema),
  meta: analyticsMetaSchema,
});

export const adminAnalyticsSchema = Type.Object({
  overall: scoreSummarySchema,
  negativeFeedbackCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  negativeFeedbackThreshold: Type.Union([Type.Number(), Type.Null()]),
  categories: Type.Array(categoryScoreSchema),
  drivers: Type.Array(driverScoreSchema),
  sources: Type.Array(sourceScoreSchema),
  vendors: Type.Array(vendorScoreSchema),
  monthlyTrend: Type.Array(monthlyScoreSchema),
  meta: analyticsMetaSchema,
});
