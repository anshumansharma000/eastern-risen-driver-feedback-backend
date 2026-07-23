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
  status: lifecycleStatusSchema,
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
  archivedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const createVehicleBodySchema = Type.Object(
  {
    registrationNumber: Type.String({ minLength: 1, maxLength: 64 }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const updateVehicleBodySchema = Type.Object(
  {
    registrationNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const vehicleStatusBodySchema = Type.Object(
  { status: lifecycleStatusSchema },
  { additionalProperties: false },
);
