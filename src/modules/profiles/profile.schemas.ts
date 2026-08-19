import { Type } from 'typebox';
import { e164PhoneSchema } from '../../shared/http/phone.schemas.js';
import { driverSourceSchema } from '../drivers/driver.schemas.js';
import { lifecycleStatusSchema } from '../vendors/vendor.schemas.js';

const accountProfileFields = {
  accountId: Type.String({ format: 'uuid' }),
  displayName: Type.String(),
  email: Type.String({ format: 'email' }),
  status: lifecycleStatusSchema,
  passwordChangedAt: Type.String({ format: 'date-time' }),
  lastLoginAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
};

export const adminProfileSchema = Type.Object({
  ...accountProfileFields,
  role: Type.Literal('ADMIN'),
});

export const driverProfileSchema = Type.Object({
  ...accountProfileFields,
  role: Type.Literal('DRIVER'),
  driverId: Type.String({ format: 'uuid' }),
  driverCode: Type.String(),
  phone: Type.Union([Type.String(), Type.Null()]),
  sourceType: driverSourceSchema,
  vendorId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  vendorName: Type.Union([Type.String(), Type.Null()]),
  assignmentEnabled: Type.Boolean(),
  shiftStartTime: Type.Union([Type.String(), Type.Null()]),
  shiftEndTime: Type.Union([Type.String(), Type.Null()]),
  timeZone: Type.String(),
  maxDailyDutyMinutes: Type.Integer(),
});

export const updateAdminProfileBodySchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const updateDriverProfileBodySchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    email: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
    phone: Type.Optional(Type.Union([e164PhoneSchema, Type.Null()])),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const changePasswordBodySchema = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 128 }),
    newPassword: Type.String({ minLength: 12, maxLength: 128 }),
  },
  { additionalProperties: false },
);
