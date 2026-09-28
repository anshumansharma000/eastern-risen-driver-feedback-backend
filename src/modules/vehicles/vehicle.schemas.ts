import { Type } from 'typebox';
import {
  idParamsSchema,
  lifecycleStatusSchema,
  listQuerySchema,
} from '../vendors/vendor.schemas.js';

export { idParamsSchema, listQuerySchema };

export const vehicleSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  registrationNumber: Type.String(),
  displayName: Type.String(),
  vehicleType: Type.String(),
  registeredOwner: Type.Union([Type.String(), Type.Null()]),
  address: Type.Union([Type.String(), Type.Null()]),
  contactNumber: Type.Union([Type.String(), Type.Null()]),
  accountNumber: Type.Union([Type.String(), Type.Null()]),
  ifscCode: Type.Union([Type.String(), Type.Null()]),
  bankName: Type.Union([Type.String(), Type.Null()]),
  status: lifecycleStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const createVehicleBodySchema = Type.Object(
  {
    registrationNumber: Type.String({ minLength: 1, maxLength: 64 }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    vehicleType: Type.String({ minLength: 1, maxLength: 100 }),
    registeredOwner: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    ),
    address: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
    ),
    contactNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    ),
    accountNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    ifscCode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    ),
    bankName: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

export const updateVehicleBodySchema = Type.Object(
  {
    registrationNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    vehicleType: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    registeredOwner: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    ),
    address: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 2000 }), Type.Null()]),
    ),
    contactNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    ),
    accountNumber: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
    ),
    ifscCode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]),
    ),
    bankName: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const vehicleStatusBodySchema = Type.Object(
  { status: lifecycleStatusSchema },
  { additionalProperties: false },
);
