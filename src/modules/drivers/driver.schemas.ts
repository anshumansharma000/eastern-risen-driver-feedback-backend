import { Type } from 'typebox';
import { lifecycleStatusSchema } from '../vendors/vendor.schemas.js';

export const driverSourceSchema = Type.Union([Type.Literal('AGENCY'), Type.Literal('OUTSOURCED')]);
const shiftTimeSchema = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });

export const driverSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  accountId: Type.String({ format: 'uuid' }),
  displayName: Type.String(),
  email: Type.String({ format: 'email' }),
  driverCode: Type.String(),
  phone: Type.Union([Type.String(), Type.Null()]),
  sourceType: driverSourceSchema,
  vendorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  vendorName: Type.Union([Type.String(), Type.Null()]),
  assignmentEnabled: Type.Boolean(),
  shiftStartTime: Type.Union([shiftTimeSchema, Type.Null()]),
  shiftEndTime: Type.Union([shiftTimeSchema, Type.Null()]),
  timeZone: Type.String(),
  maxDailyDutyMinutes: Type.Integer(),
  status: lifecycleStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const createDriverBodySchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 12, maxLength: 128 }),
    driverCode: Type.String({ minLength: 1, maxLength: 64 }),
    phone: Type.Optional(Type.String({ maxLength: 32 })),
    sourceType: driverSourceSchema,
    vendorId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    assignmentEnabled: Type.Optional(Type.Boolean()),
    shiftStartTime: Type.Optional(Type.Union([shiftTimeSchema, Type.Null()])),
    shiftEndTime: Type.Optional(Type.Union([shiftTimeSchema, Type.Null()])),
    timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    maxDailyDutyMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  },
  { additionalProperties: false },
);

export const updateDriverBodySchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
    driverCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    phone: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
    sourceType: Type.Optional(driverSourceSchema),
    vendorId: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
    assignmentEnabled: Type.Optional(Type.Boolean()),
    shiftStartTime: Type.Optional(Type.Union([shiftTimeSchema, Type.Null()])),
    shiftEndTime: Type.Optional(Type.Union([shiftTimeSchema, Type.Null()])),
    timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    maxDailyDutyMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const adminResetDriverPasswordBodySchema = Type.Object(
  {
    newPassword: Type.String({ minLength: 12, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const driverLeaveSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  driverId: Type.String({ format: 'uuid' }),
  startsAt: Type.String({ format: 'date-time' }),
  endsAt: Type.String({ format: 'date-time' }),
  reason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
});

export const createDriverLeaveBodySchema = Type.Object(
  {
    startsAt: Type.String({ format: 'date-time' }),
    endsAt: Type.String({ format: 'date-time' }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);
