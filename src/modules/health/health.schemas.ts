import { Type } from 'typebox';

export const healthResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('unavailable')]),
  service: Type.Literal('driver-feedback-api'),
  timestamp: Type.String({ format: 'date-time' }),
});
