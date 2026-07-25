import { Type } from 'typebox';

export const agencySettingsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  agencyName: Type.String(),
  timezone: Type.String(),
  defaultThankYouMessage: Type.String(),
  negativeFeedbackThreshold: Type.Union([Type.Number(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const updateAgencySettingsBodySchema = Type.Object(
  {
    agencyName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    defaultThankYouMessage: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    negativeFeedbackThreshold: Type.Optional(
      Type.Union([Type.Number({ minimum: 1, maximum: 5 }), Type.Null()]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);
