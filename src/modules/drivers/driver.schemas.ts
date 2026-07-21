import { Type } from 'typebox';
import { lifecycleStatusSchema } from '../vendors/vendor.schemas.js';

export const driverSourceSchema = Type.Union([
  Type.Literal('AGENCY'),
  Type.Literal('OUTSOURCED'),
]);

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
  },
  { additionalProperties: false, minProperties: 1 },
);
